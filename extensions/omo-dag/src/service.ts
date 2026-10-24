import http from "node:http";
import { resolve } from "node:path";
import { buildGraph } from "./graph.ts";
import { defaultRoots, expandHome, TaskStore, type StoreRoots } from "./store.ts";

export const MAX_TASK_STORES = 32;
export const MAX_GRAPH_BODY_CHARS = 1_000_000;

function canonicalRoots(roots: StoreRoots): StoreRoots {
  return {
    agentDirs: roots.agentDirs.map((path) => resolve(expandHome(path))),
    stateDirs: roots.stateDirs.map((path) => resolve(expandHome(path))),
  };
}

function graphWithTaskLimit(graph: ReturnType<typeof buildGraph>, taskCount: number): ReturnType<typeof buildGraph> {
  const root = graph.nodes.find((node) => node.kind === "root");
  if (!root) return graph;
  const tasks = graph.nodes.filter((node) => node.kind === "task");
  const shown = [root, ...tasks.slice(0, taskCount)];
  const shownIds = new Set(shown.map((node) => node.id));
  const columns = new Map<number, { column: number; total: number; done: number; running: number }>();
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
    ...(taskCount < tasks.length ? { truncated: { omittedNodes: tasks.length - taskCount } } : {}),
  };
}

function boundedGraph(graph: ReturnType<typeof buildGraph>): ReturnType<typeof buildGraph> {
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

export function rootsFrom(query: URLSearchParams, fallback = defaultRoots()): StoreRoots {
  const pick = (key: string, base: string[]) => {
    const value = query.get(key)?.trim();
    return value ? [expandHome(value)] : base;
  };
  return canonicalRoots({
    agentDirs: pick("agentDir", fallback.agentDirs),
    stateDirs: pick("stateDir", fallback.stateDirs),
  });
}

export function createServer(
  token: string,
  makeStore: (roots: StoreRoots) => TaskStore = (r) => new TaskStore(r),
): http.Server {
  const stores = new Map<string, TaskStore>();
  const storeFor = (roots: StoreRoots) => {
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
      if (oldest !== undefined) stores.delete(oldest);
    }
    return store;
  };
  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };
  return http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { error: "unauthorized" });
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
