/** HTTP/SSE composition root for the OpenCode API backed by pi. */

import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { disposeMcpAgents, mcpSurfacesChanged } from "./mcp.js";
import { debugLog } from "./misc-routes.js";
import { SessionManager } from "./sessions.js";
import type { TodoUpdated } from "./todo-bridge.js";
import { loadCatalog, type Catalog } from "./catalog.js";
import type { OCEvent } from "./types.js";
import { Http } from "./http.js";
import { SSE, type SSESubscriber } from "./sse.js";
import { handleV1 } from "./routes-v1.js";
import { handleV2 } from "./routes-v2.js";
import type { RouteServices } from "./route-services.js";
import { type SelfUpdateResult, selfUpdate } from "./self-update.js";
import { handleWorkStatus } from "./work-status.js";

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
  private actualPort: number | undefined;
  /** Bearer token for the `/antechamber/work-status` routes, published in the run record for the OmO Work extension. */
  readonly extensionToken = randomBytes(32).toString("base64url");
  private readonly http = new Http(() => this.url, this.extensionToken);

  constructor(private options: AdapterServerOptions) {
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

  private catalog(): Promise<Catalog> {
    this.catalogPromise ??= loadCatalog(this.options.defaultDirectory).catch((err) => {
      this.catalogPromise = undefined;
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
      catalog: () => this.catalog(),
      broadcast: (dir, event) => this.broadcast(dir, event),
      selfUpdate: this.options.selfUpdate ?? (() => selfUpdate()),
    };
    if (path === "/api" || path.startsWith("/api/")) {
      await handleV2(services, req, res, url, path, method, directory);
      return;
    }
    await handleV1(services, req, res, url, path, method, directory);
  }
}
