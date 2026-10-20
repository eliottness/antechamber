/** SSE subscriptions, protocol framing, heartbeats, and backpressure. */

import type { ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { errorBody, json } from "./http.js";
import type { OCEvent } from "./types.js";
import type { TodoUpdated } from "./todo-bridge.js";
import { V2EventTranslator } from "./v2.js";

const MAX_SSE_SUBSCRIBERS = 64;
const MAX_SSE_PENDING_BYTES = 8 * 1024 * 1024;
const MAX_SSE_REPLAY_RECORDS = 1024;

export type SSESubscriber = {
  flavor: "v1" | "v2";
  directory?: string;
  global: boolean;
};

type ReplayRecord = {
  id: number;
  directory: string;
  v1?: OCEvent | TodoUpdated;
  v2?: unknown;
};

/** The session an event belongs to, when it names one. */
export function eventSessionID(event: OCEvent | TodoUpdated): string | undefined {
  const properties = event.properties as Record<string, unknown>;
  const nested = (key: "info" | "part"): unknown => {
    const value = properties[key];
    return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  };
  if (event.type === "session.created" || event.type === "session.updated" || event.type === "session.deleted")
    return event.properties.info.id;
  const info = nested("info") as Record<string, unknown> | undefined;
  const part = nested("part") as Record<string, unknown> | undefined;
  const id = properties.sessionID ?? info?.sessionID ?? part?.sessionID;
  return typeof id === "string" ? id : undefined;
}

export class SSE {
  private v2events = new V2EventTranslator();
  private nextEventID = 0;
  private replay: ReplayRecord[] = [];

  constructor(
    private options: { defaultDirectory: string },
    /** SSE subscribers tagged by protocol flavor and explicit directory scope. */
    readonly clients: Map<ServerResponse, SSESubscriber>,
    /** Sessions v2 clients must not see (OmO monitor children, shown by the OmO Work section). */
    private hiddenFromV2: (sessionID: string) => boolean = () => false,
  ) {}

  close(): void {
    for (const res of this.clients.keys()) {
      this.clients.delete(res);
      res.end();
    }
  }

  broadcast(directory: string, event: OCEvent | TodoUpdated): void {
    const hidden = this.hiddenFromV2(eventSessionID(event) ?? "");
    const v2Frames = hidden
      ? []
      : event.type === "todo.updated"
        ? [{ id: `evt_${randomUUID()}`, type: event.type, location: { directory }, data: event.properties }]
        : this.v2events.translate(directory, event);
    const records =
      v2Frames.length === 0
        ? [this.record(directory, { v1: event })]
        : v2Frames.map((v2, index) => this.record(directory, index === 0 ? { v1: event, v2 } : { v2 }));
    for (const record of records) this.retain(record);
    for (const [res, subscriber] of this.clients) {
      if (res.writableEnded || res.destroyed) {
        this.clients.delete(res);
        continue;
      }
      for (const record of records) {
        if (!subscriber.global && subscriber.directory !== directory) continue;
        if (!this.writeRecord(res, subscriber, record)) break;
      }
    }
  }

  writeSSE(res: ServerResponse, frame: string): boolean {
    if (res.writableEnded || res.destroyed) {
      this.clients.delete(res);
      return false;
    }
    if (res.writableLength + Buffer.byteLength(frame) <= MAX_SSE_PENDING_BYTES) {
      res.write(frame);
      if (res.writableLength <= MAX_SSE_PENDING_BYTES) return true;
    }
    this.clients.delete(res);
    res.destroy();
    return false;
  }

  handleSSE(
    res: ServerResponse,
    subscriber: SSESubscriber,
    lastEventID: string | undefined,
    write: (res: ServerResponse, frame: string) => boolean,
  ): void {
    if (this.clients.size >= MAX_SSE_SUBSCRIBERS) {
      json(res, 503, errorBody("ServiceUnavailableError", "Too many SSE subscribers"));
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    this.clients.set(res, subscriber);
    // OpenChamber's SSE proxy aborts an upstream that is silent for 20s, so
    // mirror real opencode's `: heartbeat` comment keepalive.
    const heartbeat = setInterval(() => {
      write(res, ": heartbeat\n\n");
    }, 10_000);
    heartbeat.unref?.();
    res.on("close", () => {
      clearInterval(heartbeat);
      this.clients.delete(res);
    });
    // OpenCode emits server.connected on subscribe; OpenChamber waits for it.
    const connected =
      subscriber.flavor === "v2"
        ? {
            id: `evt_${Date.now()}`,
            created: Date.now(),
            type: "server.connected",
            location: { directory: subscriber.directory ?? this.options.defaultDirectory },
            data: {},
          }
        : { type: "server.connected", properties: {} };
    const initial =
      subscriber.flavor === "v1" && subscriber.global
        ? {
            directory: subscriber.directory ?? this.options.defaultDirectory,
            payload: { id: `evt_${randomUUID()}`, ...connected },
          }
        : connected;
    write(res, `data: ${JSON.stringify(initial)}\n\n`);
    const cursor = Number(lastEventID);
    if (!Number.isSafeInteger(cursor) || cursor < 0) return;
    for (const record of this.replay) {
      if (record.id > cursor && !this.writeRecord(res, subscriber, record)) break;
    }
  }

  private record(directory: string, frames: Omit<ReplayRecord, "id" | "directory">): ReplayRecord {
    return { id: ++this.nextEventID, directory, ...frames };
  }

  private retain(record: ReplayRecord): void {
    this.replay.push(record);
    if (this.replay.length > MAX_SSE_REPLAY_RECORDS) this.replay.shift();
  }

  private writeRecord(res: ServerResponse, subscriber: SSESubscriber, record: ReplayRecord): boolean {
    if (!subscriber.global && subscriber.directory !== record.directory) return true;
    const data =
      subscriber.flavor === "v2"
        ? record.v2
        : record.v1 === undefined
          ? undefined
          : subscriber.global
            ? {
                directory: record.directory,
                project: record.directory,
                payload: {
                  id: `evt_${record.id}`,
                  ...record.v1,
                  properties: {
                    ...record.v1.properties,
                    ...(record.v1.type === "session.created" ||
                    record.v1.type === "session.updated" ||
                    record.v1.type === "session.deleted"
                      ? { sessionID: record.v1.properties.info.id }
                      : {}),
                  },
                },
              }
            : record.v1;
    if (data === undefined) return true;
    const frame =
      subscriber.flavor === "v1" && !subscriber.global
        ? `data: ${JSON.stringify(data)}\n\n`
        : `id: ${record.id}\ndata: ${JSON.stringify(data)}\n\n`;
    return this.writeSSE(res, frame);
  }
}
