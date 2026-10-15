import { readFileSync } from "node:fs";

type EventKind = "request" | "response" | "sse" | "ws";
type ShapeMap = Map<string, Set<string>>;

interface CaptureLine {
  readonly kind: EventKind;
  readonly method: string;
  readonly path: string;
  readonly status: number | null;
  readonly body: unknown;
  readonly event?: string;
  readonly channel?: string;
  readonly direction?: string;
  readonly opcode?: string;
}

interface RouteStats {
  count: number;
  readonly statuses: Set<number>;
  readonly requestShape: ShapeMap;
  readonly responseShape: ShapeMap;
  requestExample: unknown | undefined;
  responseExample: unknown | undefined;
}

interface StreamStats {
  readonly shape: ShapeMap;
  example: unknown | undefined;
}

class UsageError extends Error {
  readonly name = "UsageError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function eventKind(value: unknown): EventKind | undefined {
  if (value === "request" || value === "response" || value === "sse" || value === "ws") return value;
  return undefined;
}

function parseLine(value: unknown): CaptureLine | undefined {
  if (!isRecord(value)) return undefined;
  const kind = eventKind(value.kind);
  const method = value.method;
  const path = value.path;
  if (!kind || typeof method !== "string" || typeof path !== "string") return undefined;
  const status = typeof value.status === "number" ? value.status : null;
  const event = typeof value.event === "string" ? value.event : undefined;
  const channel = typeof value.channel === "string" ? value.channel : undefined;
  const direction = typeof value.direction === "string" ? value.direction : undefined;
  const opcode = typeof value.opcode === "string" ? value.opcode : undefined;
  return {
    kind,
    method,
    path,
    status,
    body: value.body,
    ...(event ? { event } : {}),
    ...(channel ? { channel } : {}),
    ...(direction ? { direction } : {}),
    ...(opcode ? { opcode } : {}),
  };
}

function templatePath(path: string): string {
  return path
    .split("/")
    .map((segment) => (isIdentifierSegment(segment) ? ":id" : segment))
    .join("/");
}

function isIdentifierSegment(segment: string): boolean {
  return (
    /^\d+$/.test(segment) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(segment) ||
    /^(?:ses|msg|part|cmd|project|workspace|pty|terminal)_[A-Za-z0-9_-]+$/.test(segment) ||
    /^[A-Za-z0-9_-]{16,}$/.test(segment)
  );
}

function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function addShape(shape: ShapeMap, path: string, type: string): void {
  const types = shape.get(path);
  if (types) {
    types.add(type);
  } else {
    shape.set(path, new Set([type]));
  }
}

function childPath(parent: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

function collectShape(shape: ShapeMap, value: unknown, path = "$"): void {
  addShape(shape, path, valueType(value));
  if (Array.isArray(value)) {
    for (const entry of value) collectShape(shape, entry, `${path}[]`);
  } else if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) collectShape(shape, entry, childPath(path, key));
  }
}

function hasContent(value: unknown): boolean {
  return value !== "" && value !== undefined;
}

function routeStats(routes: Map<string, RouteStats>, key: string): RouteStats {
  const existing = routes.get(key);
  if (existing) return existing;
  const created: RouteStats = {
    count: 0,
    statuses: new Set(),
    requestShape: new Map(),
    responseShape: new Map(),
    requestExample: undefined,
    responseExample: undefined,
  };
  routes.set(key, created);
  return created;
}

function streamStats(streams: Map<string, StreamStats>, key: string): StreamStats {
  const existing = streams.get(key);
  if (existing) return existing;
  const created: StreamStats = { shape: new Map(), example: undefined };
  streams.set(key, created);
  return created;
}

function escapeMarkdown(value: string): string {
  return value.replaceAll("|", "\\|");
}

function renderShape(shape: ShapeMap): string {
  if (shape.size === 0) return "_No structured payload captured._\n";
  const lines = ["| Field path | Observed types |", "| --- | --- |"];
  for (const [path, types] of [...shape.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`| \`${escapeMarkdown(path)}\` | ${[...types].sort().join(" \\| ")} |`);
  }
  return `${lines.join("\n")}\n`;
}

function renderExample(value: unknown): string {
  const json = JSON.stringify(value, null, 2) ?? "null";
  const clipped = json.length > 2_000 ? `${json.slice(0, 2_000)}\n… [trimmed]` : json;
  return `\`\`\`json\n${clipped}\n\`\`\`\n`;
}

