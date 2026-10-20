import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** A `serve` process as antechamber records it in `<state dir>/run/<pid>.json` (src/running-servers.ts). */
export interface AdapterServer {
  pid: number;
  url: string;
  token: string;
  started: string;
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/** antechamber's default state directories (src/config.ts `defaultStateDir`), current first. */
export function defaultStateDirs(home = homedir()): string[] {
  return [join(home, ".config", "antechamber"), join(home, ".config", "openchamber-pi-connector")];
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/** A wildcard bind is reachable on loopback; the service always runs on the same host. */
function loopbackUrl(url: string): string {
  return url.replace("://0.0.0.0:", "://127.0.0.1:").replace("://[::]:", "://[::1]:");
}

/** Running servers that publish a token, newest first. Older antechamber versions publish none. */
export function discoverServers(stateDirs: string[], isAlive: (pid: number) => boolean = alive): AdapterServer[] {
  const servers = new Map<number, AdapterServer>();
  for (const dir of stateDirs) {
    let names: string[];
    try {
      names = readdirSync(join(dir, "run"));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/^\d+\.json$/.test(name)) continue;
      try {
        const record: unknown = JSON.parse(readFileSync(join(dir, "run", name), "utf8"));
        if (record === null || typeof record !== "object") continue;
        const { pid, url, token, started } = record as Record<string, unknown>;
        if (typeof pid !== "number" || typeof url !== "string" || typeof token !== "string") continue;
        if (typeof started !== "string" || servers.has(pid) || !isAlive(pid)) continue;
        servers.set(pid, { pid, url: loopbackUrl(url), token, started });
      } catch {
        // A record being written or removed concurrently.
      }
    }
  }
  return [...servers.values()].sort((a, b) => b.started.localeCompare(a.started));
}
