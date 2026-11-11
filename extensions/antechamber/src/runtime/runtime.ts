/**
 * The antechamber runtime the extension manages: the antechamber npm package (which pins omo-ai) installed
 * with Bun into a per-version directory. Both the launcher (on Bun) and the extension service (on
 * OpenChamber's own runtime) use this module, so whichever starts first installs and the other waits.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";

/** A lock older than this is a crashed installer, never a slow one (installs take seconds to a few minutes). */
export const STALE_LOCK_MS = 15 * 60_000;
export const INSTALL_TIMEOUT_MS = 10 * 60_000;
const READY = ".ready.json";
const ERROR_TAIL_CHARS = 2000;

export interface RuntimeEnv {
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
}

export interface RuntimePaths {
  readonly root: string;
  /** What `bun install` is asked for: a version, or a local tarball/folder for development. */
  readonly spec: string;
  readonly key: string;
  readonly dir: string;
}

export interface InstalledRuntime {
  readonly dir: string;
  readonly cli: string;
  readonly antechamber: string;
  readonly omo: string | undefined;
}

export type RuntimeState =
  | { state: "ready"; runtime: InstalledRuntime }
  | { state: "installing" }
  | { state: "missing" }
  | { state: "failed"; error: string };

export interface InstallDeps {
  /** Runs `bun install` in `cwd`; resolves on exit 0, rejects with the output tail otherwise. */
  readonly install: (bun: string, cwd: string) => Promise<void>;
  readonly pause: () => Promise<void>;
  readonly now: () => number;
  readonly pidAlive: (pid: number) => boolean;
}

export function defaultEnv(): RuntimeEnv {
  return { env: process.env, home: homedir() };
}

export function runtimeRoot({ env, home }: RuntimeEnv): string {
  const configured = env.ANTECHAMBER_RUNTIME_DIR?.trim();
  return configured ? resolve(configured) : join(home, ".antechamber", "runtime");
}

/**
 * The runtime for `version` (the extension's own version, which every release keeps equal to
 * antechamber's). `ANTECHAMBER_RUNTIME_SPEC` overrides it with a tarball or folder, for development.
 */
export function runtimePaths(version: string, runtime: RuntimeEnv): RuntimePaths {
  const root = runtimeRoot(runtime);
  const override = runtime.env.ANTECHAMBER_RUNTIME_SPEC?.trim();
  if (!override) return { root, spec: version, key: version, dir: join(root, version) };
  const spec = isAbsolute(override) ? override : resolve(override);
  // A rebuilt tarball at the same path is a new runtime.
  const stamp = existsSync(spec) ? `${statSync(spec).mtimeMs}:${statSync(spec).size}` : "";
  const key = `local-${createHash("sha256").update(`${spec}\n${stamp}`).digest("hex").slice(0, 12)}`;
  return { root, spec: `file:${spec}`, key, dir: join(root, key) };
}

/** Bun on PATH, then where its installer puts it: GUI apps and services often lack it on PATH. */
export function findBun({ env, home }: RuntimeEnv, exists: (path: string) => boolean = existsSync): string | undefined {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir && exists(join(dir, "bun"))) return join(dir, "bun");
  }
  for (const candidate of [
    join(env.BUN_INSTALL ?? join(home, ".bun"), "bin", "bun"),
    join(home, ".bun", "bin", "bun"),
  ]) {
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function installed(dir: string): InstalledRuntime | undefined {
  if (!existsSync(join(dir, READY))) return undefined;
  const cli = join(dir, "node_modules", "antechamber", "dist", "cli.js");
  const antechamber = readJson(join(dir, "node_modules", "antechamber", "package.json"))?.version;
  if (!existsSync(cli) || typeof antechamber !== "string") return undefined;
  const omo = readJson(join(dir, "node_modules", "omo-ai", "package.json"))?.version;
  return { dir, cli, antechamber, omo: typeof omo === "string" ? omo : undefined };
}

function lockHeld(lock: string, deps: Pick<InstallDeps, "now" | "pidAlive">): boolean {
  let mtime: number;
  try {
    mtime = statSync(lock).mtimeMs;
  } catch {
    return false;
  }
  const pid = Number.parseInt(readFileSync(join(lock, "pid"), { encoding: "utf8", flag: "a+" }), 10);
  if (deps.now() - mtime > STALE_LOCK_MS) return false;
  return !Number.isInteger(pid) || deps.pidAlive(pid);
}

export function runtimeState(
  paths: RuntimePaths,
  deps: Pick<InstallDeps, "now" | "pidAlive"> = defaultDeps(),
): RuntimeState {
  const runtime = installed(paths.dir);
  if (runtime) return { state: "ready", runtime };
  if (lockHeld(`${paths.dir}.lock`, deps)) return { state: "installing" };
  const error = existsSync(`${paths.dir}.error`) ? readFileSync(`${paths.dir}.error`, "utf8") : undefined;
  return error ? { state: "failed", error } : { state: "missing" };
}

function tryLock(lock: string, deps: Pick<InstallDeps, "now" | "pidAlive">): boolean {
  try {
    mkdirSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (lockHeld(lock, deps)) return false;
    // A crashed installer left it: take it over.
    rmSync(lock, { recursive: true, force: true });
    return tryLock(lock, deps);
  }
  writeFileSync(join(lock, "pid"), String(process.pid));
  return true;
}

/** Keeps `current` and the most recent other runtime (an adapter started before an update may still use it). */
function prune(paths: RuntimePaths): void {
  const others = readdirSync(paths.root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== paths.key && !/\.(lock|tmp-.*)$/.test(entry.name))
    .map((entry) => join(paths.root, entry.name))
    .filter((dir) => existsSync(join(dir, READY)) && !existsSync(`${dir}.lock`))
    .map((dir) => ({ dir, at: Number(readJson(join(dir, READY))?.installedAt ?? 0) }))
    .sort((a, b) => b.at - a.at);
  for (const { dir } of others.slice(1)) rmSync(dir, { recursive: true, force: true });
}

async function installOnce(paths: RuntimePaths, bun: string, deps: InstallDeps): Promise<InstalledRuntime> {
  const staging = `${paths.dir}.tmp-${process.pid}-${deps.now()}`;
  mkdirSync(staging, { recursive: true });
  try {
    const manifest = {
      name: "antechamber-runtime",
      private: true,
      dependencies: { antechamber: paths.spec },
      // omo-ai's postinstall prepares its engine; Bun skips dependency scripts unless trusted.
      trustedDependencies: ["omo-ai"],
    };
    writeFileSync(join(staging, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await deps.install(bun, staging);
    writeFileSync(join(staging, READY), `${JSON.stringify({ spec: paths.spec, installedAt: deps.now() })}\n`);
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

/**
 * Returns the installed runtime, installing it first when it is missing. Concurrent callers, in this
 * process or another, share one install through a lock directory beside the runtime.
 */
export async function ensureRuntime(
  paths: RuntimePaths,
  bun: string | undefined,
  deps: InstallDeps = defaultDeps(),
): Promise<InstalledRuntime> {
  const lock = `${paths.dir}.lock`;
  for (;;) {
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

function bunInstall(bun: string, cwd: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bun, ["install", "--production", "--no-progress"], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const keep = (chunk: Buffer) => {
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

export function defaultDeps(): InstallDeps {
  return {
    install: bunInstall,
    pause: () => new Promise((done) => setTimeout(done, 500)),
    now: Date.now,
    pidAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    },
  };
}
