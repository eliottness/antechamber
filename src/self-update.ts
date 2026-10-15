/** Upgrades a global npm or bun install of antechamber to the latest published release. */
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ADAPTER_VERSION } from "./version.js";

export type InstallMethod = "npm" | "bun";

export class SelfUpdateUnsupportedError extends Error {
  override readonly name = "SelfUpdateUnsupportedError";
}

export interface InstallLocation {
  readonly packageRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  readonly realpath: (path: string) => string;
}

export interface SelfUpdateDeps extends InstallLocation {
  readonly npmBinary: string;
  readonly bunBinary: string;
  readonly npmRoot: () => Promise<string>;
  readonly currentVersion: string;
  readonly latestVersion: () => Promise<string>;
  readonly install: (binary: string, args: readonly string[]) => Promise<void>;
}

export interface SelfUpdateResult {
  readonly updated: boolean;
  readonly from: string;
  readonly to: string;
  readonly method: InstallMethod;
}

const INSTALL_TIMEOUT_MS = 5 * 60_000;
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

function tryRealpath(path: string, location: InstallLocation): string | undefined {
  try {
    return location.realpath(path);
  } catch {
    return undefined;
  }
}

function bunInstallDir(location: Pick<InstallLocation, "env" | "home">): string {
  return location.env.BUN_INSTALL ?? join(location.home, ".bun");
}

function locate(location: InstallLocation): { root: string; bun: boolean } {
  const root = tryRealpath(location.packageRoot, location) ?? location.packageRoot;
  if (basename(root) !== "antechamber" || basename(dirname(root)) !== "node_modules") throw notGlobal(root);
  const bunPackage = join(bunInstallDir(location), "install", "global", "node_modules", "antechamber");
  return { root, bun: tryRealpath(bunPackage, location) === root };
}

function notGlobal(root: string): SelfUpdateUnsupportedError {
  return new SelfUpdateUnsupportedError(
    `${root} is not a global npm or bun install of antechamber; update it the way it was installed (source checkout: git pull && npm ci && npm run build)`,
  );
}

function npmOwns(location: InstallLocation, root: string, npmGlobal: string): InstallMethod {
  const global = npmGlobal.trim();
  if (global !== "" && tryRealpath(join(global, "antechamber"), location) === root) return "npm";
  throw notGlobal(root);
}

function npmUnavailable(error: unknown): SelfUpdateUnsupportedError {
  const reason = error instanceof Error ? error.message : String(error);
  return new SelfUpdateUnsupportedError(`cannot run npm root -g to confirm a global npm install (${reason})`);
}

export function installMethod(location: InstallLocation, npmRoot: () => string): InstallMethod {
  const { root, bun } = locate(location);
  if (bun) return "bun";
  let global: string;
  try {
    global = npmRoot();
  } catch (error) {
    throw npmUnavailable(error);
  }
  return npmOwns(location, root, global);
}

async function installMethodAsync(deps: SelfUpdateDeps): Promise<InstallMethod> {
  const { root, bun } = locate(deps);
  if (bun) return "bun";
  let global: string;
  try {
    global = await deps.npmRoot();
  } catch (error) {
    throw npmUnavailable(error);
  }
  return npmOwns(deps, root, global);
}

export function isNewerVersion(a: string, b: string): boolean {
  const left = VERSION_PATTERN.exec(a);
  const right = VERSION_PATTERN.exec(b);
  if (left === null || right === null) return false;
  for (let index = 1; index <= 3; index += 1) {
    const diff = Number(left[index]) - Number(right[index]);
    if (diff !== 0) return diff > 0;
  }
  if (left[4] === right[4]) return false;
  if (left[4] === undefined) return true;
  if (right[4] === undefined) return false;
  const leftParts = left[4].split(".");
  const rightParts = right[4].split(".");
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const l = leftParts[index];
    const r = rightParts[index];
    if (l === undefined) return false;
    if (r === undefined) return true;
    if (l === r) continue;
    const ln = /^\d+$/.test(l) ? Number(l) : undefined;
    const rn = /^\d+$/.test(r) ? Number(r) : undefined;
    if (ln !== undefined && rn !== undefined) return ln > rn;
    if (ln !== undefined) return false;
    if (rn !== undefined) return true;
    return l > r;
  }
  return false;
}

export async function fetchLatestVersion(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const url = new URL(
    `${(env.npm_config_registry ?? "https://registry.npmjs.org").replace(/\/+$/, "")}/antechamber/latest`,
  );
  // Registry URLs can embed a token; fetch rejects them and its error would echo the URL.
  url.username = "";
  url.password = "";
  let response: Response;
  try {
    response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new Error(`cannot reach the npm registry at ${url.host}`);
  }
  if (!response.ok) throw new Error(`npm registry at ${url.host} answered ${response.status} for antechamber`);
  const payload: unknown = await response.json().catch(() => undefined);
  const version =
    typeof payload === "object" && payload !== null && "version" in payload ? String(payload.version) : "";
  if (!VERSION_PATTERN.test(version)) throw new Error("npm registry returned no valid antechamber version");
  return version;
}

function run(binary: string, args: readonly string[], env: NodeJS.ProcessEnv, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(binary, [...args], { env, timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      // Installer output can contain registry credentials, so it is never echoed.
      if (error) reject(new Error(`${basename(binary)} ${args.join(" ")} failed; run it in a terminal for details`));
      else resolve(stdout);
    });
    // Package managers must see EOF instead of waiting for interactive input.
    child.stdin?.end();
  });
}

/** Prefers the npm shipped beside the running node: service PATHs often lack the user's tool directories. */
export function npmBinaryFor(execPath: string = process.execPath): string {
  const sibling = join(dirname(execPath), process.platform === "win32" ? "npm.cmd" : "npm");
  return existsSync(sibling) ? sibling : "npm";
}

function bunBinaryFor(env: NodeJS.ProcessEnv, home: string): string {
  const installed = join(bunInstallDir({ env, home }), "bin", "bun");
  return existsSync(installed) ? installed : "bun";
}

export function defaultSelfUpdateDeps(env: NodeJS.ProcessEnv = process.env, home = homedir()): SelfUpdateDeps {
  const npmBinary = npmBinaryFor();
  return {
    // src/self-update.ts (tsx) and dist/self-update.js both sit one level below the package root.
    packageRoot: fileURLToPath(new URL("..", import.meta.url)),
    env,
    home,
    realpath: realpathSync,
    npmBinary,
    bunBinary: bunBinaryFor(env, home),
    npmRoot: () => run(npmBinary, ["root", "-g"], env, 10_000),
    currentVersion: ADAPTER_VERSION,
    latestVersion: () => fetchLatestVersion(env),
    install: async (binary, args) => {
      await run(binary, args, env, INSTALL_TIMEOUT_MS);
    },
  };
}

let inFlight: Promise<SelfUpdateResult> | undefined;

/** Installs the latest release when it is newer; concurrent callers in this process share one attempt. */
export function selfUpdate(deps: SelfUpdateDeps = defaultSelfUpdateDeps()): Promise<SelfUpdateResult> {
  inFlight ??= (async () => {
    const method = await installMethodAsync(deps);
    const latest = await deps.latestVersion();
    const from = deps.currentVersion;
    if (!isNewerVersion(latest, from)) return { updated: false, from, to: from, method };
    const spec = `antechamber@${latest}`;
    if (method === "npm") await deps.install(deps.npmBinary, ["install", "-g", spec]);
    else await deps.install(deps.bunBinary, ["add", "-g", spec]);
    return { updated: true, from, to: latest, method };
  })().finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}
