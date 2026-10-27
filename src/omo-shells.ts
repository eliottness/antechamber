/**
 * OmO background work as OpenCode 2.x shells, so OpenChamber 2.x shows it the way it shows OpenCode's
 * own background commands: the session reads as working ("Background command") while its turn is idle,
 * the turn timer holds, the chat lists the commands with their output, and a turn's card follows its
 * command. OpenChamber derives all of it from `GET /api/shell` and the `shell.created` / `shell.exited`
 * events, keyed by `metadata.sessionID` (packages/ui/src/sync/background-shells.ts and
 * global-session-status.ts, OpenChamber 2.5.2).
 *
 * Sources, all already followed for idle eviction and the OmO Work section:
 * - terminal monitors (`terminal_monitor_state`, monitor-sessions.ts);
 * - background terminal sessions (the terminal manifest, work-status.ts `readBackgroundSessions`);
 * - detached eval cells (the codemode wake source, work-status.ts).
 *
 * Monitors and background sessions share OmO's `bash_N` numbering, which restarts with each agent
 * process, so their shell id carries the process start: `sh_t<start base36>_<bash_N>`. Eval cells are
 * keyed by their cell id, which is the eval tool call's id: `sh_e_<cellId>`. OpenCode's schema requires
 * the `sh_` prefix (Shell.ID).
 */
import type { MonitorSessions, MonitorView } from "./monitor-sessions.js";
import type { ManagedSession } from "./sessions.js";
import type { OCEvent, OCShellInfo, OCShellStatus } from "./types.js";
import { readBackgroundSessions, type WorkStatusBridge, WorkStatusError } from "./work-status.js";

/** Metadata key OpenChamber puts on the note it sends before stopping commands (background-shell.ts). */
export const SHELL_CANCELLATION_KEY = "openchamberShellCancellation";
/** Ended shells kept for `GET /api/shell/:id` and their output; OpenCode keeps 25 per directory. */
const MAX_ENDED = 25;
/** Output kept per shell; older bytes are dropped and reported as skipped. */
const MAX_OUTPUT_BYTES = 256 * 1024;
/** codemode's own peek cap (senpi-codemode src/extension/eval-cells-rpc.ts MAX_TAIL_BYTES). */
const EVAL_PEEK_BYTES = 64 * 1024;
/** Leading bytes of a new window searched for in the known output to find where it continues it. */
const PROBE_BYTES = 32;
const MAX_MONITOR_LINES = 200;
const BACKGROUND_NOTICE =
  "OmO does not expose a background terminal session's output to antechamber; the agent reads it with bash_output.\n";

export type OmoShellKind = "monitor" | "background" | "eval";

export function terminalShellId(agentStartedAtMs: number, bashId: string): string {
  return `sh_t${Math.trunc(agentStartedAtMs).toString(36)}_${bashId}`;
}

export function evalShellId(cellId: string): string {
  return `sh_e_${cellId}`;
}

export interface ShellOutputPage {
  output: string;
  cursor: number;
  size: number;
  truncated: boolean;
}

/**
 * Turns successive windows of a growing text (OmO only ever exposes a tail) into the append-only byte
 * stream OpenCode's `cursor` reads. A window continues the known output where the known output's end
 * matches the window's start; a window that shares nothing with it is appended whole.
 */
export class OutputLog {
  private bytes = Buffer.alloc(0);
  /** Absolute offset of `bytes[0]`. */
  private start = 0;

  get size(): number {
    return this.start + this.bytes.length;
  }

  update(window: string): void {
    const next = Buffer.from(window, "utf8");
    const added = next.subarray(this.overlap(next));
    if (added.length === 0) return;
    this.bytes = Buffer.concat([this.bytes, added]);
    const excess = this.bytes.length - MAX_OUTPUT_BYTES;
    if (excess > 0) {
      this.bytes = this.bytes.subarray(excess);
      this.start += excess;
    }
  }

  /** Bytes at the start of `next` that the known output already ends with: the longest such overlap. */
  private overlap(next: Buffer): number {
    const known = this.bytes;
    const from = Math.max(0, known.length - next.length);
    const probe = next.subarray(0, Math.min(PROBE_BYTES, next.length));
    const matches = (at: number) => known.subarray(at).equals(next.subarray(0, known.length - at));
    if (probe.length === 0) return 0;
    for (let at = known.indexOf(probe, from); at !== -1; at = known.indexOf(probe, at + 1)) {
      if (matches(at)) return known.length - at;
    }
    // Overlaps shorter than the probe cannot be found by indexOf.
    for (let at = Math.max(from, known.length - probe.length + 1); at < known.length; at++) {
      if (matches(at)) return known.length - at;
    }
    return 0;
  }

