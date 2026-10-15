// allow: SIZE_OK — one executable owns the HTTP, SSE, and WebSocket relay state machines.
import { closeSync, openSync, writeFileSync, writeSync } from "node:fs";
import {
  createServer,
  request,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
} from "node:http";
import { homedir, hostname } from "node:os";
import { connect } from "node:net";

const CAPTURE_LIMIT_BYTES = 64 * 1024;
const SECRET_NAME = /(?:authorization|cookie|api[_-]?key|token|secret|password|credential|private[_-]?key)/i;
const URL_HOST = /(https?:\/\/)(?:\[[^\]]+\]|[^/:?#\s]+)/gi;
const BARE_HOST =
  /(^|[\s"'=:(,])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:ai|app|co|com|corp|dev|home|internal|io|lan|local|net|org|uk|us)(?=$|[\s"',;:)])/gi;

type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
type EventKind = "request" | "response" | "sse" | "ws";
type SanitizedHeaders = { readonly [name: string]: string | string[] };

interface Options {
  readonly hostname: string;
  readonly port: number;
  readonly upstreamPort: number;
  readonly readyFifo?: string;
}

interface Exchange {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly requestHeaders: SanitizedHeaders;
}

interface ResponseDetails {
  readonly status: number;
  readonly headers: SanitizedHeaders;
  readonly body: JsonValue;
}

interface CaptureEvent {
  readonly t: string;
  readonly kind: EventKind;
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly status: number | null;
  readonly headers: SanitizedHeaders;
  readonly body: JsonValue;
  readonly event?: string;
  readonly channel?: string;
  readonly direction?: "client-to-server" | "server-to-client";
  readonly opcode?: string;
  readonly fin?: boolean;
  readonly payloadBytes?: string;
}

class UsageError extends Error {
  readonly name = "UsageError";
}

class BodyCapture {
  private readonly chunks: Buffer[] = [];
  private capturedBytes = 0;
  private wasTruncated = false;

  add(chunk: Buffer): void {
    const remaining = CAPTURE_LIMIT_BYTES - this.capturedBytes;
    if (remaining <= 0) {
      this.wasTruncated = true;
      return;
    }
    if (chunk.length > remaining) {
      this.chunks.push(chunk.subarray(0, remaining));
      this.capturedBytes += remaining;
      this.wasTruncated = true;
      return;
    }
    this.chunks.push(chunk);
    this.capturedBytes += chunk.length;
  }

  remaining(): number {
    return Math.max(0, CAPTURE_LIMIT_BYTES - this.capturedBytes);
  }

  truncate(): void {
    this.wasTruncated = true;
  }

  body(): JsonValue {
    const text = Buffer.concat(this.chunks).toString("utf8");
    const suffix = this.wasTruncated ? "\n… [truncated at 64 KB]" : "";
    if (!text) return suffix;
    if (this.wasTruncated) return redactText(`${text}${suffix}`);
    try {
      const parsed: unknown = JSON.parse(text);
      return redactValue(parsed);
    } catch {
      return redactText(text);
    }
  }
}

class JsonlLogger {
  private readonly fileDescriptor: number;

  constructor(logPath: string) {
    this.fileDescriptor = openSync(logPath, "a", 0o600);
  }

  append(event: CaptureEvent): void {
    try {
      writeSync(this.fileDescriptor, `${JSON.stringify(event)}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`opencode-mitm: capture log write failed: ${message}\n`);
    }
  }

  close(): void {
    closeSync(this.fileDescriptor);
  }
}

class SseParser {
  private readonly onEvent: (eventName: string, body: JsonValue) => void;
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private eventName = "message";
  private readonly dataLines: string[] = [];

  constructor(onEvent: (eventName: string, body: JsonValue) => void) {
    this.onEvent = onEvent;
  }

  push(chunk: Buffer): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    this.consumeLines();
  }

  finish(): void {
    this.buffer += this.decoder.decode();
    this.consumeLines();
    if (this.buffer) {
      this.consumeLine(this.buffer.replace(/\r$/, ""));
      this.buffer = "";
    }
    this.emit();
  }

  private consumeLines(): void {
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      this.consumeLine(line);
    }
  }

  private consumeLine(line: string): void {
    if (!line) {
      this.emit();
      return;
    }
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "event") {
      this.eventName = value || "message";
    } else if (field === "data") {
      this.dataLines.push(value);
    }
  }

  private emit(): void {
    if (this.dataLines.length === 0) {
      this.eventName = "message";
      return;
    }
    const data = this.dataLines.join("\n");
    this.onEvent(this.eventName, parseTextBody(data));
    this.dataLines.length = 0;
    this.eventName = "message";
  }
}

interface FrameState {
  readonly fin: boolean;
  readonly opcode: number;
  readonly totalLength: bigint;
  readonly masked: boolean;
  readonly mask?: Buffer;
  readonly capture: BodyCapture;
  remaining: bigint;
  maskOffset: number;
}

interface WebSocketFrame {
  readonly fin: boolean;
  readonly opcode: string;
  readonly body: JsonValue;
  readonly payloadBytes: string;
}

class WebSocketParser {
  private readonly onFrame: (frame: WebSocketFrame) => void;
  private header = Buffer.alloc(0);
  private frame: FrameState | undefined;

  constructor(onFrame: (frame: WebSocketFrame) => void) {
    this.onFrame = onFrame;
  }

  push(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.frame) {
        offset = this.consumeHeader(chunk, offset);
        if (!this.frame) return;
      }
      offset = this.consumePayload(chunk, offset);
    }
  }

  private consumeHeader(chunk: Buffer, start: number): number {
    let offset = start;
    while (!this.frame && offset < chunk.length) {
      const expected = this.expectedHeaderBytes();
      const take = Math.min(expected - this.header.length, chunk.length - offset);
      this.header = Buffer.concat([this.header, chunk.subarray(offset, offset + take)]);
      offset += take;
      if (this.header.length < this.expectedHeaderBytes()) continue;
      this.frame = this.parseHeader();
      this.header = Buffer.alloc(0);
    }
    return offset;
  }

  private expectedHeaderBytes(): number {
    if (this.header.length < 2) return 2;
    const second = this.header.readUInt8(1);
    const lengthCode = second & 0x7f;
    const extendedBytes = lengthCode === 126 ? 2 : lengthCode === 127 ? 8 : 0;
    const maskBytes = second & 0x80 ? 4 : 0;
    return 2 + extendedBytes + maskBytes;
  }

  private parseHeader(): FrameState {
    const first = this.header.readUInt8(0);
    const second = this.header.readUInt8(1);
    const lengthCode = second & 0x7f;
    const masked = (second & 0x80) !== 0;
    const extendedBytes = lengthCode === 126 ? 2 : lengthCode === 127 ? 8 : 0;
    const payloadOffset = 2 + extendedBytes;
    const totalLength =
      lengthCode < 126
        ? BigInt(lengthCode)
        : lengthCode === 126
          ? BigInt(this.header.readUInt16BE(2))
          : this.header.readBigUInt64BE(2);
    const mask = masked ? this.header.subarray(payloadOffset, payloadOffset + 4) : undefined;
    const common = {
      fin: (first & 0x80) !== 0,
      opcode: first & 0x0f,
      totalLength,
      masked,
      capture: new BodyCapture(),
      remaining: totalLength,
      maskOffset: 0,
    };
    return mask ? { ...common, mask } : common;
  }

  private consumePayload(chunk: Buffer, start: number): number {
    const frame = this.frame;
    if (!frame) return start;
    const available = chunk.length - start;
    const take = frame.remaining > BigInt(available) ? available : Number(frame.remaining);
    const payload = chunk.subarray(start, start + take);
    this.capturePayload(frame, payload);
    frame.remaining -= BigInt(take);
    if (frame.remaining === 0n) {
      this.onFrame({
        fin: frame.fin,
        opcode: opcodeName(frame.opcode),
        body: frame.capture.body(),
        payloadBytes: frame.totalLength.toString(),
      });
      this.frame = undefined;
    }
    return start + take;
  }

  private capturePayload(frame: FrameState, payload: Buffer): void {
    const captureLength = Math.min(frame.capture.remaining(), payload.length);
    if (captureLength < payload.length) frame.capture.truncate();
    if (captureLength === 0) {
      frame.maskOffset = (frame.maskOffset + payload.length) % 4;
      return;
    }
    if (!frame.mask) {
      frame.capture.add(payload.subarray(0, captureLength));
      return;
    }
    const decoded = Buffer.allocUnsafe(captureLength);
    for (let index = 0; index < captureLength; index += 1) {
      decoded[index] = payload.readUInt8(index) ^ frame.mask.readUInt8((frame.maskOffset + index) % 4);
    }
    frame.maskOffset = (frame.maskOffset + payload.length) % 4;
    frame.capture.add(decoded);
  }
}

function parseOptions(args: readonly string[]): Options {
  let bindHostname = "";
  let port = 0;
  let upstreamPort = 0;
  let readyFifo = "";
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value) throw new UsageError(`missing value after ${flag}`);
    if (flag === "--hostname") bindHostname = value;
    else if (flag === "--port") port = parsePort(value, "--port");
    else if (flag === "--upstream-port") upstreamPort = parsePort(value, "--upstream-port");
    else if (flag === "--ready-fifo") readyFifo = value;
    else throw new UsageError(`unknown argument: ${flag}`);
    index += 1;
  }
  if (!bindHostname || !port || !upstreamPort) {
    throw new UsageError("usage: proxy.ts --hostname HOST --port PORT --upstream-port PORT [--ready-fifo PATH]");
  }
  return readyFifo
    ? { hostname: bindHostname, port, upstreamPort, readyFifo }
    : { hostname: bindHostname, port, upstreamPort };
}

function parsePort(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new UsageError(`${flag} must be an integer between 1 and 65535`);
  }
  return parsed;
}

function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name);
}

function redactText(value: string): string {
  const home = homedir();
  const localHostname = hostname();
  return value
    .replaceAll(home, "~")
    .replaceAll(localHostname, "[host]")
    .replace(URL_HOST, "$1[host]")
    .replace(BARE_HOST, "$1[host]")
    .replace(/\b(Bearer|Basic|Token)\s+[^\s,;]+/gi, "$1 [REDACTED]")
    .replace(
      /((?:api[_-]?key|token|secret|password|authorization|cookie|credential)\s*[:=]\s*["']?)[^,\s"'&}\]]+/gi,
      "$1[REDACTED]",
    )
    .replace(/([?&](?:api[_-]?key|token|secret|password|authorization|cookie|credential)=)[^&#\s]*/gi, "$1[REDACTED]");
}

function redactValue(value: unknown, key = ""): JsonValue {
  if (isSecretName(key)) return "[REDACTED]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (typeof value === "object") {
    const result: { [key: string]: JsonValue } = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      result[childKey] = redactValue(childValue, childKey);
    }
    return result;
  }
  return redactText(String(value));
}

function parseTextBody(text: string): JsonValue {
  if (!text) return "";
  try {
    const parsed: unknown = JSON.parse(text);
    return redactValue(parsed);
  } catch {
    return redactText(text);
  }
}

function redactHeaders(headers: IncomingHttpHeaders | OutgoingHttpHeaders): SanitizedHeaders {
  const sanitized: { [name: string]: string | string[] } = {};
  for (const [name, rawValue] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (isSecretName(normalized)) {
      sanitized[name] = "[REDACTED]";
    } else if (normalized === "host" || normalized === "x-forwarded-host") {
      sanitized[name] = "[host]";
    } else if (Array.isArray(rawValue)) {
      sanitized[name] = rawValue.map((value) => redactText(String(value)));
    } else if (rawValue !== undefined) {
      sanitized[name] = redactText(String(rawValue));
    }
  }
  return sanitized;
}

function exchangeFor(requestMessage: IncomingMessage, id: string): Exchange {
  const url = new URL(requestMessage.url ?? "/", "http://proxy.invalid");
  return {
    id,
    method: requestMessage.method ?? "GET",
    path: redactText(url.pathname),
    query: redactText(url.search.slice(1)),
    requestHeaders: redactHeaders(requestMessage.headers),
  };
}

function requestEvent(exchange: Exchange, body: JsonValue): CaptureEvent {
  return {
    t: new Date().toISOString(),
    kind: "request",
    id: exchange.id,
    method: exchange.method,
    path: exchange.path,
    query: exchange.query,
    status: null,
    headers: exchange.requestHeaders,
    body,
  };
}

function responseEvent(exchange: Exchange, details: ResponseDetails): CaptureEvent {
  return {
    t: new Date().toISOString(),
    kind: "response",
    id: exchange.id,
    method: exchange.method,
    path: exchange.path,
    query: exchange.query,
    status: details.status,
    headers: details.headers,
    body: details.body,
  };
}

function contentType(headers: IncomingHttpHeaders): string {
  const value = headers["content-type"];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function opcodeName(opcode: number): string {
  switch (opcode) {
    case 0:
      return "continuation";
    case 1:
      return "text";
    case 2:
      return "binary";
    case 8:
      return "close";
    case 9:
      return "ping";
    case 10:
      return "pong";
    default:
      return `opcode-${opcode}`;
  }
}

function rawUpgradeRequest(requestMessage: IncomingMessage): Buffer {
  const lines = [`${requestMessage.method ?? "GET"} ${requestMessage.url ?? "/"} HTTP/${requestMessage.httpVersion}`];
  for (let index = 0; index < requestMessage.rawHeaders.length; index += 2) {
    lines.push(`${requestMessage.rawHeaders[index]}: ${requestMessage.rawHeaders[index + 1] ?? ""}`);
  }
  return Buffer.from(`${lines.join("\r\n")}\r\n\r\n`);
}

function upgradeResponseDetails(rawHeader: Buffer): ResponseDetails {
  const lines = rawHeader.toString("latin1").split("\r\n");
  const statusMatch = /^HTTP\/\d\.\d\s+(\d+)/.exec(lines[0] ?? "");
  const headers: { [name: string]: string | string[] } = {};
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const name = line.slice(0, separator);
    const value = line.slice(separator + 1).trim();
    const previous = headers[name];
    if (typeof previous === "string") headers[name] = [previous, value];
    else if (Array.isArray(previous)) headers[name] = [...previous, value];
    else headers[name] = value;
  }
  return {
    status: statusMatch ? Number(statusMatch[1]) : 502,
    headers: redactHeaders(headers),
    body: "",
  };
}

function runProxy(options: Options): void {
  const logPath = process.env.OPENCODE_MITM_LOG;
  if (!logPath) throw new UsageError("OPENCODE_MITM_LOG must name the JSONL capture file");
  const logger = new JsonlLogger(logPath);
  let nextId = 1;
  const nextExchangeId = (): string => `mitm-${Date.now().toString(36)}-${nextId++}`;

  const server = createServer((clientRequest, clientResponse) => {
    const exchange = exchangeFor(clientRequest, nextExchangeId());
    const requestCapture = new BodyCapture();
    let requestLogged = false;
    let responseLogged = false;
    const logRequest = (): void => {
      if (requestLogged) return;
      requestLogged = true;
      logger.append(requestEvent(exchange, requestCapture.body()));
    };
    const logResponse = (details: ResponseDetails): void => {
      if (responseLogged) return;
      responseLogged = true;
      logger.append(responseEvent(exchange, details));
    };

    clientRequest.on("data", (chunk: Buffer) => requestCapture.add(chunk));
    clientRequest.once("end", logRequest);
    clientRequest.once("aborted", logRequest);

    const upstreamRequest = request(
      {
        host: "127.0.0.1",
        port: options.upstreamPort,
        method: clientRequest.method,
        path: clientRequest.url,
        headers: clientRequest.headers,
      },
      (upstreamResponse) => {
        const details = {
          status: upstreamResponse.statusCode ?? 502,
          headers: redactHeaders(upstreamResponse.headers),
        };
        clientResponse.writeHead(details.status, upstreamResponse.headers);
        if (contentType(upstreamResponse.headers).toLowerCase().startsWith("text/event-stream")) {
          logResponse({ ...details, body: "" });
          const parser = new SseParser((eventName, body) => {
            logger.append({
              t: new Date().toISOString(),
              kind: "sse",
              id: exchange.id,
              method: exchange.method,
              path: exchange.path,
              query: exchange.query,
              status: details.status,
              headers: details.headers,
              body,
              event: eventName,
            });
          });
          upstreamResponse.on("data", (chunk: Buffer) => parser.push(chunk));
          upstreamResponse.once("end", () => parser.finish());
        } else {
          const responseCapture = new BodyCapture();
          upstreamResponse.on("data", (chunk: Buffer) => responseCapture.add(chunk));
          upstreamResponse.once("end", () => logResponse({ ...details, body: responseCapture.body() }));
          upstreamResponse.once("error", (error) => {
            logResponse({ ...details, body: redactText(error.message) });
          });
        }
        upstreamResponse.pipe(clientResponse);
      },
    );

    upstreamRequest.once("error", (error) => {
      logRequest();
      const details = {
        status: 502,
        headers: { "content-type": "application/json" },
        body: redactText(error.message),
      };
      logResponse(details);
      if (!clientResponse.headersSent) {
        clientResponse.writeHead(502, { "content-type": "application/json" });
        clientResponse.end(JSON.stringify({ error: "OpenCode upstream unavailable" }));
      } else {
        clientResponse.destroy(error);
      }
    });
    clientResponse.once("close", () => upstreamRequest.destroy());
    clientRequest.pipe(upstreamRequest);
  });

  server.on("upgrade", (clientRequest, clientSocket, head) => {
    const exchange = exchangeFor(clientRequest, nextExchangeId());
    logger.append(requestEvent(exchange, ""));
    const upstreamSocket = connect({ host: "127.0.0.1", port: options.upstreamPort });
    let responseLogged = false;
    const logResponse = (details: ResponseDetails): void => {
      if (responseLogged) return;
      responseLogged = true;
      logger.append(responseEvent(exchange, details));
    };
    const closePair = (): void => {
      clientSocket.destroy();
      upstreamSocket.destroy();
    };

    upstreamSocket.once("error", (error) => {
      logResponse({
        status: 502,
        headers: { "content-type": "text/plain" },
        body: redactText(error.message),
      });
      closePair();
    });
    clientSocket.once("error", () => upstreamSocket.destroy());
    clientSocket.once("close", () => upstreamSocket.destroy());
    upstreamSocket.once("close", () => clientSocket.destroy());

    upstreamSocket.once("connect", () => {
      const clientParser = new WebSocketParser((frame) => {
        logger.append({
          t: new Date().toISOString(),
          kind: "ws",
          id: exchange.id,
          method: exchange.method,
          path: exchange.path,
          query: exchange.query,
          status: 101,
          headers: exchange.requestHeaders,
          body: frame.body,
          channel: exchange.path,
          direction: "client-to-server",
          opcode: frame.opcode,
          fin: frame.fin,
          payloadBytes: frame.payloadBytes,
        });
      });
      upstreamSocket.write(rawUpgradeRequest(clientRequest));
      if (head.length > 0) clientParser.push(head);
      clientSocket.on("data", (chunk: Buffer) => clientParser.push(chunk));
      clientSocket.pipe(upstreamSocket);
    });

    let handshake = Buffer.alloc(0);
    const onHandshake = (chunk: Buffer): void => {
      handshake = Buffer.concat([handshake, chunk]);
      const separator = handshake.indexOf("\r\n\r\n");
      if (separator < 0) {
        if (handshake.length > CAPTURE_LIMIT_BYTES) closePair();
        return;
      }
      const header = handshake.subarray(0, separator + 4);
      const remainder = handshake.subarray(separator + 4);
      clientSocket.write(handshake);
      const response = upgradeResponseDetails(header);
      logResponse(response);
      const serverParser = new WebSocketParser((frame) => {
        logger.append({
          t: new Date().toISOString(),
          kind: "ws",
          id: exchange.id,
          method: exchange.method,
          path: exchange.path,
          query: exchange.query,
          status: response.status,
          headers: response.headers,
          body: frame.body,
          channel: exchange.path,
          direction: "server-to-client",
          opcode: frame.opcode,
          fin: frame.fin,
          payloadBytes: frame.payloadBytes,
        });
      });
      if (remainder.length > 0) serverParser.push(remainder);
      upstreamSocket.off("data", onHandshake);
      upstreamSocket.on("data", (payload: Buffer) => serverParser.push(payload));
      upstreamSocket.pipe(clientSocket);
    };
    upstreamSocket.on("data", onHandshake);
  });

  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    server.close(() => {
      logger.close();
      process.exit(0);
    });
    server.closeAllConnections();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  server.once("error", (error) => {
    process.stderr.write(`opencode-mitm: proxy failed: ${error.message}\n`);
    logger.close();
    process.exitCode = 1;
  });
  server.listen(options.port, options.hostname, () => {
    process.stdout.write(`opencode server listening on http://${options.hostname}:${options.port}\n`);
    if (!options.readyFifo) return;
    try {
      writeFileSync(options.readyFifo, "ready\n");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`opencode-mitm: unable to signal launcher readiness: ${message}\n`);
      shutdown();
    }
  });
}

try {
  runProxy(parseOptions(process.argv.slice(2)));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`opencode-mitm: ${message}\n`);
  process.exitCode = 1;
}
