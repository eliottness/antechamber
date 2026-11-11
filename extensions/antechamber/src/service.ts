import { timingSafeEqual } from "node:crypto";
import type http from "node:http";
import { createServer as createHttpServer } from "node:http";
import { join } from "node:path";
import { createServer as createGraphServer } from "./graph/routes.ts";
import {
  defaultDeps,
  ensureRuntime,
  type InstallDeps,
  type RuntimePaths,
  type RuntimeState,
  runtimeState,
} from "./runtime/runtime.ts";
import { createServer as createWorkServer } from "./work/routes.ts";

export interface ServiceOptions {
  readonly token: string;
  readonly extensionDir: string;
  readonly paths: RuntimePaths;
  readonly bun: string | undefined;
  readonly deps?: InstallDeps;
  /** Install the runtime as soon as the service starts, so OpenChamber's first launch finds it ready. */
  readonly prewarm?: boolean;
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

  const install = () => {
    installing ??= ensureRuntime(options.paths, options.bun, deps)
      .catch(() => undefined)
      .finally(() => {
        installing = undefined;
      });
    return installing;
  };
  const status = (): RuntimeStatus => {
    const current = runtimeState(options.paths, deps);
    const base = {
      state: installing && current.state !== "ready" ? "installing" : current.state,
      spec: options.paths.spec,
      launcher: join(options.extensionDir, "bin", "opencode-antechamber"),
      bun: options.bun ?? null,
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
    return send(res, 404, { error: "not-found" });
  });
}
