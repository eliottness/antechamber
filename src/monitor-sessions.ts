/**
 * OmO terminal monitors as read-only child sessions. OpenChamber has no surface for
 * background watches, but it already lists child sessions under Subagents and gives each
 * a live dot, so a watch is busy while OmO reports it and idle once it ends.
 */
import { getAgentName } from "./agent-name.js";
import { ocIdFor } from "./session-store.js";
import type { ManagedSession } from "./sessions.js";
import type { OCEvent, OCMessageWithParts, OCToolPart } from "./types.js";

/** Names OmO's terminal extension passes to `pi.rpc.emit` (core/extensions/builtin/monitor-state-event.js). */
export const MONITOR_STATE_EVENT = "terminal_monitor_state";
export const MONITOR_ENDED_EVENT = "terminal_monitor_ended";
/** customType of the custom message OmO sends with a watch's matched lines (raw RPC capture of installed omo-ai 5.1.33, 2026-10-17). */
export const MONITOR_NOTIFICATION = "senpi-monitor:notification";
/** Matched lines kept per watch; older lines are dropped. */
const MAX_EVENT_LINES = 200;

export interface MonitorSnapshot {
  id: string;
  description: string;
  command: string | null;
  filter: string | null;
  paused: boolean;
  persistent: boolean;
  startedAtMs: number;
  deadlineMs: number | null;
  fireCount: number;
  lastFiredAtMs: number | null;
}

interface MonitorEnding {
  reason: string;
  exitCode: number | null;
  endedAtMs: number;
}

