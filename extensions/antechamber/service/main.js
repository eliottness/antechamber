// extensions/antechamber/src/service-main.ts
import { chmodSync, readFileSync as readFileSync4 } from "node:fs";
import { dirname, join as join5, resolve as resolve4 } from "node:path";
import { fileURLToPath } from "node:url";

// extensions/antechamber/src/runtime/runtime.ts
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
var STALE_LOCK_MS = 15 * 6e4;
var INSTALL_TIMEOUT_MS = 10 * 6e4;
var READY = ".ready.json";
var ERROR_TAIL_CHARS = 2e3;
function defaultEnv() {
  return { env: process.env, home: homedir() };
}
function runtimeRoot({ env: env2, home }) {
  const configured = env2.ANTECHAMBER_RUNTIME_DIR?.trim();
  return configured ? resolve(configured) : join(home, ".antechamber", "runtime");
}
function runtimePaths(version2, runtime) {
  const root = runtimeRoot(runtime);
  const override = runtime.env.ANTECHAMBER_RUNTIME_SPEC?.trim();
  if (!override) return { root, spec: version2, key: version2, dir: join(root, version2) };
  const spec = isAbsolute(override) ? override : resolve(override);
  const stamp = existsSync(spec) ? `${statSync(spec).mtimeMs}:${statSync(spec).size}` : "";
  const key = `local-${createHash("sha256").update(`${spec}
${stamp}`).digest("hex").slice(0, 12)}`;
  return { root, spec: `file:${spec}`, key, dir: join(root, key) };
}
function findBun({ env: env2, home }, exists = existsSync) {
  for (const dir of (env2.PATH ?? "").split(delimiter)) {
    if (dir && exists(join(dir, "bun"))) return join(dir, "bun");
  }
  for (const candidate of [
    join(env2.BUN_INSTALL ?? join(home, ".bun"), "bin", "bun"),
    join(home, ".bun", "bin", "bun")
  ]) {
    if (exists(candidate)) return candidate;
  }
  return void 0;
}
function readJson(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return typeof value === "object" && value !== null ? value : void 0;
  } catch {
    return void 0;
  }
}
function installed(dir) {
  if (!existsSync(join(dir, READY))) return void 0;
  const cli = join(dir, "node_modules", "antechamber", "dist", "cli.js");
  const antechamber = readJson(join(dir, "node_modules", "antechamber", "package.json"))?.version;
  if (!existsSync(cli) || typeof antechamber !== "string") return void 0;
  const omo = readJson(join(dir, "node_modules", "omo-ai", "package.json"))?.version;
  return { dir, cli, antechamber, omo: typeof omo === "string" ? omo : void 0 };
}
function lockHeld(lock, deps) {
  let mtime;
  try {
    mtime = statSync(lock).mtimeMs;
  } catch {
    return false;
  }
  const pid = Number.parseInt(readFileSync(join(lock, "pid"), { encoding: "utf8", flag: "a+" }), 10);
  if (deps.now() - mtime > STALE_LOCK_MS) return false;
  return !Number.isInteger(pid) || deps.pidAlive(pid);
}
function runtimeState(paths, deps = defaultDeps()) {
  const runtime = installed(paths.dir);
  if (runtime) return { state: "ready", runtime };
  if (lockHeld(`${paths.dir}.lock`, deps)) return { state: "installing" };
  const error = existsSync(`${paths.dir}.error`) ? readFileSync(`${paths.dir}.error`, "utf8") : void 0;
  return error ? { state: "failed", error } : { state: "missing" };
}
function tryLock(lock, deps) {
  try {
    mkdirSync(lock);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (lockHeld(lock, deps)) return false;
    rmSync(lock, { recursive: true, force: true });
    return tryLock(lock, deps);
  }
  writeFileSync(join(lock, "pid"), String(process.pid));
  return true;
}
function prune(paths) {
  const others = readdirSync(paths.root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name !== paths.key && !/\.(lock|tmp-.*)$/.test(entry.name)).map((entry) => join(paths.root, entry.name)).filter((dir) => existsSync(join(dir, READY)) && !existsSync(`${dir}.lock`)).map((dir) => ({ dir, at: Number(readJson(join(dir, READY))?.installedAt ?? 0) })).sort((a, b) => b.at - a.at);
  for (const { dir } of others.slice(1)) rmSync(dir, { recursive: true, force: true });
}
async function installOnce(paths, bun, deps) {
  const staging = `${paths.dir}.tmp-${process.pid}-${deps.now()}`;
  mkdirSync(staging, { recursive: true });
  try {
    const manifest = {
      name: "antechamber-runtime",
      private: true,
      dependencies: { antechamber: paths.spec },
      // omo-ai's postinstall prepares its engine; Bun skips dependency scripts unless trusted.
      trustedDependencies: ["omo-ai"]
    };
    writeFileSync(join(staging, "package.json"), `${JSON.stringify(manifest, null, 2)}
`);
    await deps.install(bun, staging);
    writeFileSync(join(staging, READY), `${JSON.stringify({ spec: paths.spec, installedAt: deps.now() })}
`);
    if (!installed(staging)) throw new Error(`bun install did not produce node_modules/antechamber/dist/cli.js`);
    rmSync(paths.dir, { recursive: true, force: true });
    renameSync(staging, paths.dir);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  const runtime = installed(paths.dir);
  if (!runtime) throw new Error(`runtime vanished from ${paths.dir}`);
  return runtime;
}
async function ensureRuntime(paths, bun, deps = defaultDeps()) {
  const lock = `${paths.dir}.lock`;
  for (; ; ) {
    const ready = installed(paths.dir);
    if (ready) return ready;
    if (!bun) throw new Error("bun not found on PATH or in ~/.bun/bin; install it from https://bun.sh");
    mkdirSync(paths.root, { recursive: true });
    if (!tryLock(lock, deps)) {
      await deps.pause();
      continue;
    }
    try {
      const raced = installed(paths.dir);
      if (raced) return raced;
      const runtime = await installOnce(paths, bun, deps);
      rmSync(`${paths.dir}.error`, { force: true });
      prune(paths);
      return runtime;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeFileSync(`${paths.dir}.error`, message.slice(-ERROR_TAIL_CHARS));
      throw error;
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }
}
function bunInstall(bun, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bun, ["install", "--production", "--no-progress"], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    const keep = (chunk) => {
      output = (output + chunk.toString("utf8")).slice(-ERROR_TAIL_CHARS);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => child.kill("SIGTERM"), INSTALL_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else reject(new Error(`bun install failed (${signal ?? `exit ${code}`}): ${output.trim()}`));
    });
  });
}
function defaultDeps() {
  return {
    install: bunInstall,
    pause: () => new Promise((done) => setTimeout(done, 500)),
    now: Date.now,
    pidAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return error.code === "EPERM";
      }
    }
  };
}

