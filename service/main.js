// extensions/omo-dag/src/service.ts
import http from "node:http";
import { resolve } from "node:path";

// extensions/omo-dag/src/graph.ts
import { createHash } from "node:crypto";
var TEXT_FIELDS = [
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
  "error_message"
];
var isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
var text = (v) => typeof v === "string" ? v : void 0;
var num = (v) => typeof v === "number" && Number.isFinite(v) ? v : void 0;
function normalizeTask(raw) {
  if (!isObject(raw) || typeof raw.task_id !== "string" || raw.task_id === "") return void 0;
  const task = { task_id: raw.task_id };
  for (const key of TEXT_FIELDS) {
    const value = text(raw[key]);
    if (value !== void 0) task[key] = value;
  }
  if (num(raw.depth) !== void 0) task.depth = num(raw.depth);
  const host = isObject(raw.host_session) ? text(raw.host_session.session_path) : void 0;
  if (host !== void 0) task.host_session = { session_path: host };
  if (isObject(raw.spawn_spec))
    task.spawn_spec = { prompt: text(raw.spawn_spec.prompt), instructions: text(raw.spawn_spec.instructions) };
  if (isObject(raw.run_stats)) {
    const s = raw.run_stats;
    task.run_stats = {
      total_tokens: num(s.total_tokens),
      cost_usd: num(s.cost_usd),
      tool_calls: num(s.tool_calls),
      turns: num(s.turns)
    };
  }
  return task;
}
function normalizeRegistry(raw) {
  if (!isObject(raw)) return void 0;
  const out = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!isObject(value)) continue;
    const entry = {};
    if (text(value.piSessionId) !== void 0) entry.piSessionId = text(value.piSessionId);
    if (text(value.parentID) !== void 0) entry.parentID = text(value.parentID);
    if (text(value.title) !== void 0) entry.title = text(value.title);
    if (isObject(value.task)) entry.task = { id: text(value.task.id), parentPiId: text(value.task.parentPiId) };
    out[id] = entry;
  }
  return out;
}
function ocIdFor(piSessionId) {
  return `ses_${createHash("md5").update(piSessionId).digest("hex")}`;
}
var ACTIVE = /* @__PURE__ */ new Set(["running", "starting"]);
var WAITING = /* @__PURE__ */ new Set(["queued", "pending", "suspended"]);
var FAILED = /* @__PURE__ */ new Set(["failed", "error", "lost", "denied", "plan_error"]);
var CANCELLED = /* @__PURE__ */ new Set(["cancelled", "canceled", "killed"]);
function nodeState(status) {
  const s = String(status ?? "");
  if (ACTIVE.has(s)) return "running";
  if (WAITING.has(s)) return "queued";
  if (s === "completed") return "completed";
  if (FAILED.has(s)) return "failed";
  if (CANCELLED.has(s)) return "cancelled";
  return "idle";
}
var finished = (state) => state === "completed" || state === "failed" || state === "cancelled";
function time(value) {
  if (value === void 0) return void 0;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : void 0;
}
function firstLine(text2, max = 280) {
  if (!text2) return void 0;
  const clean = text2.replace(/\s*\[task_id:[^\]]*\]/g, "").replace(/\s+/g, " ").trim();
  if (clean === "") return void 0;
  return clean.length > max ? `${clean.slice(0, max - 1)}\u2026` : clean;
}
function ownSessionIds(task) {
  const ids = [task.task_id];
  if (task.child_session_id) ids.push(task.child_session_id);
  const path = task.host_session?.session_path;
  const match = path ? /_([0-9a-f-]{36})\.jsonl$/i.exec(path) : null;
  if (match?.[1]) ids.push(match[1]);
  return ids;
}
var TASK_REF = /(?:agent:\/\/)?\b(st_[0-9A-Za-z_-]{6,})\b/g;
function referencedTasks(task) {
  const text2 = `${task.spawn_spec?.prompt ?? ""}
${task.spawn_spec?.instructions ?? ""}`;
  const refs = /* @__PURE__ */ new Set();
  for (const m of text2.matchAll(TASK_REF)) if (m[1] && m[1] !== task.task_id) refs.add(m[1]);
  return refs;
}
function resolveSession(sessionId, tasks, registry) {
  const entry = registry[sessionId];
  const focusTask = tasks.find((t) => ocIdFor(t.task_id) === sessionId) ?? (entry?.task?.id ? tasks.find((t) => t.task_id === entry.task?.id) : void 0);
  let rootPi;
  if (focusTask) rootPi = focusTask.root_session_id ?? focusTask.parent_session_id ?? entry?.task?.parentPiId;
  else if (entry?.task?.parentPiId) rootPi = entry.task.parentPiId;
  else if (entry?.piSessionId) rootPi = entry.piSessionId;
  else {
    const t = tasks.find(
      (t2) => [t2.root_session_id, t2.parent_session_id].some((id) => id !== void 0 && ocIdFor(id) === sessionId)
    );
    rootPi = t ? t.root_session_id ?? t.parent_session_id : void 0;
  }
  if (rootPi === void 0) return void 0;
  const rootOc = Object.entries(registry).find(([, v]) => v.piSessionId === rootPi && v.task === void 0)?.[0] ?? (focusTask || entry?.task ? entry?.parentID ?? ocIdFor(rootPi) : sessionId);
  return { rootPi, rootOc, focusOc: sessionId };
}
function buildGraph(sessionId, tasks, registry) {
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
      models: 0
    };
  }
  const { rootPi, rootOc, focusOc } = resolved;
  const members = tasks.filter((t) => (t.root_session_id ?? t.parent_session_id) === rootPi).sort((a, b) => (time(a.created_at) ?? 0) - (time(b.created_at) ?? 0) || a.task_id.localeCompare(b.task_id));
  const owner = /* @__PURE__ */ new Map();
  for (const t of members) for (const id of ownSessionIds(t)) owner.set(id, t.task_id);
  const parentOf = (t) => (t.parent_session_id && t.parent_session_id !== rootPi ? owner.get(t.parent_session_id) : void 0) ?? rootOc;
  const byId = new Map(members.map((t) => [t.task_id, t]));
  const edges = [];
  const uses = /* @__PURE__ */ new Map();
  for (const t of members) {
    const parent = parentOf(t);
    edges.push({ id: `spawn:${parent}>${t.task_id}`, from: parent, to: t.task_id, kind: "spawn" });
    for (const ref of referencedTasks(t)) {
      const source = byId.get(ref);
      if (!source || ref === parent) continue;
      if ((time(source.created_at) ?? 0) > (time(t.created_at) ?? 0)) continue;
      edges.push({ id: `uses:${ref}>${t.task_id}`, from: ref, to: t.task_id, kind: "uses" });
      uses.set(t.task_id, [...uses.get(t.task_id) ?? [], ref]);
    }
  }
  const wave = /* @__PURE__ */ new Map();
  const column = /* @__PURE__ */ new Map([[rootOc, 0]]);
  const siblingsSoFar = /* @__PURE__ */ new Map();
  for (const t of members) {
    const parent = parentOf(t);
    const created = time(t.created_at) ?? 0;
    const earlier = siblingsSoFar.get(parent) ?? [];
    let w = 0;
    for (const s of earlier) {
      const ended = time(s.terminal_at);
      if (ended !== void 0 && ended <= created) w = Math.max(w, (wave.get(s.task_id) ?? 0) + 1);
    }
    for (const ref of uses.get(t.task_id) ?? []) {
      if (parentOf(byId.get(ref)) === parent) w = Math.max(w, (wave.get(ref) ?? 0) + 1);
    }
    wave.set(t.task_id, w);
    column.set(t.task_id, (column.get(parent) ?? 0) + 1 + w);
    for (const ref of uses.get(t.task_id) ?? []) {
      column.set(t.task_id, Math.max(column.get(t.task_id) ?? 0, (column.get(ref) ?? 0) + 1));
    }
    siblingsSoFar.set(parent, [...earlier, t]);
  }
  const taskNodes = members.map((t) => {
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
      endedAt: finished(state) ? time(t.terminal_at) : void 0,
      summary: firstLine(t.final_response),
      error: firstLine(t.error_message),
      tokens: t.run_stats?.total_tokens,
      costUsd: t.run_stats?.cost_usd,
      toolCalls: t.run_stats?.tool_calls,
      parentId: parentOf(t),
      column: column.get(t.task_id) ?? 1,
      wave: wave.get(t.task_id) ?? 0
    };
  });
  const anyActive = taskNodes.some((n) => n.state === "running" || n.state === "queued");
  const root = {
    id: rootOc,
    kind: "root",
    sessionId: rootOc,
    title: firstLine(registry[rootOc]?.title, 90) ?? "Session",
    state: anyActive ? "running" : "idle",
    rawStatus: anyActive ? "orchestrating" : "orchestrator",
    createdAt: taskNodes[0]?.createdAt,
    column: 0,
    wave: 0
  };
  const nodes = [root, ...taskNodes];
  const columns = /* @__PURE__ */ new Map();
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
    models: new Set(taskNodes.map((n) => n.model).filter(Boolean)).size
  };
}

