/**
 * Background work of one session for the OmO Work status section (extensions/omo-work):
 * todo phases, terminal monitors, detached eval cells, background terminal sessions and the
 * goal continuation timer. OpenChamber 2.x has no native surface for any of these.
 *
 * Sources, all from installed omo-ai 5.1.33 / senpi 2026.10.13:
 * - `wake_source_state` extension events: senpi-codemode publishes its detached cells over RPC
 *   (senpi-codemode/src/index.ts `emitWakeSourceState`); the terminal extension publishes
 *   its sources on the in-process bus only (core/extensions/builtin/terminal/extension-state.js).
 * - `eval_cells.list/peek/stop` RPC commands (senpi-codemode/src/extension/eval-cells-rpc.ts).
 * - `goal_continuation_timer_state` / `goal_continuation_scheduled` extension events
 *   (core/extensions/builtin/goal/monitor-continuation.js), and the `goal_continuation_fire_now`
 *   extension request (goal/rpc-wait-surface.js).
 * - the terminal manifest `<session dir>/extensions/terminal/<session id>.json`, written on every
 *   background session start and exit (terminal/terminal-manifest.js), for background sessions.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { errorBody, json } from "./http.js";
import type { MonitorSessions, MonitorView } from "./monitor-sessions.js";
import type { ManagedSession, SessionManager } from "./sessions.js";
import type { TodoPhase } from "./todo-bridge.js";

export const WAKE_SOURCE_STATE_EVENT = "wake_source_state";
export const GOAL_TIMER_STATE_EVENT = "goal_continuation_timer_state";
export const GOAL_SCHEDULED_EVENT = "goal_continuation_scheduled";
export const GOAL_FIRE_NOW_REQUEST = "goal_continuation_fire_now";
export const CODEMODE_WAKE_SOURCE = "senpi-codemode";

/** Ended watches and matched lines kept per watch in a snapshot. */
const MAX_ENDED_MONITORS = 5;
const MAX_MONITOR_LINES = 20;
/** `eval_cells.list` answers are reused this long, so several open sections cost one RPC. */
const EVAL_LIST_TTL_MS = 1000;
const EVAL_RPC_TIMEOUT_MS = 10_000;
const MAX_PEEK_BYTES = 64 * 1024;

export interface WakeSourceItem {
  id: string;
  description: string;
  startedAtMs: number;
}

export interface WakeSource {
  source: string;
  activeCount: number;
  items: WakeSourceItem[];
}

export interface EvalCellView {
  cellId: string;
  language?: string;
  state: string;
  startedAtMs?: number;
  summary?: string;
  queuedBehind?: string[];
}

export interface BackgroundSessionView {
  id: string;
  command: string;
  startedAtMs: number;
  pid?: number;
}

export interface GoalTimerView {
  armed: boolean;
  kind?: string;
  dueAtMs?: number;
  /** Live wake-source counts the goal waits on, by source name (`goal_continuation_scheduled`). */
  wakeSources?: Record<string, number>;
}

export interface WorkStatus {
  version: 1;
  sessionID: string;
  /** The agent process is running; eval cells and stop actions need it. */
  live: boolean;
  generatedAt: number;
  todo: TodoPhase[];
  monitors: MonitorView[];
  evalCells: EvalCellView[];
  /** False when the cell list could not be read (agent not running, or codemode absent). */
  evalCellsListed: boolean;
  background: BackgroundSessionView[];
  goal: GoalTimerView | null;
  /** Other published wake sources, for work this adapter has no dedicated view for. */
  wakeSources: WakeSource[];
}

export class WorkStatusError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 502,
    message: string,
  ) {
    super(message);
    this.name = "WorkStatusError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function parseWakeSource(data: unknown): WakeSource | undefined {
  if (!record(data) || typeof data.source !== "string" || data.source === "") return undefined;
  const activeCount = finite(data.activeCount);
  if (activeCount === undefined) return undefined;
  const rawItems = Array.isArray(data.items) ? data.items : Array.isArray(data.monitors) ? data.monitors : [];
  const items = rawItems.flatMap((item): WakeSourceItem[] => {
    if (!record(item) || typeof item.id !== "string") return [];
    const startedAtMs = finite(item.startedAtMs);
    if (startedAtMs === undefined) return [];
    return [{ id: item.id, description: nonEmpty(item.description) ?? item.id, startedAtMs }];
  });
  return { source: data.source, activeCount, items };
}