interface Watch {
  session: ManagedSession;
  monitor: MonitorSnapshot;
  ending?: MonitorEnding;
  lines: string[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

export function parseMonitor(value: unknown): MonitorSnapshot | undefined {
  if (!record(value) || typeof value.id !== "string" || value.id === "") return undefined;
  const startedAtMs = finite(value.startedAtMs);
  if (startedAtMs === null) return undefined;
  return {
    id: value.id,
    description: text(value.description) ?? value.id,
    command: text(value.command),
    filter: text(value.filter),
    paused: value.paused === true,
    persistent: value.persistent === true,
    startedAtMs,
    deadlineMs: finite(value.deadlineMs),
    fireCount: finite(value.fireCount) ?? 0,
    lastFiredAtMs: finite(value.lastFiredAtMs),
  };
}

function endingLabel(ending: MonitorEnding): string {
  switch (ending.reason) {
    case "exit":
      return ending.exitCode === null ? "command exited" : `command exited with code ${ending.exitCode}`;
    case "timeout":
      return "deadline reached";
    case "killed":
      return "stopped";
    case "disposed":
      return "suspended by an OmO shutdown or reload";
    case "agent-exit":
      return "OmO process exited";
    default:
      return "ended";
  }
}

function iso(ms: number | null): string | undefined {
  return ms === null ? undefined : new Date(ms).toISOString();
}

export function monitorSummary(monitor: MonitorSnapshot, ending?: MonitorEnding): string {
  const deadline = monitor.persistent ? "none (persistent)" : iso(monitor.deadlineMs);
  return [
    `Status: ${ending ? endingLabel(ending) : monitor.paused ? "paused" : "watching"}`,
    monitor.filter !== null ? `Filter: ${monitor.filter}` : undefined,
    `Events: ${monitor.fireCount}`,
    monitor.lastFiredAtMs !== null ? `Last event: ${iso(monitor.lastFiredAtMs)}` : undefined,
    `Started: ${iso(monitor.startedAtMs)}`,
    ending ? `Ended: ${iso(ending.endedAtMs)}` : deadline !== undefined ? `Deadline: ${deadline}` : undefined,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

export class MonitorSessions {
  private readonly watches = new Map<string, Watch>();
  /** Children the user deleted; a later snapshot of the same watch must not resurrect them. */
  private readonly dismissed = new Set<string>();

  constructor(
    private readonly sessions: Map<string, ManagedSession>,
    private readonly emit: (directory: string, event: OCEvent) => void,
  ) {}

  wire(parent: ManagedSession): void {
    parent.hasBackgroundWork = () => this.running(parent.info.id);
  }

  owns(id: string): boolean {
    return this.watches.has(id);
  }

  messages(id: string): OCMessageWithParts[] {
    return this.watches.get(id)?.session.messages ?? [];
  }

  observe(parent: ManagedSession, ev: Record<string, unknown>): void {
    if (!record(ev.data)) return;
    if (ev.name === MONITOR_STATE_EVENT && Array.isArray(ev.data.monitors)) this.applyState(parent, ev.data.monitors);
    else if (ev.name === MONITOR_ENDED_EVENT) this.applyEnded(parent, ev.data);
  }

  /** A hidden `senpi-monitor:notification` custom message: append its lines to each watch it names. */
  notify(parent: ManagedSession, message: Record<string, unknown>): void {
    if (typeof message.content !== "string" || !record(message.details) || !Array.isArray(message.details.monitors))
      return;
    const lines = message.content
      .replaceAll(/<\/?system-reminder>/g, "")
      .replace(/^Monitor event\([^\n]*?\):\s?/, "")
      .split("\n")
      .filter((line) => line.trim() !== "");
    if (lines.length === 0) return;
    for (const entry of message.details.monitors) {
      if (!record(entry) || typeof entry.id !== "string") continue;
      const watch = this.watches.get(this.childID(parent, entry.id));
      if (!watch) continue;
      watch.lines = [...watch.lines, ...lines].slice(-MAX_EVENT_LINES);
      this.publish(watch);
    }
  }

  /** The agent process is gone: OmO's in-process watches died with it. */
  stopParent(parentID: string): void {
    for (const watch of this.watches.values()) {
      if (watch.session.info.parentID !== parentID || watch.ending !== undefined) continue;
      this.end(watch, { reason: "agent-exit", exitCode: null, endedAtMs: Date.now() });
    }
  }

  /** Forget a deleted child, or every child of a deleted parent. */
  remove(id: string): void {
    for (const [childID, watch] of this.watches) {
      if (childID !== id && watch.session.info.parentID !== id) continue;
      this.watches.delete(childID);
      this.dismissed.add(childID);
      if (this.sessions.get(childID) !== watch.session) continue;
      this.sessions.delete(childID);
      this.emit(watch.session.info.directory, { type: "session.deleted", properties: { info: watch.session.info } });
    }
  }

  private running(parentID: string): boolean {
    for (const watch of this.watches.values()) {
      if (watch.session.info.parentID === parentID && watch.ending === undefined) return true;
    }
    return false;
  }

  private childID(parent: ManagedSession, monitorID: string): string {
    return ocIdFor(`${parent.info.id}/monitor/${monitorID}`);
  }

  private applyState(parent: ManagedSession, entries: unknown[]): void {
    const live = new Set<string>();
    for (const entry of entries) {
      const monitor = parseMonitor(entry);
      if (!monitor) continue;
      const id = this.childID(parent, monitor.id);
      live.add(id);
      if (this.dismissed.has(id)) continue;
      const watch = this.watches.get(id);
      if (watch === undefined) this.create(parent, id, monitor);
      else {
        watch.monitor = monitor;
        delete watch.ending;
        this.publish(watch);
      }
    }
    // A snapshot lists every live watch; one that is missing has ended. Its reason may follow.
    for (const [id, watch] of this.watches) {
      if (watch.session.info.parentID !== parent.info.id || watch.ending !== undefined || live.has(id)) continue;
      this.end(watch, { reason: "ended", exitCode: null, endedAtMs: Date.now() });
    }
  }

  private applyEnded(parent: ManagedSession, data: Record<string, unknown>): void {
    if (typeof data.id !== "string") return;
    const watch = this.watches.get(this.childID(parent, data.id));
    if (!watch) return;
    const fireCount = finite(data.fireCount);
    if (fireCount !== null) watch.monitor.fireCount = fireCount;
    this.end(watch, {
      reason: typeof data.reason === "string" ? data.reason : "ended",
      exitCode: finite(data.exitCode),
      endedAtMs: finite(data.endedAtMs) ?? Date.now(),
    });
  }

  private end(watch: Watch, ending: MonitorEnding): void {
    watch.ending = ending;
    this.publish(watch);
  }

  private create(parent: ManagedSession, id: string, monitor: MonitorSnapshot): void {
    const now = Date.now();
    const session: ManagedSession = {
      info: {
        id,
        parentID: parent.info.id,
        projectID: parent.info.projectID,
        directory: parent.info.directory,
        title: `Monitor: ${monitor.description}`,
        version: parent.info.version,
        time: { created: monitor.startedAtMs, updated: now },
      },
      pi: undefined,
      messages: [],
      model: parent.model,
      streaming: undefined,
      status: { type: "idle" },
      toolByCallId: new Map(),
      tree: { messageEntries: {} },
      hasPendingInteraction: () => false,
      hasRunningChildren: () => false,
    };
    const watch: Watch = { session, monitor, lines: [] };
    this.watches.set(id, watch);
    this.sessions.set(id, session);
    this.emit(session.info.directory, { type: "session.created", properties: { info: session.info } });
    this.publish(watch);
  }

  private publish(watch: Watch): void {
    const { session, monitor, ending, lines } = watch;
    const directory = session.info.directory;
    const sessionID = session.info.id;
    const base = sessionID.replace(/^ses_/, "");
    const model = session.model ?? { providerID: "omo", modelID: "monitor" };
    const started = monitor.startedAtMs;
    const command = monitor.command ?? monitor.description;
    const input = { command, description: monitor.description };
    const summary = monitorSummary(monitor, ending);
    const output = lines.length > 0 ? `${summary}\n\n${lines.join("\n")}` : summary;
    const tool: OCToolPart = {
      id: `prt_${base}_tool`,
      sessionID,
      messageID: `msg_${base}_1`,
      type: "tool",
      callID: `call_${base}`,
      tool: "bash",
      state: ending
        ? {
            status: "completed",
            input,
            output,
            title: monitor.description,
            metadata: { monitor, ending },
            time: { start: started, end: ending.endedAtMs },
          }
        : {
            status: "running",
            input,
            title: monitor.description,
            metadata: { monitor, output },
            time: { start: started },
          },
    };
    const messages: OCMessageWithParts[] = [
      {
        info: {
          id: `msg_${base}_0`,
          sessionID,
          role: "user",
          time: { created: started },
          agent: getAgentName(),
          model,
        },
        parts: [
          {
            id: `prt_${base}_request`,
            sessionID,
            messageID: `msg_${base}_0`,
            type: "text",
            text: "The agent started a background monitor",
            synthetic: true,
            time: { start: started, end: started },
          },
        ],
      },
      {
        info: {
          id: `msg_${base}_1`,
          sessionID,
          role: "assistant",
          time: { created: started, ...(ending ? { completed: ending.endedAtMs } : {}) },
          parentID: `msg_${base}_0`,
          modelID: model.modelID,
          providerID: model.providerID,
          mode: getAgentName(),
          path: { cwd: directory, root: directory },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          ...(ending ? { finish: "stop" } : {}),
        },
        parts: [tool],
      },
    ];
    const before = new Map((session.messages ?? []).map((message) => [message.info.id, JSON.stringify(message)]));
    session.messages = messages;
    for (const message of messages) {
      if (before.get(message.info.id) === JSON.stringify(message)) continue;
      this.emit(directory, { type: "message.updated", properties: { info: message.info } });
      for (const part of message.parts) this.emit(directory, { type: "message.part.updated", properties: { part } });
    }
    const status = ending ? "idle" : "busy";
    if (session.status.type === status) return;
    session.status = { type: status };
    session.info.time.updated = Date.now();
    this.emit(directory, { type: "session.updated", properties: { info: session.info } });
    this.emit(directory, { type: "session.status", properties: { sessionID, status: session.status } });
    if (status === "idle") this.emit(directory, { type: "session.idle", properties: { sessionID } });
  }
}
