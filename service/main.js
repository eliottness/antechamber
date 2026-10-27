// extensions/omo-work/src/service.ts
import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import { resolve } from "node:path";

// extensions/omo-work/src/discovery.ts
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
function expandHome(path) {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}
function defaultStateDirs(home = homedir()) {
  return [join(home, ".config", "antechamber"), join(home, ".config", "openchamber-pi-connector")];
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
      names = readdirSync(join(dir, "run"));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/^\d+\.json$/.test(name)) continue;
      try {
        const record = JSON.parse(readFileSync(join(dir, "run", name), "utf8"));
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

// extensions/omo-work/src/service.ts
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
function createServer(options) {
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

// extensions/omo-work/src/service-main.ts
var port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
var token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
if (!port || !token) {
  console.error("OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required");
  process.exit(1);
}
createServer({ token }).listen(port, "127.0.0.1");
