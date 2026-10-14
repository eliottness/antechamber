/**
 * Pure model: OmO task records + the connector's session registry -> one graph
 * for the OpenChamber session the user is looking at.
 *
 * Only facts recorded on disk become topology:
 *   - `spawn` edges come from `parent_session_id` (who launched the task);
 *   - `uses` edges come from a task prompt naming another task of the same run
 *     (`st_…` or `agent://st_…`), which is how OmO workflows hand an upstream
 *     result to a dependent.
 * Waves are a layout grouping, not edges: a sibling joins a later wave when it
 * was created after an earlier sibling had already finished.
 */
import { createHash } from "node:crypto";

export type NodeState = "running" | "queued" | "completed" | "failed" | "cancelled" | "idle";

export interface TaskRecord {
  task_id: string;
  status?: string;
  parent_session_id?: string;
  root_session_id?: string;
  depth?: number;
  execution_mode?: string;
  name?: string;
  task_summary?: string;
  description?: string;
  agent_type?: string;
  category?: string;
  model?: string;
  created_at?: string;
  started_at?: string;
  terminal_at?: string;
  child_session_id?: string;
  host_session?: { session_path?: string };
  spawn_spec?: { prompt?: string; instructions?: string };
  final_response?: string;
  error_message?: string;
  run_stats?: { total_tokens?: number; cost_usd?: number; tool_calls?: number; turns?: number };
}

export interface RegistryEntry {
  piSessionId?: string;
  parentID?: string;
  title?: string;
  task?: { id?: string; parentPiId?: string };
}
export type Registry = Record<string, RegistryEntry>;

export interface GraphNode {
  id: string;
  kind: "root" | "task";
  sessionId: string;
  title: string;
  state: NodeState;
  rawStatus: string;
  agent?: string;
  model?: string;
  createdAt?: number;
  startedAt?: number;
  endedAt?: number;
  summary?: string;
  error?: string;
  tokens?: number;
  costUsd?: number;
  toolCalls?: number;
  parentId?: string;
  column: number;
  wave: number;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: "spawn" | "uses";
}

export interface GraphColumn {
  column: number;
  total: number;
  done: number;
  running: number;
}

export interface TaskGraph {
  status: "ok" | "unknown-session";
  rootId: string;
  focusId: string;
  title: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  columns: GraphColumn[];
  models: number;
}

const TEXT_FIELDS = [
  "status",
  "parent_session_id",
  "root_session_id",
  "execution_mode",
  "name",
  "task_summary",
  "description",
  "agent_type",
  "category",
  "model",
  "created_at",
  "started_at",
  "terminal_at",
  "child_session_id",
  "final_response",
  "error_message",
] as const;

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export function normalizeTask(raw: unknown): TaskRecord | undefined {
  if (!isObject(raw) || typeof raw.task_id !== "string" || raw.task_id === "") return undefined;
  const task: TaskRecord = { task_id: raw.task_id };
  for (const key of TEXT_FIELDS) {
    const value = text(raw[key]);
    if (value !== undefined) task[key] = value;
  }
  if (num(raw.depth) !== undefined) task.depth = num(raw.depth);
  const host = isObject(raw.host_session) ? text(raw.host_session.session_path) : undefined;
  if (host !== undefined) task.host_session = { session_path: host };
  if (isObject(raw.spawn_spec))
    task.spawn_spec = { prompt: text(raw.spawn_spec.prompt), instructions: text(raw.spawn_spec.instructions) };
  if (isObject(raw.run_stats)) {
    const s = raw.run_stats;
    task.run_stats = {
      total_tokens: num(s.total_tokens),
      cost_usd: num(s.cost_usd),
      tool_calls: num(s.tool_calls),
      turns: num(s.turns),
    };
  }
  return task;
}

export function normalizeRegistry(raw: unknown): Registry | undefined {
  if (!isObject(raw)) return undefined;
  const out: Registry = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!isObject(value)) continue;
    const entry: RegistryEntry = {};
    if (text(value.piSessionId) !== undefined) entry.piSessionId = text(value.piSessionId);
    if (text(value.parentID) !== undefined) entry.parentID = text(value.parentID);
    if (text(value.title) !== undefined) entry.title = text(value.title);
    if (isObject(value.task)) entry.task = { id: text(value.task.id), parentPiId: text(value.task.parentPiId) };
    out[id] = entry;
  }
  return out;
}