function sortedEntries<T>(entries: Iterable<[string, T]>): [string, T][] {
  return [...entries].sort(([left], [right]) => left.localeCompare(right));
}

function renderCatalog(
  logPath: string,
  routes: Map<string, RouteStats>,
  sseEvents: Map<string, StreamStats>,
  wsChannels: Map<string, StreamStats>,
): string {
  const output = [`# OpenCode MITM catalog`, "", `Source: \`${logPath}\``, ""];
  output.push("## Routes", "");
  if (routes.size === 0) {
    output.push("_No HTTP routes captured._", "");
  } else {
    for (const [route, stats] of sortedEntries(routes.entries())) {
      const statuses =
        stats.statuses.size === 0 ? "_no response_" : [...stats.statuses].sort((a, b) => a - b).join(", ");
      output.push(`### ${route}`, "", `- Captured requests: ${stats.count}`, `- Statuses: ${statuses}`, "");
      output.push(
        "#### Request fields",
        "",
        renderShape(stats.requestShape),
        "#### Response fields",
        "",
        renderShape(stats.responseShape),
      );
      output.push(
        "#### Example",
        "",
        renderExample({ request: stats.requestExample ?? null, response: stats.responseExample ?? null }),
      );
    }
  }
  output.push("## SSE events", "");
  if (sseEvents.size === 0) {
    output.push("_No SSE events captured._", "");
  } else {
    for (const [event, stats] of sortedEntries(sseEvents.entries())) {
      output.push(
        `### \`${escapeMarkdown(event)}\``,
        "",
        renderShape(stats.shape),
        "#### Example",
        "",
        renderExample(stats.example ?? null),
      );
    }
  }
  output.push("## WebSocket channels", "");
  if (wsChannels.size === 0) {
    output.push("_No WebSocket frames captured._", "");
  } else {
    for (const [channel, stats] of sortedEntries(wsChannels.entries())) {
      output.push(
        `### \`${escapeMarkdown(channel)}\``,
        "",
        renderShape(stats.shape),
        "#### Sample",
        "",
        renderExample(stats.example ?? null),
      );
    }
  }
  return `${output.join("\n")}\n`;
}

function buildCatalog(logPath: string): string {
  const routes = new Map<string, RouteStats>();
  const sseEvents = new Map<string, StreamStats>();
  const wsChannels = new Map<string, StreamStats>();
  const lines = readFileSync(logPath, "utf8").split(/\r?\n/);
  for (const [offset, rawLine] of lines.entries()) {
    if (!rawLine) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      process.stderr.write(`catalog: skipped invalid JSON at line ${offset + 1}\n`);
      continue;
    }
    const line = parseLine(parsed);
    if (!line) {
      process.stderr.write(`catalog: skipped unknown event at line ${offset + 1}\n`);
      continue;
    }
    const route = `${line.method} ${templatePath(line.path)}`;
    if (line.kind === "request") {
      const stats = routeStats(routes, route);
      stats.count += 1;
      if (hasContent(line.body)) collectShape(stats.requestShape, line.body);
      stats.requestExample ??= line.body;
    } else if (line.kind === "response") {
      const stats = routeStats(routes, route);
      if (line.status !== null) stats.statuses.add(line.status);
      if (hasContent(line.body)) collectShape(stats.responseShape, line.body);
      stats.responseExample ??= line.body;
    } else if (line.kind === "sse") {
      const stats = streamStats(sseEvents, line.event ?? "message");
      if (hasContent(line.body)) collectShape(stats.shape, line.body);
      stats.example ??= line.body;
    } else {
      const stats = streamStats(wsChannels, line.channel ?? templatePath(line.path));
      if (hasContent(line.body)) collectShape(stats.shape, line.body);
      stats.example ??= {
        direction: line.direction ?? null,
        opcode: line.opcode ?? null,
        body: line.body,
      };
    }
  }
  return renderCatalog(logPath, routes, sseEvents, wsChannels);
}

try {
  const logPath = process.argv[2] ?? process.env.OPENCODE_MITM_LOG;
  if (!logPath) throw new UsageError("usage: catalog.ts <capture.jsonl> (or set OPENCODE_MITM_LOG)");
  process.stdout.write(buildCatalog(logPath));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`catalog: ${message}\n`);
  process.exitCode = 1;
}