// extensions/antechamber/src/service.ts
import { timingSafeEqual as timingSafeEqual2 } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { join as join4 } from "node:path";

// extensions/antechamber/src/graph/routes.ts
import http from "node:http";
import { resolve as resolve2 } from "node:path";

// extensions/antechamber/src/graph/graph.ts
import { createHash as createHash2 } from "node:crypto";
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
    if (value.deleted === true) entry.deleted = true;
    if (text(value.piSessionId) !== void 0) entry.piSessionId = text(value.piSessionId);
    if (text(value.parentID) !== void 0) entry.parentID = text(value.parentID);
    if (text(value.title) !== void 0) entry.title = text(value.title);
    if (isObject(value.task)) entry.task = { id: text(value.task.id), parentPiId: text(value.task.parentPiId) };
    out[id] = entry;
  }
  return out;
}
function ocIdFor(piSessionId) {
  return `ses_${createHash2("md5").update(piSessionId).digest("hex")}`;
}
function taskSessionId(task, tasks, registry) {
  const registered = Object.entries(registry).find(
    ([, entry]) => entry.task?.id === task.task_id && entry.task.parentPiId === task.parent_session_id
  );
  if (registered) return registered[0];
  const legacy = ocIdFor(task.task_id);
  const parent = Object.entries(registry).find(([, entry]) => entry.piSessionId === task.parent_session_id)?.[0];
  if (registry[legacy]?.deleted && registry[legacy]?.parentID === (parent ?? ocIdFor(task.parent_session_id ?? "")))
    return legacy;
  const qualified = ocIdFor(`${task.parent_session_id}:${task.task_id}`);
  if (registry[legacy] !== void 0 || registry[qualified] !== void 0 || tasks.some((other) => other.task_id === task.task_id && other.parent_session_id !== task.parent_session_id))
    return qualified;
  return legacy;
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
  const focusTask = tasks.find((t) => taskSessionId(t, tasks, registry) === sessionId);
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
      sessionId: taskSessionId(t, tasks, registry),
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

// extensions/antechamber/src/graph/store.ts
import { lstatSync, readdirSync as readdirSync2, readFileSync as readFileSync2, statSync as statSync2 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join2 } from "node:path";
import { DatabaseSync } from "node:sqlite";
function expandHome(path) {
  if (path === "~") return homedir2();
  return path.startsWith("~/") ? join2(homedir2(), path.slice(2)) : path;
}
function defaultRoots() {
  const home = homedir2();
  return {
    agentDirs: [join2(home, ".omo", "agent"), join2(home, ".pi", "agent")],
    stateDirs: [join2(home, ".config", "antechamber"), join2(home, ".config", "openchamber-pi-connector")]
  };
}
function isMissing(error) {
  return error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR", "EACCES"].includes(String(error.code));
}
function list(dir) {
  try {
    return readdirSync2(dir);
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
      stat = statSync2(path);
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
      value = accept(JSON.parse(readFileSync2(path, "utf8")));
    } catch (error) {
      if (error instanceof SyntaxError || isMissing(error)) return hit?.value;
      throw error;
    }
    this.entries.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, value });
    return value;
  }
};
var isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
var RegistryReader = class {
  databases = /* @__PURE__ */ new Map();
  files = new JsonCache();
  read(dir) {
    const path = join2(dir, "sessions.sqlite");
    if (!isRegularFile(path)) {
      this.databases.get(path)?.db.close();
      this.databases.delete(path);
      return this.files.read(join2(dir, "sessions.json"), normalizeRegistry);
    }
    let open = this.databases.get(path);
    if (!open) {
      open = { db: new DatabaseSync(path, { readOnly: true }), version: void 0, value: {} };
      this.databases.set(path, open);
    }
    const version2 = open.db.prepare("PRAGMA data_version").get()?.data_version;
    if (version2 !== open.version) {
      const rows = {};
      for (const row of open.db.prepare("SELECT id, payload FROM sessions").all())
        rows[String(row.id)] = JSON.parse(String(row.payload));
      open.value = normalizeRegistry(rows) ?? {};
      open.version = version2;
    }
    return open.value;
  }
};
var TaskStore = class {
  constructor(roots) {
    this.roots = roots;
  }
  roots;
  tasks = new JsonCache();
  json = new JsonCache();
  registries = new RegistryReader();
  storeDirs() {
    const dirs = /* @__PURE__ */ new Set();
    for (const agent of this.roots.agentDirs) {
      const registry = this.json.read(join2(agent, "rpc", "task-stores.json"), (v) => isRecord(v) ? v : void 0);
      if (isRecord(registry?.stores)) for (const dir of Object.keys(registry.stores)) dirs.add(dir);
      for (const project of list(join2(agent, "projects"))) dirs.add(join2(agent, "projects", project, "senpi-task"));
    }
    return [...dirs];
  }
  loadTasks() {
    const out = /* @__PURE__ */ new Map();
    for (const dir of this.storeDirs()) {
      for (const file of list(join2(dir, "tasks"))) {
        if (!file.endsWith(".json")) continue;
        const path = join2(dir, "tasks", file);
        if (!isRegularFile(path)) continue;
        const task = this.tasks.read(path, normalizeTask);
        if (task) out.set(JSON.stringify([task.parent_session_id, task.task_id]), task);
      }
    }
    return [...out.values()];
  }
  loadRegistry() {
    const merged = {};
    for (const dir of [...this.roots.stateDirs].reverse()) {
      const reg = this.registries.read(dir);
      if (reg) Object.assign(merged, reg);
    }
    return merged;
  }
};

