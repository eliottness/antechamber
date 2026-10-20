/**
 * Records each `serve` process under `<stateDir>/run/<pid>.json` so `antechamber doctor`
 * can tell which version is actually running. A merged and released fix does nothing until
 * OpenChamber relaunches the adapter, and auto-update only installs it for the next launch.
 */
import type * as fs from "node:fs";
import { join } from "node:path";

export interface RunningServer {
  readonly pid: number;
  readonly version: string;
  readonly url: string;
  readonly started: string;
  /** Bearer token for the `/antechamber/work-status` routes; the file is 0600 in a 0700 directory. */
  readonly token?: string;
}

type Fs = Pick<typeof fs, "existsSync" | "mkdirSync" | "readdirSync" | "readFileSync" | "rmSync" | "writeFileSync">;

const runDir = (stateDir: string): string => join(stateDir, "run");

/** Writes the record and returns its remover; a crash leaves a stale record that readers skip by PID. */
export function recordRunningServer(stateDir: string, server: RunningServer, files: Fs): () => void {
  const path = join(runDir(stateDir), `${server.pid}.json`);
  files.mkdirSync(runDir(stateDir), { recursive: true, mode: 0o700 });
  files.writeFileSync(path, `${JSON.stringify(server)}\n`, { mode: 0o600 });
  return () => files.rmSync(path, { force: true });
}

/** Records whose process is still alive, newest first. */
export function readRunningServers(stateDir: string, files: Fs, alive: (pid: number) => boolean): RunningServer[] {
  const dir = runDir(stateDir);
  if (!files.existsSync(dir)) return [];
  return files
    .readdirSync(dir)
    .filter((name) => /^\d+\.json$/.test(name))
    .flatMap((name): RunningServer[] => {
      try {
        const record: unknown = JSON.parse(files.readFileSync(join(dir, name), "utf8"));
        if (typeof record !== "object" || record === null) return [];
        const { pid, version, url, started } = record as Record<string, unknown>;
        if (typeof pid !== "number" || typeof version !== "string" || typeof url !== "string") return [];
        if (typeof started !== "string" || !alive(pid)) return [];
        return [{ pid, version, url, started }];
      } catch {
        return []; // A record being written or removed concurrently.
      }
    })
    .sort((a, b) => b.started.localeCompare(a.started));
}