  read(cursor: number, limit: number): ShellOutputPage {
    const size = this.size;
    const from = Math.min(Math.max(cursor, this.start), size);
    const to = Math.min(size, from + limit);
    return {
      output: this.bytes.subarray(from - this.start, to - this.start).toString("utf8"),
      cursor: to,
      size,
      truncated: cursor < this.start,
    };
  }
}

interface Tracked {
  info: OCShellInfo;
  directory: string;
  kind: OmoShellKind;
  /** `bash_N` for terminal work, the cell id for eval. */
  source: string;
  output: OutputLog;
}

interface Desired {
  kind: OmoShellKind;
  source: string;
  command: string;
  startedAtMs: number;
  monitor?: MonitorView;
}

function monitorWindow(view: MonitorView): string {
  const { monitor, lines } = view;
  const header = [
    `$ ${monitor.command ?? monitor.description}`,
    monitor.filter !== null ? `filter: ${monitor.filter}` : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
  return lines.length === 0 ? `${header}\n` : `${header}\n\n${lines.join("\n")}\n`;
}

function endStatus(view: MonitorView | undefined): { status: OCShellStatus; exit?: number } {
  switch (view?.ending?.reason) {
    case "exit":
      return view.ending.exitCode === null ? { status: "exited" } : { status: "exited", exit: view.ending.exitCode };
    case "timeout":
      return { status: "timeout" };
    case "killed":
    case "agent-exit":
      return { status: "killed" };
    default:
      return { status: "exited" };
  }
}

export class OmoShells {
  private readonly live = new Map<string, Tracked>();
  private readonly ended = new Map<string, Tracked>();

  constructor(
    private readonly sessions: Map<string, ManagedSession>,
    private readonly monitors: MonitorSessions,
    private readonly work: WorkStatusBridge,
    private readonly emit: (directory: string, event: OCEvent) => void,
  ) {}

  sync(s: ManagedSession): void {
    const desired = this.desired(s);
    const now = Date.now();
    for (const [id, tracked] of this.live) {
      if (tracked.info.metadata.sessionID !== s.info.id || desired.has(id)) continue;
      const view =
        tracked.kind === "monitor"
          ? this.monitors.list(s.info.id, Number.MAX_SAFE_INTEGER, 0).find((item) => item.monitor.id === tracked.source)
          : undefined;
      this.end(id, tracked, endStatus(view), now);
    }
    for (const [id, want] of desired) {
      const tracked = this.live.get(id);
      if (tracked === undefined) this.start(s, id, want);
      else if (want.monitor !== undefined) tracked.output.update(monitorWindow(want.monitor));
    }
  }

  /** The agent process exited, or the session was removed: everything it ran is gone. */
  stopParent(sessionID: string): void {
    const now = Date.now();
    for (const [id, tracked] of this.live) {
      if (tracked.info.metadata.sessionID === sessionID) this.end(id, tracked, { status: "killed" }, now);
    }
  }

  list(directory: string): OCShellInfo[] {
    for (const s of this.sessions.values()) if (s.info.directory === directory && s.pi !== undefined) this.sync(s);
    return [...this.live.values()]
      .filter((tracked) => tracked.directory === directory)
      .map((tracked) => tracked.info)
      .sort((a, b) => a.time.started - b.time.started || a.id.localeCompare(b.id));
  }

  get(id: string): OCShellInfo | undefined {
    return (this.live.get(id) ?? this.ended.get(id))?.info;
  }

  /** Only eval cells can be stopped: OmO registers no RPC request to stop a monitor or a background session. */
  stoppable(id: string): boolean {
    return this.live.get(id)?.kind === "eval";
  }

  async output(
    id: string,
    cursor: number | undefined,
    limit: number | undefined,
  ): Promise<ShellOutputPage | undefined> {
    const tracked = this.live.get(id) ?? this.ended.get(id);
    if (tracked === undefined) return undefined;
    if (this.live.has(id)) await this.refreshOutput(tracked);
    return tracked.output.read(cursor ?? 0, limit ?? Number.MAX_SAFE_INTEGER);
  }

  /** Stop a running eval cell through codemode; the cell's own completion then ends the shell. */
  async stop(id: string): Promise<void> {
    const tracked = this.live.get(id);
    const s = tracked && this.sessions.get(tracked.info.metadata.sessionID);
    if (tracked === undefined || s === undefined) throw new WorkStatusError(404, `Unknown shell: ${id}`);
    if (tracked.kind !== "eval")
      throw new WorkStatusError(400, "OmO cannot stop a monitor or a background terminal session over RPC");
    await this.work.stopEvalCell(s, tracked.source);
    this.sync(s);
  }

  private desired(s: ManagedSession): Map<string, Desired> {
    const out = new Map<string, Desired>();
    const epoch = s.pi?.startedAtMs;
    if (s.pi === undefined || epoch === undefined) return out;
    for (const view of this.monitors.list(s.info.id, 0, MAX_MONITOR_LINES)) {
      if (view.ending !== undefined) continue;
      const { monitor } = view;
      out.set(terminalShellId(epoch, monitor.id), {
        kind: "monitor",
        source: monitor.id,
        command: monitor.command ?? monitor.description,
        startedAtMs: monitor.startedAtMs,
        monitor: view,
      });
    }
    if (s.piPath !== undefined && s.piSessionId !== undefined) {
      // Same rule as idle eviction (work-status.ts `wire`): a leftover entry of an earlier process is not ours.
      for (const shell of readBackgroundSessions(s.piPath, s.piSessionId)) {
        if (shell.pid === undefined || shell.startedAtMs < epoch) continue;
        out.set(terminalShellId(epoch, shell.id), {
          kind: "background",
          source: shell.id,
          command: shell.command,
          startedAtMs: shell.startedAtMs,
        });
      }
    }
    for (const cell of this.work.liveCells(s.info.id)) {
      out.set(evalShellId(cell.id), {
        kind: "eval",
        source: cell.id,
        command: `eval: ${cell.description}`,
        startedAtMs: cell.startedAtMs,
      });
    }
    return out;
  }

  private start(s: ManagedSession, id: string, want: Desired): void {
    const info: OCShellInfo = {
      id,
      status: "running",
      command: want.command,
      cwd: s.info.directory,
      shell: want.kind === "eval" ? "eval" : "bash",
      file: "",
      metadata: { sessionID: s.info.id, omo: { kind: want.kind, id: want.source } },
      time: { started: want.startedAtMs },
    };
    const tracked: Tracked = {
      info,
      directory: s.info.directory,
      kind: want.kind,
      source: want.source,
      output: new OutputLog(),
    };
    if (want.monitor !== undefined) tracked.output.update(monitorWindow(want.monitor));
    else if (want.kind === "background") tracked.output.update(BACKGROUND_NOTICE);
    this.live.set(id, tracked);
    this.ended.delete(id);
    this.emit(tracked.directory, { type: "shell.created", properties: { info } });
  }

  private end(id: string, tracked: Tracked, end: { status: OCShellStatus; exit?: number }, at: number): void {
    this.live.delete(id);
    tracked.info = {
      ...tracked.info,
      status: end.status,
      ...(end.exit !== undefined ? { exit: end.exit } : {}),
      time: { ...tracked.info.time, completed: at },
    };
    this.ended.set(id, tracked);
    for (const key of this.ended.keys()) {
      if (this.ended.size <= MAX_ENDED) break;
      this.ended.delete(key);
    }
    this.emit(tracked.directory, {
      type: "shell.exited",
      properties: { id, status: end.status, ...(end.exit !== undefined ? { exit: end.exit } : {}) },
    });
  }

  private async refreshOutput(tracked: Tracked): Promise<void> {
    const s = this.sessions.get(tracked.info.metadata.sessionID);
    if (s === undefined) return;
    if (tracked.kind === "monitor") {
      const view = this.monitors
        .list(s.info.id, 0, MAX_MONITOR_LINES)
        .find((item) => item.monitor.id === tracked.source);
      if (view !== undefined) tracked.output.update(monitorWindow(view));
      return;
    }
    if (tracked.kind !== "eval") return;
    try {
      const peek = await this.work.peekEvalCell(s, tracked.source, EVAL_PEEK_BYTES);
      if (typeof peek.outputTail === "string") tracked.output.update(peek.outputTail);
    } catch (error) {
      // A cell that just settled, or a stopped agent: what is already known stays readable.
      if (!(error instanceof WorkStatusError)) throw error;
    }
  }
}
