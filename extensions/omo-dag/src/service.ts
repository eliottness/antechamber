import http from "node:http";
import { buildGraph } from "./graph.ts";
import { defaultRoots, expandHome, TaskStore, type StoreRoots } from "./store.ts";

export function rootsFrom(query: URLSearchParams, fallback = defaultRoots()): StoreRoots {
  const pick = (key: string, base: string[]) => {
    const value = query.get(key)?.trim();
    return value ? [expandHome(value)] : base;
  };
  return { agentDirs: pick("agentDir", fallback.agentDirs), stateDirs: pick("stateDir", fallback.stateDirs) };
}

export function createServer(
  token: string,
  makeStore: (roots: StoreRoots) => TaskStore = (r) => new TaskStore(r),
): http.Server {
  const stores = new Map<string, TaskStore>();
  const storeFor = (roots: StoreRoots) => {
    const key = JSON.stringify(roots);
    let store = stores.get(key);
    if (!store) {
      store = makeStore(roots);
      stores.set(key, store);
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
        return json(res, 200, buildGraph(session, store.loadTasks(), store.loadRegistry()));
      } catch (error) {
        return json(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    return json(res, 404, { error: "not-found" });
  });
}