// extensions/omo-dag/src/store.ts
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
function expandHome(path) {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}
function defaultRoots() {
  const home = homedir();
  return {
    agentDirs: [join(home, ".omo", "agent"), join(home, ".pi", "agent")],
    stateDirs: [join(home, ".config", "antechamber"), join(home, ".config", "openchamber-pi-connector")]
  };
}
function isMissing(error) {
  return error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR", "EACCES"].includes(String(error.code));
}
function list(dir) {
  try {
    return readdirSync(dir);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}
function isRegularFile(path) {
  try {
    return lstatSync(path).isFile();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}
var JsonCache = class {
  entries = /* @__PURE__ */ new Map();
  read(path, accept) {
    let stat;
    try {
      stat = statSync(path);
    } catch (error) {
      if (isMissing(error)) {
        this.entries.delete(path);
        return void 0;
      }
      throw error;
    }
    const hit = this.entries.get(path);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.value;
    let value;
    try {
      value = accept(JSON.parse(readFileSync(path, "utf8")));
    } catch (error) {
      if (error instanceof SyntaxError || isMissing(error)) return hit?.value;
      throw error;
    }
    this.entries.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, value });
    return value;
  }
};
var isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
var TaskStore = class {
  constructor(roots) {
    this.roots = roots;
  }
  roots;
  tasks = new JsonCache();
  json = new JsonCache();
  registries = new JsonCache();
  storeDirs() {
    const dirs = /* @__PURE__ */ new Set();
    for (const agent of this.roots.agentDirs) {
      const registry = this.json.read(join(agent, "rpc", "task-stores.json"), (v) => isRecord(v) ? v : void 0);
      if (isRecord(registry?.stores)) for (const dir of Object.keys(registry.stores)) dirs.add(dir);
      for (const project of list(join(agent, "projects"))) dirs.add(join(agent, "projects", project, "senpi-task"));
    }
    return [...dirs];
  }
  loadTasks() {
    const out = /* @__PURE__ */ new Map();
    for (const dir of this.storeDirs()) {
      for (const file of list(join(dir, "tasks"))) {
        if (!file.endsWith(".json")) continue;
        const path = join(dir, "tasks", file);
        if (!isRegularFile(path)) continue;
        const task = this.tasks.read(path, normalizeTask);
        if (task) out.set(task.task_id, task);
      }
    }
    return [...out.values()];
  }
  loadRegistry() {
    const merged = {};
    for (const dir of [...this.roots.stateDirs].reverse()) {
      const reg = this.registries.read(join(dir, "sessions.json"), normalizeRegistry);
      if (reg) Object.assign(merged, reg);
    }
    return merged;
  }
};