// extensions/antechamber/src/graph/routes.ts
var MAX_TASK_STORES = 32;
var MAX_GRAPH_BODY_CHARS = 24e4;
function canonicalRoots(roots) {
  return {
    agentDirs: roots.agentDirs.map((path) => resolve2(expandHome(path))),
    stateDirs: roots.stateDirs.map((path) => resolve2(expandHome(path)))
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

// extensions/antechamber/src/work/routes.ts
import { timingSafeEqual } from "node:crypto";
import http2 from "node:http";
import { resolve as resolve3 } from "node:path";

// extensions/antechamber/src/work/discovery.ts
import { readdirSync as readdirSync3, readFileSync as readFileSync3 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { join as join3 } from "node:path";
function expandHome2(path) {
  if (path === "~") return homedir3();
  return path.startsWith("~/") ? join3(homedir3(), path.slice(2)) : path;
}
function defaultStateDirs(home = homedir3()) {
  return [join3(home, ".config", "antechamber"), join3(home, ".config", "openchamber-pi-connector")];
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}
function loopbackUrl(url) {
  return url.replace("://0.0.0.0:", "://127.0.0.1:").replace("://[::]:", "://[::1]:");
}
function discoverServers(stateDirs, isAlive = alive) {
  const servers = /* @__PURE__ */ new Map();
  for (const dir of stateDirs) {
    let names;
    try {
      names = readdirSync3(join3(dir, "run"));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/^\d+\.json$/.test(name)) continue;
      try {
        const record = JSON.parse(readFileSync3(join3(dir, "run", name), "utf8"));
        if (record === null || typeof record !== "object") continue;
        const { pid, url, token: token2, started } = record;
        if (typeof pid !== "number" || typeof url !== "string" || typeof token2 !== "string") continue;
        if (typeof started !== "string" || servers.has(pid) || !isAlive(pid)) continue;
        servers.set(pid, { pid, url: loopbackUrl(url), token: token2, started });
      } catch {
      }
    }
  }
  return [...servers.values()].sort((a, b) => b.started.localeCompare(a.started));
}

// extensions/antechamber/src/work/routes.ts
var SESSION_ID = /^ses_[0-9A-Za-z]+$/;
var STATUS_TIMEOUT_MS = 5e3;
var ACTION_TIMEOUT_MS = 15e3;
async function call(server, method, path, timeoutMs) {
  const response = await fetch(`${server.url}/antechamber/work-status/${path}`, {
    method,
    headers: { Authorization: `Bearer ${server.token}` },
    signal: AbortSignal.timeout(timeoutMs)
  });
  return { status: response.status, body: await response.text() };
}
function createServer2(options) {
  const discover = options.discover ?? ((dirs) => discoverServers(dirs));
  const defaultDirs = options.defaultDirs ?? (() => defaultStateDirs());
  const owners = /* @__PURE__ */ new Map();
  const send = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(body);
  };
  const fail = (res, status, error, detail) => send(res, status, JSON.stringify({ error, ...detail !== void 0 ? { detail } : {} }));
  const ordered = (session, stateDirs) => {
    const servers = discover(stateDirs);
    const owner = owners.get(session);
    return owner === void 0 ? servers : [...servers].sort((a, b) => Number(b.pid === owner) - Number(a.pid === owner));
  };
  const relayStatus = async (res, session, stateDirs) => {
    const servers = ordered(session, stateDirs);
    if (servers.length === 0)
      return fail(
        res,
        503,
        "no-server",
        `No running antechamber server with a work-status token in ${stateDirs.join(", ")}`
      );
    let fallback;
    let lastError;
    for (const server of servers) {
      try {
        const upstream = await call(server, "GET", encodeURIComponent(session), STATUS_TIMEOUT_MS);
        if (upstream.status !== 200) {
          lastError = `${server.url} answered HTTP ${upstream.status}`;
          continue;
        }
        if (JSON.parse(upstream.body).live === true) {
          owners.set(session, server.pid);
          return send(res, 200, upstream.body);
        }
        fallback ??= { server, upstream };
      } catch (error) {
        lastError = `${server.url}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (fallback) {
      owners.set(session, fallback.server.pid);
      return send(res, 200, fallback.upstream.body);
    }
    return fail(res, 502, "unreachable", lastError);
  };
  const relayAction = async (res, session, stateDirs, method, path) => {
    const server = ordered(session, stateDirs)[0];
    if (server === void 0) return fail(res, 503, "no-server");
    try {
      const upstream = await call(server, method, `${encodeURIComponent(session)}/${path}`, ACTION_TIMEOUT_MS);
      return send(res, upstream.status, upstream.body || "{}");
    } catch (error) {
      return fail(res, 502, "unreachable", error instanceof Error ? error.message : String(error));
    }
  };
  const expected = Buffer.from(`Bearer ${options.token}`);
  return http2.createServer((req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? "");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      return fail(res, 401, "unauthorized");
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/health") return send(res, 200, '{"ok":true}');
    const session = url.searchParams.get("session") ?? "";
    if (!SESSION_ID.test(session)) return fail(res, 400, "session query must be an OpenChamber session id");
    const custom = url.searchParams.get("stateDir")?.trim();
    const stateDirs = custom ? [resolve3(expandHome2(custom))] : defaultDirs();
    const method = req.method ?? "GET";
    req.resume();
    if (url.pathname === "/status" && method === "GET") return void relayStatus(res, session, stateDirs);
    if (url.pathname === "/goal/fire" && method === "POST")
      return void relayAction(res, session, stateDirs, "POST", "goal/fire");
    return fail(res, 404, "not-found");
  });
}

// extensions/antechamber/src/service.ts
function createService(options) {
  const deps = options.deps ?? defaultDeps();
  const graph = createServer(options.token);
  const work = createServer2({ token: options.token });
  let installing;
  const install = () => {
    installing ??= ensureRuntime(options.paths, options.bun, deps).catch(() => void 0).finally(() => {
      installing = void 0;
    });
    return installing;
  };
  const status = () => {
    const current = runtimeState(options.paths, deps);
    const base = {
      state: installing && current.state !== "ready" ? "installing" : current.state,
      spec: options.paths.spec,
      launcher: join4(options.extensionDir, "bin", "opencode-antechamber"),
      bun: options.bun ?? null
    };
    if (current.state === "ready")
      return {
        ...base,
        antechamber: current.runtime.antechamber,
        dir: current.runtime.dir,
        ...current.runtime.omo ? { omo: current.runtime.omo } : {}
      };
    if (current.state === "failed" && !installing) return { ...base, error: current.error };
    if (!options.bun) return { ...base, state: "failed", error: "bun not found on PATH or in ~/.bun/bin" };
    return base;
  };
  if (options.prewarm && options.bun && runtimeState(options.paths, deps).state === "missing") void install();
  const expected = Buffer.from(`Bearer ${options.token}`);
  const send = (res, code, body) => {
    res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };
  return createHttpServer((req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? "");
    if (supplied.length !== expected.length || !timingSafeEqual2(supplied, expected))
      return send(res, 401, { error: "unauthorized" });
    const { pathname } = new URL(req.url ?? "/", "http://127.0.0.1");
    if (pathname === "/health") return send(res, 200, { ok: true });
    if (pathname === "/graph") return void graph.emit("request", req, res);
    if (pathname === "/status" || pathname === "/goal/fire") return void work.emit("request", req, res);
    if (pathname === "/runtime" && req.method === "GET") return send(res, 200, status());
    if (pathname === "/runtime/install" && req.method === "POST") {
      req.resume();
      if (options.bun) void install();
      return send(res, 202, status());
    }
    return send(res, 404, { error: "not-found" });
  });
}

// extensions/antechamber/src/service-main.ts
var port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
var token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
if (!port || !token) {
  console.error("OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required");
  process.exit(1);
}
var extensionDir = resolve4(dirname(fileURLToPath(import.meta.url)), "..");
var { version } = JSON.parse(readFileSync4(join5(extensionDir, "package.json"), "utf8"));
chmodSync(join5(extensionDir, "bin", "opencode-antechamber"), 493);
var env = defaultEnv();
createService({
  token,
  extensionDir,
  paths: runtimePaths(version, env),
  bun: findBun(env),
  prewarm: true
}).listen(port, "127.0.0.1");