export function ocIdFor(piSessionId: string): string {
  return `ses_${createHash("md5").update(piSessionId).digest("hex")}`;
}

const ACTIVE = new Set(["running", "starting"]);
const WAITING = new Set(["queued", "pending", "suspended"]);
const FAILED = new Set(["failed", "error", "lost", "denied", "plan_error"]);
const CANCELLED = new Set(["cancelled", "canceled", "killed"]);

export function nodeState(status: string | undefined): NodeState {
  const s = String(status ?? "");
  if (ACTIVE.has(s)) return "running";
  if (WAITING.has(s)) return "queued";
  if (s === "completed") return "completed";
  if (FAILED.has(s)) return "failed";
  if (CANCELLED.has(s)) return "cancelled";
  return "idle";
}

const finished = (state: NodeState) => state === "completed" || state === "failed" || state === "cancelled";

function time(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : undefined;
}

function firstLine(text: string | undefined, max = 280): string | undefined {
  if (!text) return undefined;
  const clean = text
    .replace(/\s*\[task_id:[^\]]*\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (clean === "") return undefined;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Session ids a task's own nested children would carry as `parent_session_id`. */
function ownSessionIds(task: TaskRecord): string[] {
  const ids = [task.task_id];
  if (task.child_session_id) ids.push(task.child_session_id);
  const path = task.host_session?.session_path;
  const match = path ? /_([0-9a-f-]{36})\.jsonl$/i.exec(path) : null;
  if (match?.[1]) ids.push(match[1]);
  return ids;
}

const TASK_REF = /(?:agent:\/\/)?\b(st_[0-9A-Za-z_-]{6,})\b/g;

function referencedTasks(task: TaskRecord): Set<string> {
  const text = `${task.spawn_spec?.prompt ?? ""}\n${task.spawn_spec?.instructions ?? ""}`;
  const refs = new Set<string>();
  for (const m of text.matchAll(TASK_REF)) if (m[1] && m[1] !== task.task_id) refs.add(m[1]);
  return refs;
}

interface Resolved {
  rootPi: string;
  rootOc: string;
  focusOc: string;
}

function resolveSession(sessionId: string, tasks: TaskRecord[], registry: Registry): Resolved | undefined {
  const entry = registry[sessionId];
  const focusTask =
    tasks.find((t) => ocIdFor(t.task_id) === sessionId) ??
    (entry?.task?.id ? tasks.find((t) => t.task_id === entry.task?.id) : undefined);
  let rootPi: string | undefined;
  if (focusTask) rootPi = focusTask.root_session_id ?? focusTask.parent_session_id ?? entry?.task?.parentPiId;
  else if (entry?.task?.parentPiId) rootPi = entry.task.parentPiId;
  else if (entry?.piSessionId) rootPi = entry.piSessionId;
  else {
    const t = tasks.find((t) =>
      [t.root_session_id, t.parent_session_id].some((id) => id !== undefined && ocIdFor(id) === sessionId),
    );
    rootPi = t ? (t.root_session_id ?? t.parent_session_id) : undefined;
  }
  if (rootPi === undefined) return undefined;
  const rootOc =
    Object.entries(registry).find(([, v]) => v.piSessionId === rootPi && v.task === undefined)?.[0] ??
    (focusTask || entry?.task ? (entry?.parentID ?? ocIdFor(rootPi)) : sessionId);
  return { rootPi, rootOc, focusOc: sessionId };
}

export function buildGraph(sessionId: string, tasks: TaskRecord[], registry: Registry): TaskGraph {
  const resolved = resolveSession(sessionId, tasks, registry);
  if (!resolved) {
    return {
      status: "unknown-session",
      rootId: sessionId,
      focusId: sessionId,
      title: registry[sessionId]?.title ?? "Session",
      nodes: [],
      edges: [],
      columns: [],
      models: 0,
    };
  }
  const { rootPi, rootOc, focusOc } = resolved;
  const members = tasks
    .filter((t) => (t.root_session_id ?? t.parent_session_id) === rootPi)
    .sort((a, b) => (time(a.created_at) ?? 0) - (time(b.created_at) ?? 0) || a.task_id.localeCompare(b.task_id));

  const owner = new Map<string, string>();
  for (const t of members) for (const id of ownSessionIds(t)) owner.set(id, t.task_id);
  const parentOf = (t: TaskRecord) =>
    (t.parent_session_id && t.parent_session_id !== rootPi ? owner.get(t.parent_session_id) : undefined) ?? rootOc;

  const byId = new Map(members.map((t) => [t.task_id, t]));
  const edges: GraphEdge[] = [];
  const uses = new Map<string, string[]>();
  for (const t of members) {
    const parent = parentOf(t);
    edges.push({ id: `spawn:${parent}>${t.task_id}`, from: parent, to: t.task_id, kind: "spawn" });
    for (const ref of referencedTasks(t)) {
      const source = byId.get(ref);
      if (!source || ref === parent) continue;
      if ((time(source.created_at) ?? 0) > (time(t.created_at) ?? 0)) continue;
      edges.push({ id: `uses:${ref}>${t.task_id}`, from: ref, to: t.task_id, kind: "uses" });
      uses.set(t.task_id, [...(uses.get(t.task_id) ?? []), ref]);
    }
  }

  // Waves per spawn parent: a sibling waits behind every sibling that ended before it began.
  const wave = new Map<string, number>();
  const column = new Map<string, number>([[rootOc, 0]]);
  const siblingsSoFar = new Map<string, TaskRecord[]>();
  for (const t of members) {
    const parent = parentOf(t);
    const created = time(t.created_at) ?? 0;
    const earlier = siblingsSoFar.get(parent) ?? [];
    let w = 0;
    for (const s of earlier) {
      const ended = time(s.terminal_at);
      if (ended !== undefined && ended <= created) w = Math.max(w, (wave.get(s.task_id) ?? 0) + 1);
    }
    for (const ref of uses.get(t.task_id) ?? []) {
      if (parentOf(byId.get(ref) as TaskRecord) === parent) w = Math.max(w, (wave.get(ref) ?? 0) + 1);
    }
    wave.set(t.task_id, w);
    column.set(t.task_id, (column.get(parent) ?? 0) + 1 + w);
    for (const ref of uses.get(t.task_id) ?? []) {
      column.set(t.task_id, Math.max(column.get(t.task_id) ?? 0, (column.get(ref) ?? 0) + 1));
    }
    siblingsSoFar.set(parent, [...earlier, t]);
  }

  const taskNodes: GraphNode[] = members.map((t) => {
    const state = nodeState(t.status);
    return {
      id: t.task_id,
      kind: "task",
      sessionId: ocIdFor(t.task_id),
      title: firstLine(t.task_summary ?? t.description ?? t.name, 90) ?? t.task_id,
      state,
      rawStatus: String(t.status ?? "unknown"),
      agent: t.agent_type ?? t.category,
      model: t.model,
      createdAt: time(t.created_at),
      startedAt: time(t.started_at) ?? time(t.created_at),
      endedAt: finished(state) ? time(t.terminal_at) : undefined,
      summary: firstLine(t.final_response),
      error: firstLine(t.error_message),
      tokens: t.run_stats?.total_tokens,
      costUsd: t.run_stats?.cost_usd,
      toolCalls: t.run_stats?.tool_calls,
      parentId: parentOf(t),
      column: column.get(t.task_id) ?? 1,
      wave: wave.get(t.task_id) ?? 0,
    };
  });

  const anyActive = taskNodes.some((n) => n.state === "running" || n.state === "queued");
  const root: GraphNode = {
    id: rootOc,
    kind: "root",
    sessionId: rootOc,
    title: firstLine(registry[rootOc]?.title, 90) ?? "Session",
    state: anyActive ? "running" : "idle",
    rawStatus: anyActive ? "orchestrating" : "orchestrator",
    createdAt: taskNodes[0]?.createdAt,
    column: 0,
    wave: 0,
  };
  const nodes = [root, ...taskNodes];

  const columns = new Map<number, GraphColumn>();
  for (const n of taskNodes) {
    const c = columns.get(n.column) ?? { column: n.column, total: 0, done: 0, running: 0 };
    c.total++;
    if (finished(n.state)) c.done++;
    if (n.state === "running") c.running++;
    columns.set(n.column, c);
  }

  const focusId = taskNodes.find((n) => n.sessionId === focusOc)?.id ?? rootOc;
  return {
    status: "ok",
    rootId: rootOc,
    focusId,
    title: root.title,
    nodes,
    edges,
    columns: [...columns.values()].sort((a, b) => a.column - b.column),
    models: new Set(taskNodes.map((n) => n.model).filter(Boolean)).size,
  };
}
