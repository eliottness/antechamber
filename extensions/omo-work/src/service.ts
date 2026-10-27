import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import { resolve } from "node:path";
import { type AdapterServer, defaultStateDirs, discoverServers, expandHome } from "./discovery.ts";

const SESSION_ID = /^ses_[0-9A-Za-z]+$/;
const STATUS_TIMEOUT_MS = 5000;
/** Above the adapter's own 10 s RPC deadline, so a slow Fire now is not reported as unreachable. */
const ACTION_TIMEOUT_MS = 15_000;

export interface ServiceOptions {
  token: string;
  discover?: (stateDirs: string[]) => AdapterServer[];
  defaultDirs?: () => string[];
}

interface Upstream {
  status: number;
  body: string;
}

async function call(server: AdapterServer, method: string, path: string, timeoutMs: number): Promise<Upstream> {
  const response = await fetch(`${server.url}/antechamber/work-status/${path}`, {
    method,
    headers: { Authorization: `Bearer ${server.token}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: response.status, body: await response.text() };
}

/**
 * The extension's local service: finds the antechamber server that owns a session through the
 * run records and relays the work-status route and its actions. It holds no state of its own.
 */
export function createServer(options: ServiceOptions): http.Server {
  const discover = options.discover ?? ((dirs) => discoverServers(dirs));
  const defaultDirs = options.defaultDirs ?? (() => defaultStateDirs());
  /** The server that last answered for a session; tried first next time. */
  const owners = new Map<string, number>();

  const send = (res: http.ServerResponse, status: number, body: string) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(body);
  };
  const fail = (res: http.ServerResponse, status: number, error: string, detail?: string) =>
    send(res, status, JSON.stringify({ error, ...(detail !== undefined ? { detail } : {}) }));

  const ordered = (session: string, stateDirs: string[]): AdapterServer[] => {
    const servers = discover(stateDirs);
    const owner = owners.get(session);
    return owner === undefined
      ? servers
      : [...servers].sort((a, b) => Number(b.pid === owner) - Number(a.pid === owner));
  };

  /**
   * Every server can answer for a session it only knows from disk, so the one running its agent
   * (`live`) wins; otherwise the first that knows it.
   */
  const relayStatus = async (res: http.ServerResponse, session: string, stateDirs: string[]) => {
    const servers = ordered(session, stateDirs);
    if (servers.length === 0)
      return fail(
        res,
        503,
        "no-server",
        `No running antechamber server with a work-status token in ${stateDirs.join(", ")}`,
      );
    let fallback: { server: AdapterServer; upstream: Upstream } | undefined;
    let lastError: string | undefined;
    for (const server of servers) {
      try {
        const upstream = await call(server, "GET", encodeURIComponent(session), STATUS_TIMEOUT_MS);
        if (upstream.status !== 200) {
          lastError = `${server.url} answered HTTP ${upstream.status}`;
          continue;
        }
        if ((JSON.parse(upstream.body) as { live?: unknown }).live === true) {
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

  const relayAction = async (
    res: http.ServerResponse,
    session: string,
    stateDirs: string[],
    method: string,
    path: string,
  ) => {
    const server = ordered(session, stateDirs)[0];
    if (server === undefined) return fail(res, 503, "no-server");
    try {
      const upstream = await call(server, method, `${encodeURIComponent(session)}/${path}`, ACTION_TIMEOUT_MS);
      return send(res, upstream.status, upstream.body || "{}");
    } catch (error) {
      return fail(res, 502, "unreachable", error instanceof Error ? error.message : String(error));
    }
  };

  const expected = Buffer.from(`Bearer ${options.token}`);
  return http.createServer((req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? "");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      return fail(res, 401, "unauthorized");
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/health") return send(res, 200, '{"ok":true}');
    const session = url.searchParams.get("session") ?? "";
    if (!SESSION_ID.test(session)) return fail(res, 400, "session query must be an OpenChamber session id");
    const custom = url.searchParams.get("stateDir")?.trim();
    const stateDirs = custom ? [resolve(expandHome(custom))] : defaultDirs();
    const method = req.method ?? "GET";
    req.resume();
    if (url.pathname === "/status" && method === "GET") return void relayStatus(res, session, stateDirs);
    if (url.pathname === "/goal/fire" && method === "POST")
      return void relayAction(res, session, stateDirs, "POST", "goal/fire");
    return fail(res, 404, "not-found");
  });
}