export function parseEvalCell(value: unknown): EvalCellView | undefined {
  if (!record(value) || typeof value.cellId !== "string" || typeof value.state !== "string") return undefined;
  const language = nonEmpty(value.language);
  const startedAtMs = finite(value.startedAtMs);
  const summary = nonEmpty(value.summary);
  const queuedBehind = Array.isArray(value.queuedBehind)
    ? value.queuedBehind.filter((id): id is string => typeof id === "string")
    : undefined;
  return {
    cellId: value.cellId,
    state: value.state,
    ...(language !== undefined ? { language } : {}),
    ...(startedAtMs !== undefined ? { startedAtMs } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(queuedBehind !== undefined && queuedBehind.length > 0 ? { queuedBehind } : {}),
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/**
 * Background sessions from the terminal manifest whose process is still alive. OmO writes the
 * file on start and exit, but a crashed agent leaves its last entries behind.
 */
export function readBackgroundSessions(
  sessionFile: string,
  piSessionId: string,
  isAlive: (pid: number) => boolean = alive,
): BackgroundSessionView[] {
  let manifest: unknown;
  try {
    const path = join(dirname(sessionFile), "extensions", "terminal", `${encodeURIComponent(piSessionId)}.json`);
    manifest = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return []; // Missing (no background session yet), or mid-write: the next poll reads it.
  }
  if (!record(manifest) || !Array.isArray(manifest.backgroundSessions)) return [];
  return manifest.backgroundSessions.flatMap((entry): BackgroundSessionView[] => {
    if (!record(entry) || typeof entry.id !== "string") return [];
    const startedAtMs = finite(entry.startedAtMs);
    if (startedAtMs === undefined) return [];
    const pid = record(entry.runtime) ? finite(entry.runtime.pid) : undefined;
    if (pid !== undefined && !isAlive(pid)) return [];
    return [
      {
        id: entry.id,
        command: nonEmpty(entry.command) ?? entry.id,
        startedAtMs,
        ...(pid !== undefined ? { pid } : {}),
      },
    ];
  });
}

interface SessionWork {
  wakeSources: Map<string, WakeSource>;
  goal: GoalTimerView | null;
  evalList?: { at: number; cells: Promise<EvalCellView[] | undefined> };
}

export class WorkStatusBridge {
  private readonly work = new Map<string, SessionWork>();

  constructor(private readonly monitors: MonitorSessions) {}

  private state(sessionID: string): SessionWork {
    let work = this.work.get(sessionID);
    if (work === undefined) {
      work = { wakeSources: new Map(), goal: null };
      this.work.set(sessionID, work);
    }
    return work;
  }

  /**
   * Evicting the agent process kills its detached eval cells and background terminal sessions (a
   * `bash` run_in_background shell is owned by the agent, whose PTY closes when it exits, so its exit
   * never wakes the session). A live wake source keeps it, and so does a manifest entry whose recorded
   * process is alive and that this agent process started: a crashed or evicted agent never records
   * its shells' exits, and such a leftover pid may since belong to an unrelated process. OmO itself
   * counts an entry without `runtime` as not alive (terminal restore, `defaultBackgroundAlive`).
   */
  wire(s: ManagedSession): void {
    s.hasWakeSources = () => {
      if ((this.work.get(s.info.id)?.wakeSources.size ?? 0) > 0) return true;
      const sessionFile = s.piPath;
      const piSessionId = s.piSessionId;
      const spawnedAt = s.pi?.startedAtMs;
      if (sessionFile === undefined || piSessionId === undefined || spawnedAt === undefined) return false;
      return readBackgroundSessions(sessionFile, piSessionId).some(
        (shell) => shell.pid !== undefined && shell.startedAtMs >= spawnedAt,
      );
    };
  }

  observe(s: ManagedSession, ev: Record<string, unknown>): void {
    if (ev.name === WAKE_SOURCE_STATE_EVENT) {
      const source = parseWakeSource(ev.data);
      if (source === undefined) return;
      const work = this.state(s.info.id);
      if (source.activeCount > 0) work.wakeSources.set(source.source, source);
      else work.wakeSources.delete(source.source);
      if (source.source === CODEMODE_WAKE_SOURCE) delete work.evalList;
      return;
    }
    if (!record(ev.data)) return;
    if (ev.name === GOAL_TIMER_STATE_EVENT) {
      const work = this.state(s.info.id);
      const kind = nonEmpty(ev.data.kind);
      const dueAtMs = finite(ev.data.dueAtMs);
      work.goal =
        ev.data.armed === true
          ? {
              armed: true,
              ...(kind !== undefined ? { kind } : {}),
              ...(dueAtMs !== undefined ? { dueAtMs } : {}),
              ...(work.goal?.wakeSources !== undefined ? { wakeSources: work.goal.wakeSources } : {}),
            }
          : null;
    } else if (ev.name === GOAL_SCHEDULED_EVENT && record(ev.data.wakeSources)) {
      const counts = Object.fromEntries(
        Object.entries(ev.data.wakeSources).filter(
          (entry): entry is [string, number] => finite(entry[1]) !== undefined,
        ),
      );
      const work = this.state(s.info.id);
      work.goal = { ...(work.goal ?? { armed: false }), wakeSources: counts };
    }
  }

  /** Detached eval cells codemode reports running or queued. */
  liveCells(sessionID: string): WakeSourceItem[] {
    return this.work.get(sessionID)?.wakeSources.get(CODEMODE_WAKE_SOURCE)?.items ?? [];
  }

  /** The agent process exited: its in-process wake sources and timers died with it. */
  stopParent(sessionID: string): void {
    this.work.delete(sessionID);
  }

  async snapshot(s: ManagedSession): Promise<WorkStatus> {
    const work = this.work.get(s.info.id);
    const live = s.pi !== undefined;
    const cells = live ? await this.listEvalCells(s) : undefined;
    const sessionFile = s.piPath ?? s.restored?.piPath;
    const piSessionId = s.piSessionId ?? s.restored?.piSessionId;
    const codemode = work?.wakeSources.get(CODEMODE_WAKE_SOURCE);
    return {
      version: 1,
      sessionID: s.info.id,
      live,
      generatedAt: Date.now(),
      todo: s.todoBridge?.phases ?? [],
      monitors: this.monitors.list(s.info.id, MAX_ENDED_MONITORS, MAX_MONITOR_LINES),
      // Without the list, the live cells the wake source names are still worth showing.
      evalCells:
        cells ??
        (codemode?.items ?? []).map((item) => ({
          cellId: item.id,
          state: "running",
          startedAtMs: item.startedAtMs,
          summary: item.description,
        })),
      evalCellsListed: cells !== undefined,
      background: sessionFile && piSessionId ? readBackgroundSessions(sessionFile, piSessionId) : [],
      goal: work?.goal ?? null,
      wakeSources: [...(work?.wakeSources.values() ?? [])].filter(
        (source) => source.source !== CODEMODE_WAKE_SOURCE && source.source !== "terminal-monitors",
      ),
    };
  }

  private listEvalCells(s: ManagedSession): Promise<EvalCellView[] | undefined> {
    const work = this.state(s.info.id);
    const now = Date.now();
    if (work.evalList !== undefined && now - work.evalList.at < EVAL_LIST_TTL_MS) return work.evalList.cells;
    const cells = this.evalCommand(s, { type: "eval_cells.list" }).then(
      (data) => (Array.isArray(data) ? data.flatMap((cell) => parseEvalCell(cell) ?? []) : undefined),
      () => undefined, // eval_cells_unavailable (no codemode) or a dead agent: fall back to the wake source.
    );
    work.evalList = { at: now, cells };
    return cells;
  }

  async peekEvalCell(s: ManagedSession, cellId: string, tailBytes: number): Promise<Record<string, unknown>> {
    const bytes = Math.max(0, Math.min(MAX_PEEK_BYTES, Math.trunc(tailBytes)));
    const data = await this.evalCommand(s, { type: "eval_cells.peek", cellId, tailBytes: bytes });
    if (!record(data)) throw new WorkStatusError(502, "OmO answered eval_cells.peek without a cell");
    return data;
  }

  async stopEvalCell(s: ManagedSession, cellId: string): Promise<Record<string, unknown>> {
    const data = await this.evalCommand(s, { type: "eval_cells.stop", cellId });
    const work = this.work.get(s.info.id);
    if (work !== undefined) delete work.evalList;
    if (!record(data)) throw new WorkStatusError(502, "OmO answered eval_cells.stop without a cell");
    return data;
  }

  async fireGoalContinuation(s: ManagedSession): Promise<void> {
    const pi = s.pi;
    if (pi === undefined) throw new WorkStatusError(409, "The agent is not running");
    const reply = await pi.command(
      { type: "extension_request", name: GOAL_FIRE_NOW_REQUEST, data: {} },
      EVAL_RPC_TIMEOUT_MS,
    );
    if (!reply.success) throw new WorkStatusError(409, reply.error ?? "OmO refused to fire the goal continuation");
  }

  private async evalCommand(s: ManagedSession, command: Record<string, unknown> & { type: string }): Promise<unknown> {
    const pi = s.pi;
    if (pi === undefined) throw new WorkStatusError(409, "The agent is not running");
    // A slow cold start must not cost the session: an eval_cells timeout fails only the request.
    const reply = await pi.probe(command, EVAL_RPC_TIMEOUT_MS);
    if (reply.success) return reply.data;
    const code = reply.errorCode;
    if (code === "eval_cell_not_found") throw new WorkStatusError(404, reply.error ?? "Unknown eval cell");
    if (code === "invalid_eval_cell_request")
      throw new WorkStatusError(400, reply.error ?? "Invalid eval cell request");
    throw new WorkStatusError(409, reply.error ?? `OmO refused ${command.type}`);
  }
}

const SESSION_ID = /^ses_[0-9A-Za-z]+$/;
const CELL_ID = /^[\w.:-]{1,128}$/;
const DEFAULT_PEEK_BYTES = 8 * 1024;

/**
 * `/antechamber/work-status/<session>` and its actions. These are antechamber's own routes, not
 * OpenCode's: the OmO Work extension service authenticates with the run-record token.
 */
export async function handleWorkStatus(
  sessions: Pick<SessionManager, "get" | "workStatus">,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
): Promise<void> {
  const [sessionID, kind, target, action] = url.pathname
    .slice("/antechamber/work-status/".length)
    .split("/")
    .map((part) => decodeURIComponent(part));
  if (sessionID === undefined || !SESSION_ID.test(sessionID)) {
    json(res, 400, errorBody("BadRequestError", "Expected /antechamber/work-status/<session id>"));
    return;
  }
  const s = sessions.get(sessionID);
  if (s === undefined) {
    json(res, 404, errorBody("NotFoundError", `Session not found: ${sessionID}`));
    return;
  }
  try {
    if (kind === undefined && method === "GET") {
      json(res, 200, await sessions.workStatus.snapshot(s));
      return;
    }
    if (kind === "eval" && target !== undefined && CELL_ID.test(target)) {
      if (action === undefined && method === "GET") {
        const tail = Number(url.searchParams.get("tailBytes") ?? DEFAULT_PEEK_BYTES);
        json(
          res,
          200,
          await sessions.workStatus.peekEvalCell(s, target, Number.isFinite(tail) ? tail : DEFAULT_PEEK_BYTES),
        );
        return;
      }
      if (action === "stop" && method === "POST") {
        req.resume();
        json(res, 200, await sessions.workStatus.stopEvalCell(s, target));
        return;
      }
    }
    if (kind === "goal" && target === "fire" && action === undefined && method === "POST") {
      req.resume();
      await sessions.workStatus.fireGoalContinuation(s);
      res.writeHead(204).end();
      return;
    }
    json(res, 404, errorBody("NotFoundError", `Unknown work-status route: ${method} ${url.pathname}`));
  } catch (error) {
    if (!(error instanceof WorkStatusError)) throw error;
    json(res, error.status, errorBody(error.name, error.message));
  }
}