// extensions/omo-dag/src/service.ts
var MAX_TASK_STORES = 32;
var MAX_GRAPH_BODY_CHARS = 24e4;
function canonicalRoots(roots) {
  return {
    agentDirs: roots.agentDirs.map((path) => resolve(expandHome(path))),
    stateDirs: roots.stateDirs.map((path) => resolve(expandHome(path)))
  };
}
function graphWithTaskLimit(graph, taskCount) {
  const root = graph.nodes.find((node) => node.kind === "root");
  if (!root) return graph;
  const tasks = graph.nodes.filter((node) => node.kind === "task");
  const shown = [root, ...tasks.slice(0, taskCount)];
  const shownIds = new Set(shown.map((node) => node.id));
  const columns = /* @__PURE__ */ new Map();
  for (const node of shown) {
    if (node.kind === "root") continue;
    const column = columns.get(node.column) ?? { column: node.column, total: 0, done: 0, running: 0 };
    column.total++;
    if (node.state === "completed" || node.state === "failed" || node.state === "cancelled") column.done++;
    if (node.state === "running") column.running++;
    columns.set(node.column, column);
  }
  return {
    ...graph,
    nodes: shown,
    edges: graph.edges.filter((edge) => shownIds.has(edge.from) && shownIds.has(edge.to)),
    columns: [...columns.values()].sort((a, b) => a.column - b.column),
    ...taskCount < tasks.length ? { truncated: { omittedNodes: tasks.length - taskCount } } : {}
  };
}
function boundedGraph(graph) {
  if (JSON.stringify(graph).length <= MAX_GRAPH_BODY_CHARS) return graph;
  const totalTasks = graph.nodes.filter((node) => node.kind === "task").length;
  let low = 0;
  let high = totalTasks;
  while (low < high) {
    const count = Math.ceil((low + high) / 2);
    if (JSON.stringify(graphWithTaskLimit(graph, count)).length <= MAX_GRAPH_BODY_CHARS) low = count;
    else high = count - 1;
  }
  return graphWithTaskLimit(graph, low);
}
function rootsFrom(query, fallback = defaultRoots()) {
  const pick = (key, base) => {
    const value = query.get(key)?.trim();
    return value ? [expandHome(value)] : base;
  };
  return canonicalRoots({
    agentDirs: pick("agentDir", fallback.agentDirs),
    stateDirs: pick("stateDir", fallback.stateDirs)
  });
}
function createServer(token2, makeStore = (r) => new TaskStore(r)) {
  const stores = /* @__PURE__ */ new Map();
  const storeFor = (roots) => {
    const key = JSON.stringify(roots);
    const cached = stores.get(key);
    if (cached) {
      stores.delete(key);
      stores.set(key, cached);
      return cached;
    }
    const store = makeStore(roots);
    stores.set(key, store);
    if (stores.size > MAX_TASK_STORES) {
      const oldest = stores.keys().next().value;
      if (oldest !== void 0) stores.delete(oldest);
    }
    return store;
  };
  const json = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };
  return http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token2}`) return json(res, 401, { error: "unauthorized" });
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/health") return json(res, 200, { ok: true });
    if (url.pathname === "/graph" && req.method === "GET") {
      const session = url.searchParams.get("session");
      if (!session || !/^ses_[0-9A-Za-z]+$/.test(session))
        return json(res, 400, { error: "session query must be an OpenChamber session id" });
      try {
        const store = storeFor(rootsFrom(url.searchParams));
        return json(res, 200, boundedGraph(buildGraph(session, store.loadTasks(), store.loadRegistry())));
      } catch (error) {
        return json(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    return json(res, 404, { error: "not-found" });
  });
}

// extensions/omo-dag/src/service-main.ts
var port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
var token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
if (!port || !token) {
  console.error("OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required");
  process.exit(1);
}
createServer(token).listen(port, "127.0.0.1");
