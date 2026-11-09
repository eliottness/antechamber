/** HTTP/SSE composition root for the OpenCode API backed by pi. */

import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { basename, dirname, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { promisify } from "node:util";
import { disposeMcpAgents, mcpSurfacesChanged } from "./mcp.js";
import { debugLog } from "./misc-routes.js";
import { SessionManager } from "./sessions.js";
import type { TodoUpdated } from "./todo-bridge.js";
import { catalogFingerprint, loadCatalog, type Catalog } from "./catalog.js";
import type { OCEvent } from "./types.js";
import { Http } from "./http.js";
import { SSE, type SSESubscriber } from "./sse.js";
import { handleV1 } from "./routes-v1.js";
import { handleV2 } from "./routes-v2.js";
import type { RouteServices } from "./route-services.js";
import { type SelfUpdateResult, selfUpdate } from "./self-update.js";
import { handleWorkStatus } from "./work-status.js";
import { FileWatchRegistry } from "./file-watch.js";
import { getCommands } from "./session-commands.js";
import type { PiRpcClient } from "./pi-rpc.js";

export { isLoopbackHost, serverPassword } from "./http.js";

interface AdapterServerOptions {
  port: number;
  host: string;
  /** Fallback directory when requests carry no ?directory= param. */
  defaultDirectory: string;
  /** Replaces the npm self-update behind POST /global/upgrade (tests). */
  selfUpdate?: () => Promise<SelfUpdateResult>;
}

export class AdapterServer {
  private server: Server;
  private sessions: SessionManager;
  private sse: SSE;

  private sseClients = new Map<ServerResponse, SSESubscriber>();
  private webSocketClients = new Set<Duplex>();
  private webSocketEvents: Array<{ id: number; directory: string; payload: OCEvent | TodoUpdated }> = [];
  private nextWebSocketEventID = 0;
  private catalogPromise: Promise<Catalog> | undefined;
  private catalogExpiresAt = 0;
  private catalogColdExpiresAt = 0;
  private readonly commandSnapshots = new Map<string, Awaited<ReturnType<typeof getCommands>>>();
  private readonly commandColdReads = new Map<string, { expiresAt: number; promise: ReturnType<typeof getCommands> }>();
  private readonly branchSnapshots = new Map<string, string | undefined>();
  private readonly branchWatchers = new Map<string, Promise<FSWatcher | undefined>>();
  private readonly branchChecks = new Map<string, Promise<void>>();
  private readonly projectDirectories = new Set<string>();
  private readonly fileWatches = new FileWatchRegistry((directory, event) => this.broadcast(directory, event));
  private readonly pendingRefreshes = new Set<Promise<void>>();
  private stopping = false;
  private actualPort: number | undefined;
  /** Bearer token for the `/antechamber/work-status` routes, published in the run record for the OmO Work extension. */
  readonly extensionToken = randomBytes(32).toString("base64url");
  private readonly http = new Http(() => this.url, this.extensionToken);

  constructor(private options: AdapterServerOptions) {
    this.projectDirectories.add(options.defaultDirectory);
    this.sse = new SSE(options, this.sseClients, (id) => this.sessions.monitors.owns(id));
    this.sessions = new SessionManager(
      (directory, event) => this.broadcast(directory, event),
      undefined,
      options.defaultDirectory,
    );
    this.sessions.onMcpSurfacesChanged = () =>
      mcpSurfacesChanged((directory, event) => this.broadcast(directory, event));
    this.server = createServer((req, res) => void this.route(req, res));
    this.server.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket, head));
  }

  private catalog(
    directory = this.options.defaultDirectory,
    client?: PiRpcClient,
    mode: "cached" | "read" | "settled" = "cached",
  ): Promise<Catalog> {
    // A live session's agent can only refresh an existing snapshot: its get_state reports that session's
    // selected model, so the first snapshot (and the configured default) always comes from a fresh agent.
    const pi = this.catalogPromise === undefined ? undefined : (client ?? this.sessions.liveClient(directory));
    if (
      this.catalogPromise !== undefined &&
      (this.catalogExpiresAt === Infinity ||
        (mode !== "settled" &&
          (Date.now() < this.catalogExpiresAt ||
            (pi === undefined && (mode === "cached" || Date.now() < this.catalogColdExpiresAt)))))
    )
      return this.catalogPromise;
    const previous = this.catalogPromise;
    this.catalogExpiresAt = Infinity;
    this.catalogColdExpiresAt = Date.now() + 60_000;
    this.catalogPromise = (
      pi === undefined || previous === undefined
        ? loadCatalog(directory)
        : previous.then((last) => loadCatalog(directory, pi, last))
    )
      .then(async (current) => {
        this.catalogExpiresAt = Date.now() + 5_000;
        this.catalogColdExpiresAt = Date.now() + 60_000;
        if (previous !== undefined) {
          const last = await previous;
          if (catalogFingerprint(last) !== catalogFingerprint(current)) {
            this.broadcast(directory, { type: "provider.updated", properties: {} });
            this.broadcast(directory, { type: "model.updated", properties: {} });
          }
        }
        return current;
      })
      .catch((err: unknown) => {
        this.catalogExpiresAt = Date.now() + 5_000;
        console.error("[catalog] failed to load models from pi:", err);
        if (previous === undefined) {
          // An unsuccessful first read established no snapshot to rate-limit or refresh.
          this.catalogPromise = undefined;
          this.catalogColdExpiresAt = 0;
        }
        return previous ?? { providers: [], defaults: {} };
      });
    return this.catalogPromise;
  }

  private async commands(directory: string, client?: PiRpcClient, refresh = false): ReturnType<typeof getCommands> {
    const pi = client ?? this.sessions.liveClient(directory);
    const cold = this.commandColdReads.get(directory);
    if (pi === undefined && cold !== undefined && Date.now() < cold.expiresAt) return cold.promise;
    const request = getCommands(directory, pi, refresh);
    if (pi === undefined) this.commandColdReads.set(directory, { expiresAt: Date.now() + 60_000, promise: request });
    const commands = await request;
    const previous = this.commandSnapshots.get(directory);
    this.commandSnapshots.set(directory, commands);
    this.commandColdReads.set(directory, { expiresAt: Date.now() + 60_000, promise: Promise.resolve(commands) });
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(commands))
      this.broadcast(directory, { type: "command.updated", properties: {} });
    return commands;
  }

  private watchBranch(directory: string): Promise<FSWatcher | undefined> {
    const existing = this.branchWatchers.get(directory);
    if (existing !== undefined) return existing;
    const pending = promisify(execFile)("git", ["rev-parse", "--git-path", "HEAD"], {
      cwd: directory,
      timeout: 3000,
    })
      .then(({ stdout }) => {
        const head = resolve(directory, stdout.trim());
        const watcher = watch(dirname(head), (_event, name) => {
          if (this.stopping || (name !== null && name.toString() !== basename(head))) return;
          void this.vcsBranch(directory);
        });
        watcher.on("error", () => {
          watcher.close();
          this.branchWatchers.delete(directory);
        });
        watcher.unref();
        return watcher;
      })
      .catch(() => {
        this.branchWatchers.delete(directory);
        return undefined;
      });
    this.branchWatchers.set(directory, pending);
    return pending;
  }

  private vcsBranch(directory: string): Promise<string | undefined> {
    const pending = this.branchChecks.get(directory) ?? Promise.resolve();
    const current = pending.then(() => this.readBranch(directory));
    this.branchChecks.set(
      directory,
      current.then(() => undefined),
    );
    return current;
  }

  private async readBranch(directory: string): Promise<string | undefined> {
    await this.watchBranch(directory);
    let branch: string | undefined;
    try {
      const { stdout } = await promisify(execFile)("git", ["symbolic-ref", "--short", "HEAD"], {
        cwd: directory,
        timeout: 3000,
      });
      branch = stdout.trim() || undefined;
    } catch {
      branch = undefined;
    }
    if (this.branchSnapshots.has(directory) && this.branchSnapshots.get(directory) !== branch)
      this.broadcast(directory, {
        type: "vcs.branch.updated",
        properties: branch === undefined ? {} : { branch },
      });
    this.branchSnapshots.set(directory, branch);
    return branch;
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
    this.stopping = true;
    await Promise.all([...this.pendingRefreshes]);
    for (const watcher of await Promise.all(this.branchWatchers.values())) watcher?.close();
    this.branchWatchers.clear();
    await Promise.all(this.branchChecks.values());
    // Stop admission before ending SSE: its clients can reconnect while the
    // session RPC groups and private task hosts are still being disposed.
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.sse.close();
    this.fileWatches.close();
    for (const socket of this.webSocketClients) socket.destroy();
    this.webSocketClients.clear();
    try {
      await Promise.all([this.sessions.disposeAll(), disposeMcpAgents()]);
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
    if (event.type === "session.idle" && !this.stopping) {
      const session = this.sessions.get(event.properties.sessionID);
      if (session?.pi !== undefined) {
        const reads = [
          ...(this.catalogPromise === undefined ? [] : [this.catalog(session.info.directory, session.pi, "settled")]),
          ...(this.commandSnapshots.has(session.info.directory)
            ? [this.commands(session.info.directory, session.pi, true)]
            : []),
        ];
        if (reads.length > 0) {
          const refresh = Promise.all(reads)
            .then(() => undefined)
            .catch((error: unknown) => console.error("[catalog] live refresh failed:", error));
          this.pendingRefreshes.add(refresh);
          void refresh.finally(() => this.pendingRefreshes.delete(refresh));
        }
      }
    }
    if (event.type === "session.created" && !this.projectDirectories.has(directory)) {
      this.projectDirectories.add(directory);
      const now = Date.now();
      this.broadcast(directory, {
        type: "project.updated",
        properties: {
          id: directory,
          canonical: directory,
          time: { created: now, updated: now, active: now },
          sandboxes: [],
          vcs: "git",
        },
      });
    }
    this.sse.broadcast(directory, event);
    this.broadcastWebSocket(directory, event);
  }

  private writeSSE(res: ServerResponse, frame: string): boolean {
    return this.sse.writeSSE(res, frame);
  }

  private handleSSE(
    req: IncomingMessage,
    res: ServerResponse,
    flavor: "v1" | "v2",
    directory: string,
    global: boolean,
  ): void {
    const lastEventID = req.headers["last-event-id"];
    this.sse.handleSSE(
      res,
      { flavor, global, ...(global ? {} : { directory }) },
      Array.isArray(lastEventID) ? lastEventID[0] : lastEventID,
      this.writeSSE.bind(this),
    );
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, _head: Buffer): void {
    const url = new URL(req.url ?? "/", this.url);
    if (url.pathname !== "/api/global/event/ws") {
      this.rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    if (!this.http.allowsUpgrade(req)) {
      this.rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    const keyHeader = req.headers["sec-websocket-key"];
    const key = Array.isArray(keyHeader) ? keyHeader[0] : keyHeader;
    if (req.headers["sec-websocket-version"] !== "13" || typeof key !== "string") {
      this.rejectUpgrade(socket, 400, "Bad Request");
      return;
    }
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        "",
      ].join("\r\n"),
    );
    this.webSocketClients.add(socket);
    socket.once("close", () => this.webSocketClients.delete(socket));
    socket.once("error", () => this.webSocketClients.delete(socket));

    const cursor = Number(url.searchParams.get("lastEventId"));
    const replayReset =
      Number.isSafeInteger(cursor) && cursor >= 0 && cursor < this.nextWebSocketEventID - this.webSocketEvents.length;
    this.writeWebSocket(socket, { type: "ready", ...(replayReset ? { replayReset: true } : {}) });
    if (!Number.isSafeInteger(cursor) || cursor < 0) return;
    for (const event of this.webSocketEvents) {
      if (event.id > cursor) this.writeWebSocketEvent(socket, event);
    }
  }

  private rejectUpgrade(socket: Duplex, status: number, message: string): void {
    socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  }

  private broadcastWebSocket(directory: string, payload: OCEvent | TodoUpdated): void {
    const event = { id: ++this.nextWebSocketEventID, directory, payload };
    this.webSocketEvents.push(event);
    if (this.webSocketEvents.length > 1024) this.webSocketEvents.shift();
    for (const socket of this.webSocketClients) this.writeWebSocketEvent(socket, event);
  }

  private writeWebSocketEvent(
    socket: Duplex,
    event: { id: number; directory: string; payload: OCEvent | TodoUpdated },
  ): void {
    this.writeWebSocket(socket, {
      type: "event",
      eventId: String(event.id),
      directory: event.directory,
      scope: "global",
      payload: event.payload,
    });
  }

  private writeWebSocket(socket: Duplex, frame: Record<string, unknown>): void {
    if (socket.destroyed || !socket.writable) {
      this.webSocketClients.delete(socket);
      return;
    }
    const payload = Buffer.from(JSON.stringify(frame));
    const header =
      payload.length < 126
        ? Buffer.from([0x81, payload.length])
        : payload.length <= 0xffff
          ? Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff])
          : (() => {
              const value = Buffer.alloc(10);
              value[0] = 0x81;
              value[1] = 127;
              value.writeBigUInt64BE(BigInt(payload.length), 2);
              return value;
            })();
    socket.write(Buffer.concat([header, payload]));
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
    const directoryQuery =
      url.searchParams.get("directory") ??
      url.searchParams.get("location[directory]") ??
      url.searchParams.get("location");
    const directoryHeader = req.headers["x-opencode-directory"];
    const encodedDirectory = Array.isArray(directoryHeader) ? directoryHeader[0] : directoryHeader;
    const directoryEncodingHeader = req.headers["x-opencode-directory-encoding"];
    const directoryEncoding = Array.isArray(directoryEncodingHeader)
      ? directoryEncodingHeader[0]
      : directoryEncodingHeader;
    let headerDirectory = encodedDirectory;
    if (
      encodedDirectory !== undefined &&
      (directoryEncoding?.toLowerCase() === "uri" || /^(?:%|[a-z]%3a)/i.test(encodedDirectory))
    ) {
      headerDirectory = decodeURIComponent(encodedDirectory);
    }
    const directory = directoryQuery ?? headerDirectory ?? this.options.defaultDirectory;

    // SSE stream (v2 clients subscribe at /api/event; v1 at /event)
    if (method === "GET" && (path === "/event" || path === "/global/event")) {
      this.handleSSE(req, res, "v1", directory, path === "/global/event");
      return;
    }
    if (method === "GET" && path === "/api/event") {
      // OpenChamber 2.3.2 opens one unscoped /api/event as its global hub (captured);
      // only an explicit directory selector scopes the stream.
      this.handleSSE(req, res, "v2", directory, directoryQuery === null && headerDirectory === undefined);
      return;
    }

    if (path.startsWith("/antechamber/work-status/")) {
      await handleWorkStatus(this.sessions, req, res, url, method);
      return;
    }

    const services: RouteServices = {
      sessions: this.sessions,
      defaultDirectory: this.options.defaultDirectory,
      url: this.url,
      body: (request) => this.http.body(request),
      catalog: (dir, refresh) => this.catalog(dir, undefined, refresh === true ? "read" : "cached"),
      broadcast: (dir, event) => this.broadcast(dir, event),
      selfUpdate: this.options.selfUpdate ?? (() => selfUpdate()),
      fileWatches: this.fileWatches,
      commands: (dir) => this.commands(dir),
      vcsBranch: (dir) => this.vcsBranch(dir),
    };
    if (path === "/api" || path.startsWith("/api/")) {
      await handleV2(services, req, res, url, path, method, directory);
      return;
    }
    await handleV1(services, req, res, url, path, method, directory);
  }
}
