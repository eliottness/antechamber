/** HTTP/SSE composition root for the OpenCode API backed by pi. */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { debugLog } from "./misc-routes.js";
import { SessionManager } from "./sessions.js";
import type { TodoUpdated } from "./todo-bridge.js";
import { loadCatalog, type Catalog } from "./catalog.js";
import type { OCEvent } from "./types.js";
import { Http } from "./http.js";
import { SSE } from "./sse.js";
import { handleV1 } from "./routes-v1.js";
import { handleV2 } from "./routes-v2.js";
import type { RouteServices } from "./route-services.js";

export { isLoopbackHost, serverPassword } from "./http.js";

export interface AdapterServerOptions {
  port: number;
  host: string;
  /** Fallback directory when requests carry no ?directory= param. */
  defaultDirectory: string;
}

export class AdapterServer {
  private server: Server;
  private sessions: SessionManager;
  private sse: SSE;

  private sseClients = new Map<ServerResponse, "v1" | "v2">();
  private catalogPromise: Promise<Catalog> | undefined;
  private actualPort: number | undefined;
  private readonly http = new Http();

  constructor(private options: AdapterServerOptions) {
    this.sse = new SSE(options, this.sseClients);
    this.sessions = new SessionManager(
      (directory, event) => this.broadcast(directory, event),
      undefined,
      options.defaultDirectory,
    );
    this.server = createServer((req, res) => void this.route(req, res));
  }

  private catalog(): Promise<Catalog> {
    this.catalogPromise ??= loadCatalog(this.options.defaultDirectory).catch((err) => {
      console.error("[catalog] failed to load models from pi:", err);
      return { providers: [], defaults: {} };
    });
    return this.catalogPromise;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port, this.options.host, () => resolve());
    });
    const addr = this.server.address();
    this.actualPort = typeof addr === "object" && addr !== null ? addr.port : this.options.port;
  }

  get url(): string {
    const port = this.actualPort ?? this.options.port;
    const host =
      this.options.host.includes(":") && !this.options.host.startsWith("[")
        ? `[${this.options.host}]`
        : this.options.host;
    return `http://${host}:${port}`;
  }

  async stop(): Promise<void> {
    // Stop admission before ending SSE: its clients can reconnect while the
    // session RPC groups and private task hosts are still being disposed.
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.sse.close();
    try {
      await this.sessions.disposeAll();
    } finally {
      // An in-flight HTTP request must not hold shutdown open after teardown.
      this.server.closeAllConnections();
      await closed;
    }
  }

  // ---------------------------------------------------------------
  // SSE
  // ---------------------------------------------------------------

  private broadcast(directory: string, event: OCEvent | TodoUpdated): void {
    this.sse.broadcast(directory, event);
  }

  private writeSSE(res: ServerResponse, frame: string): boolean {
    return this.sse.writeSSE(res, frame);
  }

  private handleSSE(res: ServerResponse, flavor: "v1" | "v2"): void {
    this.sse.handleSSE(res, flavor, this.writeSSE.bind(this));
  }

  // ---------------------------------------------------------------
  // Router
  // ---------------------------------------------------------------

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    debugLog(`[http] ${req.method} ${(req.url ?? "/").split("?")[0]}`);
    await this.http.route(req, res, () => this.handle(req, res));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";
    const directory =
      url.searchParams.get("directory") ??
      url.searchParams.get("location[directory]") ??
      url.searchParams.get("location") ??
      (req.headers["x-opencode-directory"] as string | undefined) ??
      this.options.defaultDirectory;

    // SSE stream (v2 clients subscribe at /api/event; v1 at /event)
    if (method === "GET" && (path === "/event" || path === "/global/event")) {
      this.handleSSE(res, "v1");
      return;
    }
    if (method === "GET" && path === "/api/event") {
      this.handleSSE(res, "v2");
      return;
    }

    const services: RouteServices = {
      sessions: this.sessions,
      defaultDirectory: this.options.defaultDirectory,
      url: this.url,
      body: (request) => this.http.body(request),
      catalog: () => this.catalog(),
      broadcast: (dir, event) => this.broadcast(dir, event),
    };
    if (path === "/api" || path.startsWith("/api/")) {
      await handleV2(services, req, res, url, path, method, directory);
      return;
    }
    await handleV1(services, req, res, url, path, method, directory);
  }
}
