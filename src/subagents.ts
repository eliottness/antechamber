/** OmO task cards and read-only views of their independently persisted sessions. */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { piAgentDir } from "./agent-dir.js";
import { syncSessionCost } from "./pi-event-translation.js";
import { ocIdFor, SessionPersistenceError, SessionStore } from "./session-store.js";
import type { ManagedSession } from "./sessions.js";
import { type EvalAgent, mapTool, resultText, type ToolResult, toolMappers } from "./tool-map.js";
import type { OCEvent, OCMessageWithParts, OCSession, OCToolPart } from "./types.js";
import { ADAPTER_VERSION } from "./version.js";

// macOS watches directories through FSEvents, which goes live asynchronously after
// watch() returns; a task record replaced inside that window raises no event.
const FSEVENTS_STARTUP_RECHECK_MS = 1_000;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function taskId(value: unknown): value is string {
  return typeof value === "string" && /^st_[a-zA-Z0-9_-]+$/.test(value);
}

export function stripTaskSuffix(text: string): string {
  return text.replace(/\s*\[task_id:\s*st_[^\]]*\]/g, "").trimEnd();
}

function active(status: unknown): boolean {
  return ["running", "queued", "pending", "starting", "suspended"].includes(String(status));
}

/**
 * A finished task OmO may still resume on its own: a resident child whose turn settled while its own
 * background work ran is set back to running (omo-task.js `task_self_resumed`, which goes through the
 * same reset as a revive). Leaving residency (`rpc_detached`, `persisted_only`, `disposed`) ends that.
 */
function revivable(details: Record<string, unknown>): boolean {
  return (
    details.residency_state === "resident" && ["completed", "error", "interrupted"].includes(String(details.status))
  );
}

function timestamp(value: unknown): number {
  return typeof value === "string" ? Date.parse(value) : Number.NaN;
}

/**
 * The lifecycle fields of an `omo.task.updated` row. `live_progress` changes on every event and is
 * not task state; a text field OmO cut to its 32 000-character limit (`*_truncated`) must not
 * replace the full value the task record carries.
 */
function snapshotState(row: Record<string, unknown>): Record<string, unknown> {
  const {
    live_progress: _progress,
    final_response_truncated: responseCut,
    error_message_truncated: errorCut,
    description_truncated: _descriptionCut,
    ...data
  } = row;
  if (responseCut === true) delete data.final_response;
  if (errorCut === true) delete data.error_message;
  return data;
}

function terminal(status: unknown): boolean {
  return ["completed", "failed", "error", "cancelled", "canceled", "killed", "lost", "denied", "plan_error"].includes(
    String(status),
  );
}

toolMappers.task = (args, result) => {
  const input = {
    description: args.task_summary ?? args.name ?? args.description,
    prompt: args.prompt,
    subagent_type: args.subagent_type ?? args.category,
  };
  const details = record(result?.details) ? result.details : {};
  return {
    tool: "task",
    input,
    title: typeof input.description === "string" ? input.description : "task",
    ...(taskId(details.task_id)
      ? { metadata: { sessionID: ocIdFor(details.task_id), taskID: details.task_id, task: details } }
      : {}),
    ...(result !== undefined ? { output: stripTaskSuffix(resultText(result.content)) } : {}),
  };
};

/** One stable renderer part per item, with the batch defaults inherited. */
export function taskParts(template: OCToolPart, args: Record<string, unknown>): OCToolPart[] {
  const items = Array.isArray(args.tasks) && args.tasks.length > 0 ? args.tasks : [args];
  return items.map((item, index) => {
    const mapped = mapTool("task", { ...args, ...(record(item) ? item : {}) });
    return {
      ...template,
      id: `prt_task_${template.callID}_${index}`,
      tool: "task",
      state: {
        status: "running",
        input: mapped.input,
        title: mapped.title,
        time: { start: template.state.status === "pending" ? Date.now() : template.state.time.start },
      },
    };
  });
}

/** Keep task status independent of the parent tool returning a background handle. */
export function updateTaskParts(parts: OCToolPart[], result: ToolResult, ended: boolean, now: number): void {
  const details = record(result.details) ? result.details : {};
  const items = Array.isArray(details.items) ? details.items : undefined;
  parts.forEach((part, index) => {
    const previous = part.state.status !== "pending" ? part.state.metadata : undefined;
    const old = record(previous?.task) ? previous.task : {};
    const item = items?.[index];
    const current = items !== undefined ? (record(item) ? item : {}) : index === 0 ? details : {};
    const data = { ...old, ...current };
    const output = stripTaskSuffix(
      typeof data.final_response === "string"
        ? data.final_response
        : parts.length === 1
          ? resultText(result.content)
          : typeof data.output === "string"
            ? data.output
            : "",
    );
    const input = part.state.input;
    const title = typeof input.description === "string" ? input.description : "task";
    const start = part.state.status === "pending" ? now : part.state.time.start;
    const metadata = {
      ...previous,
      task: data,
      ...(taskId(data.task_id)
        ? {
            sessionID: previous?.taskID === data.task_id ? previous.sessionID : ocIdFor(data.task_id),
            taskID: data.task_id,
          }
        : {}),
    };
    // Preserve a final result for the fallback even after the parent JSONL is gone.
    if (ended && output !== "" && !active(data.status)) data.final_response = output;
    if (active(data.status) || (!ended && !terminal(data.status))) {
      part.state = { status: "running", input, title, metadata, time: { start } };
    } else if (result.isError || (terminal(data.status) && data.status !== "completed")) {
      part.state = {
        status: "error",
        input,
        error: output || String(data.status ?? "task failed"),
        metadata,
        time: { start, end: now },
      };
    } else {
      part.state = { status: "completed", input, output, title, metadata, time: { start, end: now } };
    }
  });
}

