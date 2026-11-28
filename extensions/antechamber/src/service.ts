import { timingSafeEqual } from "node:crypto";
import type http from "node:http";
import { createServer as createHttpServer } from "node:http";
import { createServer as createGraphServer } from "./graph/routes.ts";
import {
  activateLauncher,
  configuredBinary,
  launcherPath,
  mayActivateUnasked,
  openchamberSettingsPath,
} from "./runtime/activate.ts";
import {
  defaultDeps,
  ensureRuntime,
  type InstallDeps,
  type RuntimePaths,
  type RuntimeState,
  launchStampPath,
  readStamp,
  runtimeState,
  writeStamp,
} from "./runtime/runtime.ts";
import { createServer as createWorkServer } from "./work/routes.ts";

export interface ServiceOptions {
  readonly token: string;
  readonly extensionDir: string;
  readonly paths: RuntimePaths;
  readonly bun: string | undefined;
  /** The home directory the launcher stamps its starts under (see `launchStampPath`). */
  readonly home: string;
  readonly deps?: InstallDeps;
  /** Install the runtime as soon as the service starts, so OpenChamber's first launch finds it ready. */
  readonly prewarm?: boolean;
  /**
   * Once the runtime is ready, point OpenChamber's OpenCode CLI at the launcher when that needs no consent
   * (see `mayActivateUnasked`), so installing the extension is all it takes.
   */
  readonly autoActivate?: boolean;
  /** Overrides where OpenChamber's settings.json is looked up (tests). */
  readonly settingsPath?: string;
}

export interface RuntimeStatus {
  readonly state: RuntimeState["state"];
  readonly spec: string;
  readonly launcher: string;
  readonly bun: string | null;
  readonly antechamber?: string;
  readonly omo?: string;
  readonly dir?: string;
  readonly error?: string;
  /** OpenChamber's settings.json when this extension can change it; `null` for folder installs. */
  readonly settings: string | null;
  /** Settings -> OpenCode CLI, including a read-only default profile; `null` when unset or unknown. */
  readonly configured: string | null;
  /** Why `settings` could not be read (invalid JSON, say); the CLI is then left alone. */
  readonly settingsError?: string;
  /** Whether Settings -> OpenCode CLI already names this launcher. */
  readonly active: boolean;
  /** The launcher was made the OpenCode CLI after OpenChamber last started it: Restart OpenCode switches over. */
  readonly needsReload: boolean;
}

/**
 * The extension's one host service: the OmO Graph routes (`/graph`), the OmO Work relay (`/status`,
 * `/goal/fire`) and the managed runtime (`/runtime`). The graph and work servers are never bound to a
 * port; their request handlers serve the paths they own.
 */
export function createService(options: ServiceOptions): http.Server {
  const deps = options.deps ?? defaultDeps();
  const graph = createGraphServer(options.token);
  const work = createWorkServer({ token: options.token });
  let installing: Promise<unknown> | undefined;

  const launcher = launcherPath(options.extensionDir);
  const launchStamp = launchStampPath(options.home, launcher);
  // When this launcher was made the OpenCode CLI. On disk, so the restart prompt survives a service restart and the
  // unasked switch happens once: a CLI the user picks afterwards stays theirs.
  const switchStamp = `${launchStamp}.switched`;
  const findWritableSettings = () => options.settingsPath ?? openchamberSettingsPath(options.extensionDir);
  const readSettings = (settingsPath: string): { configured?: string; error?: string } => {
    try {
      const configured = configuredBinary(settingsPath);
      return configured === undefined ? {} : { configured };
    } catch (error) {
      return { error: `${settingsPath} could not be read: ${(error as Error).message}` };
    }
  };
  const activate = (settingsPath: string) => {
    const activated = activateLauncher(settingsPath, launcher, new Date(deps.now()));
    if (activated.backup !== undefined) writeStamp(switchStamp, deps.now());
    return activated;
  };
  const activateUnasked = () => {
    const settingsPath = findWritableSettings();
    if (settingsPath === undefined || runtimeState(options.paths, deps).state !== "ready") return;
    if (readStamp(switchStamp) !== undefined) return;
    try {
      const configured = configuredBinary(settingsPath);
      if (configured !== launcher && mayActivateUnasked(configured)) activate(settingsPath);
    } catch (error) {
      console.error(`antechamber: could not set the OpenCode CLI in ${settingsPath}: ${(error as Error).message}`);
    }
  };
  const install = () => {
    installing ??= ensureRuntime(options.paths, options.bun, deps)
      .then(() => {
        if (options.autoActivate) activateUnasked();
      })
      .catch(() => undefined)
      .finally(() => {
        installing = undefined;
      });
    return installing;
  };
  const status = (): RuntimeStatus => {
    const writableSettings = findWritableSettings();
    const settingsPath = writableSettings ?? openchamberSettingsPath(options.extensionDir, options.home);
    const current = runtimeState(options.paths, deps);
    const { configured, error } = settingsPath === undefined ? {} : readSettings(settingsPath);
    const settingsError = writableSettings === undefined ? undefined : error;
    const active = configured === launcher;
    const switchedAt = readStamp(switchStamp);
    const base = {
      state: installing && current.state !== "ready" ? "installing" : current.state,
      spec: options.paths.spec,
      launcher,
      bun: options.bun ?? null,
      settings: writableSettings ?? null,
      configured: configured?.trim() ? configured : null,
      active,
      ...(settingsError ? { settingsError } : {}),
      needsReload: active && switchedAt !== undefined && (readStamp(launchStamp) ?? 0) < switchedAt,
    } as const;
    if (current.state === "ready")
      return {
        ...base,
        antechamber: current.runtime.antechamber,
        dir: current.runtime.dir,
        ...(current.runtime.omo ? { omo: current.runtime.omo } : {}),
      };
    if (current.state === "failed" && !installing) return { ...base, error: current.error };
    if (!options.bun) return { ...base, state: "failed", error: "bun not found on PATH or in ~/.bun/bin" };
    return base;
  };
  if (options.prewarm && options.bun && runtimeState(options.paths, deps).state === "missing") void install();
  else if (options.autoActivate) activateUnasked();

  const expected = Buffer.from(`Bearer ${options.token}`);
  const send = (res: http.ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };
  return createHttpServer((req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? "");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
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
    if (pathname === "/runtime/activate" && req.method === "POST") {
      req.resume();
      const settingsPath = findWritableSettings();
      if (settingsPath === undefined)
        return send(res, 409, {
          error: "settings-not-found",
          detail: "Set Settings -> General -> OpenCode CLI to the launcher by hand.",
        });
      if (runtimeState(options.paths, deps).state !== "ready") return send(res, 409, { error: "runtime-not-ready" });
      const unreadable = readSettings(settingsPath).error;
      if (unreadable) return send(res, 409, { error: "settings-unreadable", detail: unreadable });
      const activated = activate(settingsPath);
      return send(res, 200, { ...status(), ...activated });
    }
    return send(res, 404, { error: "not-found" });
  });
}