/** Wake messages carry arrays of completion envelopes, not a flat details object. */
export function taskCompletions(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(taskCompletions);
  if (!record(value)) return [];
  if (taskId(value.task_id)) return [value];
  return taskCompletions(value.details);
}

function optionalFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR", "EACCES"].includes(String(error.code)))
      return undefined;
    throw error;
  }
}

function jsonObject(path: string): Record<string, unknown> | undefined {
  const raw = optionalFile(path);
  if (raw === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return record(value) ? value : undefined;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function directories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(path, entry.name));
  } catch (error) {
    if (error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR", "EACCES"].includes(String(error.code)))
      return [];
    throw error;
  }
}

function taskStores(): Set<string> {
  const agent = piAgentDir();
  const registry = jsonObject(join(agent, "rpc", "task-stores.json"));
  return new Set([
    ...Object.keys(record(registry?.stores) ? registry.stores : {}),
    ...directories(join(agent, "projects")).map((project) => join(project, "senpi-task")),
  ]);
}

function taskFiles(): { id: string; path: string }[] {
  const files: { id: string; path: string }[] = [];
  for (const store of taskStores()) {
    let names: string[];
    try {
      names = readdirSync(join(store, "tasks"));
    } catch (error) {
      if (error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR", "EACCES"].includes(String(error.code)))
        continue;
      throw error;
    }
    for (const name of names) {
      const id = name.endsWith(".json") ? name.slice(0, -5) : "";
      if (taskId(id)) files.push({ id, path: join(store, "tasks", name) });
    }
  }
  return files;
}

function childRecord(id: string, path: string): Record<string, unknown> | undefined {
  const data = jsonObject(path);
  return data?.task_id === id && typeof data.parent_session_id === "string" ? data : undefined;
}

interface TaskRecord {
  id: string;
  path: string;
  data: Record<string, unknown>;
}

interface TaskLookupPass {
  store: SessionStore;
  childIds: string[];
  identities: Map<string, Map<string, string>>;
  childByPi: Map<string, string>;
  piByChild: Map<string, string>;
  records?: { all: TaskRecord[]; byId: Map<string, TaskRecord[]>; byParent: Map<string, TaskRecord[]> };
}

// History parsing calls the exported helpers synchronously, including from nested child discovery.
let taskLookupPass: TaskLookupPass | undefined;

function withTaskLookups<T>(store: SessionStore, action: () => T): T {
  if (taskLookupPass?.store === store) return action();
  const previous = taskLookupPass;
  const pass: TaskLookupPass = {
    store,
    childIds: store.childIds(),
    identities: new Map(),
    childByPi: new Map(),
    piByChild: new Map(),
  };
  try {
    taskLookupPass = pass;
    for (const id of pass.childIds) {
      const entry = store.get(id);
      if (entry?.task) indexChildIdentity(store, id, entry.task, entry.deleted ? undefined : entry.piSessionId);
    }
    return action();
  } finally {
    taskLookupPass = previous;
  }
}

function indexChildIdentity(store: SessionStore, id: string, task: ChildTask, piSessionId?: string): void {
  const pass = taskLookupPass;
  if (pass?.store !== store) return;
  let parents = pass.identities.get(task.id);
  if (parents === undefined) pass.identities.set(task.id, (parents = new Map()));
  if (!parents.has(task.parentPiId)) parents.set(task.parentPiId, id);
  if (piSessionId !== undefined) {
    const previous = pass.piByChild.get(id);
    if (previous !== undefined && previous !== piSessionId && pass.childByPi.get(previous) === id)
      pass.childByPi.delete(previous);
    pass.piByChild.set(id, piSessionId);
    pass.childByPi.set(piSessionId, id);
  }
}

function indexedTaskRecords(): NonNullable<TaskLookupPass["records"]> | undefined {
  const pass = taskLookupPass;
  if (pass === undefined) return undefined;
  if (pass.records !== undefined) return pass.records;
  const all: TaskRecord[] = [];
  const byId = new Map<string, TaskRecord[]>();
  const byParent = new Map<string, TaskRecord[]>();
  for (const { id, path } of taskFiles()) {
    const data = childRecord(id, path);
    if (data === undefined) continue;
    const row = { id, path, data };
    all.push(row);
    const sameId = byId.get(id) ?? [];
    sameId.push(row);
    byId.set(id, sameId);
    const parent = String(data.parent_session_id);
    const sameParent = byParent.get(parent) ?? [];
    sameParent.push(row);
    byParent.set(parent, sameParent);
  }
  return (pass.records = { all, byId, byParent });
}

/** Keep bookmarks for known tasks; a bare native id is only safe while it has one parent. */
export function taskSessionId(
  id: string,
  parentPiId: string,
  store = taskLookupPass?.store ?? new SessionStore(),
): string {
  const pass = taskLookupPass?.store === store ? taskLookupPass : undefined;
  const known = pass?.identities.get(id)?.get(parentPiId);
  if (known !== undefined) return known;
  for (const sessionID of pass === undefined ? store.childIds() : []) {
    const task = store.get(sessionID)?.task;
    if (task?.id === id && task.parentPiId === parentPiId) return sessionID;
  }
  const legacyID = ocIdFor(id);
  const legacy = store.get(legacyID);
  if (legacy !== undefined) {
    if (legacy.deleted && legacy.parentID === (store.idFor(parentPiId) ?? ocIdFor(parentPiId))) return legacyID;
    return ocIdFor(`${parentPiId}:${id}`);
  }
  const qualifiedID = ocIdFor(`${parentPiId}:${id}`);
  if (store.get(qualifiedID)) return qualifiedID;
  const indexed = indexedTaskRecords();
  if (indexed !== undefined) {
    return indexed.byId.get(id)?.some(({ data }) => data.parent_session_id !== parentPiId) ? qualifiedID : legacyID;
  }
  for (const root of taskStores()) {
    const data = childRecord(id, join(root, "tasks", `${id}.json`));
    if (data && data.parent_session_id !== parentPiId) return qualifiedID;
  }
  return legacyID;
}

/** Reverse lookup never resolves an unbound, ambiguous bare id by store enumeration order. */
export function findTaskBySession(
  sessionId: string,
  store = taskLookupPass?.store ?? new SessionStore(),
): { path: string; data: Record<string, unknown> } | undefined {
  let found: { path: string; data: Record<string, unknown> } | undefined;
  const rows: { id: string; path: string; data?: Record<string, unknown> }[] = indexedTaskRecords()?.all ?? taskFiles();
  for (const { id, path, data: cached } of rows) {
    const data = cached ?? childRecord(id, path);
    if (!data || taskSessionId(id, String(data.parent_session_id), store) !== sessionId) continue;
    if (found && found.data.parent_session_id !== data.parent_session_id) return undefined;
    found = { path, data };
  }
  return found;
}

/**
 * Whether a recorded argument names a task record's value. Codemode caps recorded strings at 512 code
 * points and ends a cut one with "…" (call-capture.ts), and a schema agent() call sends its prompt with
 * JSON instructions appended (agent-bridge.ts toTaskParams), so both match as prefixes.
 */
function recordedMatch(recorded: string, stored: unknown): boolean {
  if (typeof stored !== "string") return false;
  if (stored === recorded) return true;
  return recorded.endsWith("…") ? stored.startsWith(recorded.slice(0, -1)) : stored.startsWith(`${recorded}\n\n`);
}

/**
 * The session of a subagent an eval cell started with `agent()`. The recorded call keeps only its
 * arguments, so the task record is found by parent, prompt and label: the oldest one created since
 * the cell started and not yet claimed by an earlier call of the same cell. `null` means the parent
 * was searched and no record matched; `undefined` means it could not be searched.
 */
export function evalAgentSession(
  parentPiId: string | undefined,
  args: Record<string, unknown>,
  claimed: Set<string>,
  after: number,
): EvalAgent | null | undefined {
  if (parentPiId === undefined || typeof args.prompt !== "string") return undefined;
  let best: { id: string; created: number; data: Record<string, unknown> } | undefined;
  const rows: { id: string; path: string; data?: Record<string, unknown> }[] =
    indexedTaskRecords()?.byParent.get(parentPiId) ?? (taskLookupPass ? [] : taskFiles());
  for (const { id, path, data: cached } of rows) {
    if (claimed.has(id)) continue;
    const data = cached ?? childRecord(id, path);
    if (data?.parent_session_id !== parentPiId) continue;
    const spec = record(data.spawn_spec) ? data.spawn_spec : {};
    if (!recordedMatch(args.prompt, spec.prompt)) continue;
    if (typeof args.label === "string" && !recordedMatch(args.label, data.name)) continue;
    const created = typeof data.created_at === "string" ? Date.parse(data.created_at) : Number.NaN;
    // The cell's start is taken when its card opens, a moment after OmO starts it.
    if (!Number.isFinite(created) || created < after - 5_000) continue;
    if (best === undefined || created < best.created) best = { id, created, data };
  }
  if (best === undefined) return null;
  claimed.add(best.id);
  const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);
  // OmO names an unlabelled task after its id, which says nothing.
  const name = text(best.data.name);
  const summary = text(best.data.task_summary);
  const agentType = text(best.data.agent_type);
  return {
    sessionID: taskSessionId(best.id, parentPiId),
    ...(name !== undefined && name !== best.id ? { name } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(agentType !== undefined ? { agentType } : {}),
  };
}

export function findTask(id: string, parentPiId: string): { path: string; data: Record<string, unknown> } | undefined {
  if (!taskId(id)) return undefined;
  const indexed = indexedTaskRecords();
  if (indexed !== undefined) return indexed.byId.get(id)?.find(({ data }) => data.parent_session_id === parentPiId);
  for (const store of taskStores()) {
    const path = join(store, "tasks", `${id}.json`);
    const data = jsonObject(path);
    if (data?.task_id === id && data.parent_session_id === parentPiId) return { path, data };
  }
  return undefined;
}

function transcriptSessionId(raw: string): string | undefined {
  try {
    const header: unknown = JSON.parse(raw.split("\n", 1)[0] ?? "");
    return record(header) && header.type === "session" && typeof header.id === "string" ? header.id : undefined;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function transcriptSessionIdFromFile(path: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    if (error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR", "EACCES"].includes(String(error.code)))
      return undefined;
    throw error;
  }
  try {
    const buffer = Buffer.alloc(4096);
    return transcriptSessionId(buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString("utf8"));
  } finally {
    closeSync(fd);
  }
}

/** Byte offsets and a byte carry retain split UTF-8 characters and torn JSON lines. */
export class JsonlTail {
  private offset = 0;
  private inode = 0;
  private carry: Buffer = Buffer.alloc(0);
  text = "";

  read(path: string): boolean {
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
    try {
      const stat = statSync(path);
      if (stat.ino !== this.inode || stat.size < this.offset) {
        this.inode = stat.ino;
        this.offset = 0;
        this.carry = Buffer.alloc(0);
        this.text = "";
      }
      const buffer = Buffer.alloc(stat.size - this.offset);
      const size = readSync(fd, buffer, 0, buffer.length, this.offset);
      this.offset += size;
      this.carry = Buffer.concat([this.carry, buffer.subarray(0, size)]);
      const end = this.carry.lastIndexOf(10);
      if (end < 0) return false;
      this.text += this.carry.subarray(0, end + 1).toString("utf8");
      this.carry = this.carry.subarray(end + 1);
      return true;
    } finally {
      closeSync(fd);
    }
  }
}

export interface ChildTask {
  id: string;
  parentPiId: string;
  input: Record<string, unknown>;
  details: Record<string, unknown>;
  terminalAt?: number;
}

interface Child {
  session: ManagedSession;
  task: ChildTask;
  parts: Map<string, OCToolPart>;
  tail: JsonlTail;
  livePath: string | undefined;
  recordPath: string | undefined;
  watchers: Map<string, FSWatcher>;
  loaded: boolean;
  live: boolean;
}

interface RefreshState {
  previousMessages: OCMessageWithParts[];
  previousStatus: ManagedSession["status"]["type"];
  running: boolean;
  costChanged: boolean;
  updatedParts: OCToolPart[];
}

type ParseHistory = (session: ManagedSession, raw: string) => OCMessageWithParts[];

export class SubagentBridge {
  private readonly children = new Map<string, Child>();
  private readonly calls = new Map<string, OCToolPart[]>();
  private readonly removed = new Set<string>();

  constructor(
    private readonly store: SessionStore,
    private readonly sessions: Map<string, ManagedSession>,
    private readonly emit: (directory: string, event: OCEvent) => void,
    private readonly parse: ParseHistory,
  ) {}

  private archive(child: Child): string {
    const previous = this.store.get(child.session.info.id)?.piPath;
    const directory = join(this.store.stateDir, "children");
    return (
      (previous !== undefined && dirname(previous) === directory ? previous : undefined) ??
      join(
        directory,
        `${child.session.info.id === ocIdFor(child.task.id) ? child.task.id : child.session.info.id}.jsonl`,
      )
    );
  }

  private sessionId(parent: ManagedSession, id: string): string {
    return taskSessionId(id, parent.piSessionId ?? parent.restored?.piSessionId ?? "", this.store);
  }

  wire(parent: ManagedSession): void {
    parent.hasRunningChildren = () =>
      [...this.children.values()].some(
        (child) => child.session.info.parentID === parent.info.id && child.session.status.type === "busy",
      );
  }

  start(parent: ManagedSession, original: OCToolPart, args: Record<string, unknown>): void {
    const owner = parent.messages?.find((message) => message.info.id === original.messageID);
    const parts = taskParts(original, args);
    const index = owner?.parts.indexOf(original) ?? -1;
    if (owner && index >= 0) owner.parts.splice(index, 1, ...parts);
    this.calls.set(`${parent.info.id}|${original.callID}`, parts);
    parent.toolByCallId.delete(original.callID);
    for (const part of parts) this.emitPart(parent, part);
  }

  result(parent: ManagedSession, callID: string, result: ToolResult, ended: boolean): boolean {
    const parts = this.calls.get(`${parent.info.id}|${callID}`);
    if (parts === undefined) return false;
    updateTaskParts(parts, result, ended, Date.now());
    this.discoverParts(parent, parts, true);
    for (const part of parts) this.emitPart(parent, part);
    if (ended) this.calls.delete(`${parent.info.id}|${callID}`);
    return true;
  }

  wake(parent: ManagedSession, event: Record<string, unknown>): void {
    const message = record(event.message) ? event.message : event;
    if (message.customType !== "omo-senpi:wake") return;
    for (const data of taskCompletions(message.details)) {
      const id = this.sessionId(parent, String(data.task_id));
      // A registry-only child (after a restart) or a task with no card (spawned from
      // `eval`) is not loaded yet; restore() covers both.
      if (!this.children.has(id)) this.restore(id);
      const child = this.children.get(id);
      if (child?.session.info.parentID !== parent.info.id) continue;
      child.task.details = { ...child.task.details, ...data };
      if (terminal(data.status)) child.task.terminalAt = Date.now();
      this.refresh(child, true, false);
    }
  }

  /**
   * OmO's task bridge publishes `omo.task.updated` over the RPC extension channel: a replacement
   * snapshot of every task under the parent, sent on attach (after OmO reconciles detached workers)
   * and on each task store change (omo-task.js `W6`). A task missing from it is unknown, not ended:
   * the snapshot is capped at 256 tasks.
   */
  observe(parent: ManagedSession, ev: Record<string, unknown>): void {
    if (ev.name !== "omo.task.updated" || !record(ev.data) || !Array.isArray(ev.data.tasks)) return;
    for (const row of ev.data.tasks) {
      if (!record(row) || !taskId(row.task_id)) continue;
      if (
        typeof row.parent_session_id === "string" &&
        row.parent_session_id !== (parent.piSessionId ?? parent.restored?.piSessionId)
      )
        continue;
      const id = this.sessionId(parent, row.task_id);
      if (!this.children.has(id)) this.restore(id);
      const child = this.children.get(id);
      if (!child || child.session.info.parentID !== parent.info.id) continue;
      const data = snapshotState(row);
      // OmO re-sends every row ~150 ms after each progress event of any task; only changes matter.
      if (Object.entries(data).every(([key, value]) => child.task.details[key] === value)) continue;
      this.wire(parent);
      if (!this.applyNative(child, data)) continue;
      child.live = true;
      this.refresh(child, true, false);
    }
  }

  /**
   * Merge task state reported by OmO (record, snapshot) unless it is older than what is known: an
   * older update, or a running state that predates a terminal one OmO already reported. Terminal
   * states are only ever taken from OmO, so nothing the adapter inferred can block a running task.
   */
  private applyNative(child: Child, data: Record<string, unknown>): boolean {
    const updated = timestamp(data.updated_at);
    const known = timestamp(child.task.details.updated_at);
    if (updated < known) return false;
    if (active(data.status) && terminal(child.task.details.status) && updated <= (child.task.terminalAt ?? 0))
      return false;
    child.task.details = { ...child.task.details, ...data };
    return true;
  }

  discover(parent: ManagedSession, messages: OCMessageWithParts[]): void {
    withTaskLookups(this.store, () =>
      this.discoverParts(
        parent,
        messages.flatMap((message) => message.parts),
        false,
      ),
    );
  }

  private discoverParts(parent: ManagedSession, parts: OCMessageWithParts["parts"], live: boolean): void {
    this.wire(parent);
    for (const part of parts) {
      if (part.type !== "tool" || part.tool !== "task" || part.state.status === "pending") continue;
      const metadata = part.state.metadata;
      if (!metadata || !taskId(metadata.taskID)) continue;
      const id = metadata.taskID;
      const details = record(metadata.task) ? metadata.task : {};
      const sessionID = this.sessionId(parent, id);
      let child = this.children.get(sessionID);
      if (!child && this.deleted(sessionID)) continue;
      if (!child) {
        child = this.create(parent, {
          id,
          parentPiId: parent.piSessionId ?? parent.restored?.piSessionId ?? "",
          input: part.state.input,
          details,
        });
      } else {
        // A repeated history read must not overwrite a newer completion wake.
        if (!terminal(child.task.details.status) || terminal(details.status))
          child.task.details = { ...child.task.details, ...details };
      }
      child.live ||= live;
      metadata.sessionID = child.session.info.id;
      if (terminal(details.status) && part.state.status !== "running") child.task.terminalAt = part.state.time.end;
      child.parts.set(part.id, part);
      this.refresh(child, true);
    }
  }

  private create(
    parent: ManagedSession,
    task: ChildTask,
    id = taskSessionId(task.id, task.parentPiId, this.store),
  ): Child {
    const archived = this.store.get(id)?.archived;
    const session = this.managedSession({
      id,
      parentID: parent.info.id,
      projectID: parent.info.projectID,
      directory: parent.info.directory,
      title: typeof task.input.description === "string" ? task.input.description : task.id,
      version: parent.info.version,
      time: { ...parent.info.time, ...(archived !== undefined ? { archived } : {}) },
    });
    const child: Child = {
      session,
      task,
      parts: new Map(),
      tail: new JsonlTail(),
      watchers: new Map(),
      livePath: undefined,
      recordPath: undefined,
      loaded: false,
      live: false,
    };
    this.children.set(session.info.id, child);
    this.sessions.set(session.info.id, session);
    indexChildIdentity(this.store, session.info.id, task);
    this.wire(session);
    this.emit(session.info.directory, { type: "session.created", properties: { info: session.info } });
    return child;
  }

  restore(id: string): ManagedSession | undefined {
    return withTaskLookups(this.store, () => {
      const known = this.children.get(id);
      if (known) return known.session;
      const entry = this.store.get(id);
      if (!entry) return this.removed.has(id) ? undefined : this.adopt(id);
      if (entry.deleted || !entry.task || !entry.parentID) return undefined;
      const child = this.create(this.detachedParent(entry.parentID, entry.directory, entry), entry.task, id);
      child.session.info.title = entry.title ?? child.session.info.title;
      this.refresh(child, false);
      return child.session;
    });
  }

  /**
   * Tasks spawned outside a `task` tool call (e.g. `agent()` inside an `eval`
   * cell) never produce a card, so their session is built from the task record.
   */
  private adopt(
    id: string,
    found: { path: string; data: Record<string, unknown> } | undefined = findTaskBySession(id, this.store),
  ): ManagedSession | undefined {
    if (!found) return undefined;
    const parentPi = String(found.data.parent_session_id);
    const parent = this.parentFor(parentPi);
    if (!parent) return undefined;
    this.wire(parent);
    const spec = record(found.data.spawn_spec) ? found.data.spawn_spec : {};
    const name = found.data.name ?? found.data.description;
    const child = this.create(
      parent,
      {
        id: String(found.data.task_id),
        parentPiId: parentPi,
        input: {
          ...(typeof name === "string" ? { description: name } : {}),
          ...(typeof spec.prompt === "string" ? { prompt: spec.prompt } : {}),
          ...(typeof found.data.agent_type === "string" ? { subagent_type: found.data.agent_type } : {}),
        },
        details: found.data,
      },
      id,
    );
    this.refresh(child, false);
    return child.session;
  }

  /**
   * Root sessions are keyed by the md5 of their pi session id, but a nested child
   * is keyed by its task id, so its pi session id is matched through the registry.
   */
  private parentFor(parentPi: string, childByPi = this.childIdsByPi()): ManagedSession | undefined {
    const rootID = ocIdFor(parentPi);
    const loaded = [...this.sessions.values()].find(
      (s) => s.info.id === rootID || s.piSessionId === parentPi || s.restored?.piSessionId === parentPi,
    );
    if (loaded) return loaded;
    const id = this.store.get(rootID) ? rootID : childByPi.get(parentPi);
    if (id === undefined) return undefined;
    const entry = this.store.get(id);
    return this.sessions.get(id) ?? (entry ? this.detachedParent(id, entry.directory, entry) : undefined);
  }

  private childIdsByPi(): Map<string, string> {
    if (taskLookupPass?.store === this.store) return taskLookupPass.childByPi;
    const byPi = new Map<string, string>();
    for (const id of this.store.childIds()) {
      const entry = this.store.get(id);
      if (entry?.piSessionId && !entry.deleted) byPi.set(entry.piSessionId, id);
    }
    return byPi;
  }

  private detachedParent(id: string, directory: string, times: { created: number; updated: number }): ManagedSession {
    return this.managedSession({
      id,
      projectID: directory,
      directory,
      title: "",
      version: ADAPTER_VERSION,
      time: { created: times.created, updated: times.updated },
    });
  }

  private managedSession(info: OCSession): ManagedSession {
    return {
      info,
      pi: undefined,
      messages: undefined,
      model: undefined,
      streaming: undefined,
      status: { type: "idle" },
      toolByCallId: new Map(),
      tree: { messageEntries: {} },
      hasPendingInteraction: () => false,
      hasRunningChildren: () => false,
    };
  }

  restoreAll(): void {
    withTaskLookups(this.store, () => {
      for (const id of taskLookupPass?.childIds ?? []) this.restore(id);
      const childByPi = this.childIdsByPi();
      for (const { id, path, data } of indexedTaskRecords()?.all ?? []) {
        const parentPi = String(data.parent_session_id);
        const sessionId = taskSessionId(id, parentPi, this.store);
        if (this.children.has(sessionId) || this.removed.has(sessionId) || this.store.get(sessionId)) continue;
        if (!this.parentFor(parentPi, childByPi)) continue;
        this.adopt(sessionId, { path, data });
      }
    });
  }

  owns(id: string): boolean {
    return this.children.has(id);
  }

  messages(id: string): OCMessageWithParts[] {
    const child = this.children.get(id);
    if (!child) return [];
    if (!child.loaded) this.refresh(child, false);
    return child.session.messages ?? [];
  }

  private watch(child: Child, path: string): void {
    const dir = dirname(path);
    if (child.watchers.has(dir) || !existsSync(dir)) return;
    const watcher = watch(dir, { persistent: false }, (_event, name) => {
      if (
        name === null ||
        name.toString() === basename(child.livePath ?? "") ||
        name.toString() === basename(child.recordPath ?? "")
      )
        this.refresh(child, true);
    });
    watcher.on("error", (error) => {
      console.error(`[subagents] watcher ${dir}: ${error.message}`);
      watcher.close();
      child.watchers.delete(dir);
    });
    child.watchers.set(dir, watcher);
    if (process.platform === "darwin") {
      setTimeout(() => {
        if (child.watchers.get(dir) === watcher) this.refresh(child, true);
      }, FSEVENTS_STARTUP_RECHECK_MS).unref();
    }
  }

  private refresh(child: Child, publish: boolean, useRecord = true): void {
    const archive = this.archive(child);
    const found = this.reconcileTaskRecord(child, useRecord);
    // OmO stops in-process workers with their parent and leaves them `running` but `persisted_only`
    // until the revived parent reconciles them (omo-task.js `DK`/`jK`); they are not running.
    const running =
      active(child.task.details.status) &&
      child.task.details.residency_state !== "persisted_only" &&
      (found !== undefined || child.live);
    const state: RefreshState = {
      previousMessages: child.session.messages ?? [],
      previousStatus: child.session.status.type,
      running,
      costChanged: this.hydrateTranscript(child, archive, running, child.session.status.type),
      updatedParts: this.reconcileRuntime(child, running),
    };
    if (state.costChanged)
      this.emit(child.session.info.directory, { type: "session.updated", properties: { info: child.session.info } });
    if (publish) for (const part of state.updatedParts) this.emitPart(child.session, part);
    this.persist(child);
    this.publishRefresh(child, state, publish);
  }

  private reconcileTaskRecord(
    child: Child,
    useRecord: boolean,
  ): { path: string; data: Record<string, unknown> } | undefined {
    const found = findTask(child.task.id, child.task.parentPiId);
    if (!found) return undefined;
    child.recordPath = found.path;
    if (useRecord) this.applyNative(child, found.data);
    const host = found.data.host_session;
    if (record(host) && typeof host.session_path === "string") {
      child.livePath = host.session_path;
      return found;
    }
    if (typeof found.data.child_session_id !== "string" || found.data.child_session_id === "") return found;
    // In-process agents persist under the task store but have no RPC host_session.
    // Match the recorded session, not another retained run in the same directory.
    const sessions = join(dirname(dirname(found.path)), "children", child.task.id, "sessions", child.task.id);
    try {
      const file = readdirSync(sessions, { withFileTypes: true }).find(
        (entry) => entry.isFile() && entry.name.endsWith(`_${found.data.child_session_id}.jsonl`),
      );
      child.livePath = file ? join(sessions, file.name) : undefined;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR", "EACCES"].includes(String(error.code))))
        throw error;
      child.livePath = undefined;
    }
    return found;
  }

  private hydrateTranscript(child: Child, archive: string, running: boolean, previousStatus: string): boolean {
    // A resumed live task can be newer than its archive; completed history prefers the archive.
    const liveRun = running || previousStatus === "busy";
    let raw = liveRun ? undefined : optionalFile(archive);
    const expected =
      (child.livePath === undefined ? undefined : transcriptSessionIdFromFile(child.livePath)) ??
      (typeof child.task.details.child_session_id === "string" && child.task.details.child_session_id !== ""
        ? child.task.details.child_session_id
        : undefined);
    const legacyArchive = join(this.store.stateDir, "children", `${child.task.id}.jsonl`);
    if (!liveRun && raw === undefined && expected !== undefined) {
      for (const path of [join(this.store.stateDir, "children", `native-${ocIdFor(expected)}.jsonl`), legacyArchive]) {
        const retained = optionalFile(path);
        if (retained !== undefined && transcriptSessionId(retained) === expected) {
          raw = retained;
          break;
        }
      }
    }
    const foreign = raw !== undefined && expected !== undefined && transcriptSessionId(raw) !== expected;
    if (foreign && raw !== undefined) {
      const displaced = transcriptSessionId(raw);
      if (displaced !== undefined) {
        const retained = join(this.store.stateDir, "children", `native-${ocIdFor(displaced)}.jsonl`);
        // This may be the other child's only history; retain it before repairing the shared path.
        if (!existsSync(retained)) this.saveArchive(retained, raw);
      }
      raw = undefined;
    }
    if (running && child.recordPath) this.watch(child, child.recordPath);
    if (raw === undefined && child.livePath !== undefined) {
      if (running) this.watch(child, child.livePath);
      child.tail.read(child.livePath);
      if (child.tail.text !== "" && (expected === undefined || transcriptSessionId(child.tail.text) === expected))
        raw = child.tail.text;
    }
    if (raw !== undefined) {
      const piSessionId = transcriptSessionId(raw);
      if (piSessionId !== undefined) child.session.piSessionId = piSessionId;
      child.session.messages = this.parse(child.session, raw);
      this.discover(child.session, child.session.messages);
      if (!running && terminal(child.task.details.status) && (liveRun || foreign || !existsSync(archive)))
        this.saveArchive(archive, raw);
    } else {
      if (expected !== undefined) child.session.piSessionId = expected;
      child.session.messages = this.fallback(child);
    }
    child.loaded = true;
    // Each child reports only its own spend; OpenChamber sums the subtree by parentID.
    return syncSessionCost(child.session);
  }

  private reconcileRuntime(child: Child, running: boolean): OCToolPart[] {
    child.session.status = { type: running ? "busy" : "idle" };
    if (!running) {
      const keep = revivable(child.task.details) ? child.recordPath : undefined;
      this.closeWatchers(child, keep);
      if (keep !== undefined) this.watch(child, keep);
    }
    const parts = [...child.parts.values()];
    for (const part of parts) {
      updateTaskParts(
        [part],
        {
          details: child.task.details,
          content: [{ type: "text", text: child.task.details.final_response ?? "" }],
        },
        !running,
        Date.now(),
      );
    }
    return parts;
  }

  private publishRefresh(child: Child, state: RefreshState, publish: boolean): void {
    if (publish) {
      const before = new Map(state.previousMessages.map((message) => [message.info.id, JSON.stringify(message)]));
      for (const message of child.session.messages ?? []) {
        if (before.get(message.info.id) === JSON.stringify(message)) continue;
        this.emit(child.session.info.directory, { type: "message.updated", properties: { info: message.info } });
        for (const part of message.parts) this.emitPart(child.session, part);
      }
    }
    if (state.previousStatus !== child.session.status.type) {
      this.emit(child.session.info.directory, {
        type: "session.status",
        properties: { sessionID: child.session.info.id, status: child.session.status },
      });
      if (!state.running)
        this.emit(child.session.info.directory, {
          type: "session.idle",
          properties: { sessionID: child.session.info.id },
        });
    }
  }

  private saveArchive(path: string, raw: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, raw);
    renameSync(temporary, path);
  }

  private fallback(child: Child): OCMessageWithParts[] {
    const data = child.task.details;
    const stats = record(data.run_stats) ? data.run_stats : {};
    const resolved = record(data.resolved_model) ? data.resolved_model : {};
    const model =
      typeof data.model === "string"
        ? data.model
        : `${resolved.provider ?? "unknown"}/${resolved.model_id ?? "unknown"}`;
    const finalResponse = stripTaskSuffix(typeof data.final_response === "string" ? data.final_response : "");
    const error =
      terminal(data.status) && data.status !== "completed" && typeof data.error_message === "string"
        ? data.error_message
        : undefined;
    const runtime = stats.runtime_ms ?? data.duration_ms;
    const text = [
      finalResponse,
      error && !finalResponse.includes(error) ? error : "",
      `Model: ${model}\nRuntime: ${runtime === undefined ? "unknown" : `${runtime} ms`}\nTokens: ${stats.total_tokens ?? "unknown"}\nCost: ${stats.cost_usd === undefined ? "unknown" : `$${stats.cost_usd}`}`,
      "Full transcript is unavailable.",
    ]
      .filter(Boolean)
      .join("\n\n");
    // OpenChamber groups assistant output by a user turn. The original task
    // prompt is retained by the parent even when the child transcript is gone.
    const request = JSON.stringify({
      type: "message",
      id: "request",
      timestamp: child.session.info.time.created,
      message: {
        role: "user",
        content: [{ type: "text", text: child.task.input.prompt ?? child.task.input.description ?? child.task.id }],
      },
    });
    const response = JSON.stringify({
      type: "message",
      id: "result",
      parentId: "request",
      timestamp: child.session.info.time.updated,
      message: {
        role: "assistant",
        provider: resolved.provider ?? model.split("/")[0],
        model: resolved.model_id ?? model.split("/").slice(1).join("/"),
        ...(error ? { stopReason: "error", errorMessage: error } : {}),
        // run_stats tokens are totals across the whole run (every model call),
        // not one request's context, so only the cost is carried as usage; the
        // totals stay in the text above. Token counts here read as context fill.
        content: [{ type: "text", text }],
        usage: { cost: { total: stats.cost_usd } },
      },
    });
    return this.parse(child.session, `${request}\n${response}\n`);
  }

  /** Save a rename or archive made through the session routes; false when `id` is not a child. */
  save(id: string): boolean {
    const child = this.children.get(id);
    if (!child) return false;
    this.persist(child);
    return true;
  }

  private persist(child: Child): void {
    const { info } = child.session;
    try {
      this.store.set(info.id, {
        piSessionId: child.session.piSessionId ?? child.task.id,
        piPath: this.archive(child),
        directory: info.directory,
        title: info.title,
        parentID: info.parentID,
        ...(info.time.archived !== undefined ? { archived: info.time.archived } : {}),
        task: child.task,
        created: info.time.created,
        updated: info.time.updated,
      });
      indexChildIdentity(this.store, info.id, child.task, child.session.piSessionId ?? child.task.id);
    } catch (error) {
      if (!(error instanceof SessionPersistenceError)) throw error;
      this.emit(info.directory, {
        type: "session.error",
        properties: { sessionID: info.id, error: { name: error.name, data: { message: error.message } } },
      });
    }
  }

  private emitPart(session: ManagedSession, part: OCToolPart | OCMessageWithParts["parts"][number]): void {
    this.emit(session.info.directory, { type: "message.part.updated", properties: { part } });
  }

  private closeWatchers(child: Child, keep?: string): void {
    const kept = keep === undefined ? undefined : dirname(keep);
    for (const [dir, watcher] of child.watchers) {
      if (dir === kept) continue;
      watcher.close();
      child.watchers.delete(dir);
    }
  }

  /**
   * End the parent's task cards that have no running child. A card whose child runs is left to OmO:
   * an abort cancels only a task the turn was still waiting on, and OmO reports that cancellation
   * like any other end (omo-task.js `UZ`, "parent turn aborted"); background tasks keep running.
   * After an abort the call stays tracked, because its tool result can still arrive.
   */
  finishCalls(parentID: string, cancelled = false): void {
    for (const [key, parts] of this.calls) {
      if (!key.startsWith(`${parentID}|`)) continue;
      const parent = this.sessions.get(parentID);
      let waiting = false;
      for (const part of parts) {
        const childID = part.state.status !== "pending" ? part.state.metadata?.sessionID : undefined;
        if (typeof childID === "string" && this.children.get(childID)?.session.status.type === "busy") {
          waiting = true;
          continue;
        }
        updateTaskParts(
          [part],
          {
            isError: true,
            details: { status: cancelled ? "cancelled" : "failed" },
            content: [{ type: "text", text: cancelled ? "Task cancelled" : "run ended without a tool result" }],
          },
          true,
          Date.now(),
        );
        if (parent) this.emitPart(parent, part);
      }
      if (!cancelled || !waiting) this.calls.delete(key);
    }
  }

  /**
   * Stop showing a deleted parent's children as live. Their status is not touched: OmO tasks outlive
   * their parent's turn and process (shared-host workers detach, omo-task.js `DK`/`jK`), so only OmO
   * can say a task ended.
   */
  stopParent(parentID: string): void {
    this.finishCalls(parentID, true);
    for (const child of this.children.values()) {
      if (child.session.info.parentID !== parentID) continue;
      this.stopParent(child.session.info.id);
      this.closeWatchers(child);
    }
  }

  /** Forget a deleted child and leave a registry tombstone; false when `id` is not a child. */
  remove(id: string): boolean {
    const child = this.children.get(id);
    if (!child) return false;
    this.closeWatchers(child);
    child.parts.clear();
    this.children.delete(id);
    this.removed.add(id);
    const { info } = child.session;
    this.store.set(id, {
      deleted: true,
      piSessionId: child.session.piSessionId ?? child.task.id,
      piPath: this.archive(child),
      directory: info.directory,
      ...(info.parentID !== undefined ? { parentID: info.parentID } : {}),
      task: child.task,
      created: info.time.created,
      updated: info.time.updated,
    });
    return true;
  }

  private deleted(id: string): boolean {
    return this.removed.has(id) || this.store.get(id)?.deleted === true;
  }

  dispose(): void {
    for (const child of this.children.values()) {
      this.closeWatchers(child);
      child.parts.clear();
    }
  }
}
