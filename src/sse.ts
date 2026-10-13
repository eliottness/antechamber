/** SSE subscriptions, protocol framing, heartbeats, and backpressure. */

import type { ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { errorBody, json } from "./http.js";
import type { OCEvent } from "./types.js";
import type { TodoUpdated } from "./todo-bridge.js";
import { V2EventTranslator } from "./v2.js";

const MAX_SSE_SUBSCRIBERS = 64;
const MAX_SSE_PENDING_BYTES = 8 * 1024 * 1024;

export class SSE {
  private v2events = new V2EventTranslator();

  constructor(
    private options: { defaultDirectory: string },
    /** SSE subscribers tagged by protocol flavor: v1 (`/event`) or v2 (`/api/event`). */
    readonly clients: Map<ServerResponse, "v1" | "v2">,
  ) {}

  close(): void {
    for (const res of this.clients.keys()) {
      this.clients.delete(res);
      res.end();
    }
  }

  broadcast(_directory: string, event: OCEvent | TodoUpdated): void {
    const v1Frame = `data: ${JSON.stringify(event)}\n\n`;
    const frames =
      event.type === "todo.updated"
        ? [{ id: `evt_${randomUUID()}`, type: event.type, location: { directory: _directory }, data: event.properties }]
        : this.v2events.translate(_directory, event);
    const v2Frames = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`);
    for (const [res, flavor] of this.clients) {
      if (res.writableEnded || res.destroyed) {
        this.clients.delete(res);
        continue;
      }
      if (flavor === "v2") {
        for (const frame of v2Frames) {
          if (!this.writeSSE(res, frame)) break;
        }
      } else {
        this.writeSSE(res, v1Frame);
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

  handleSSE(res: ServerResponse, flavor: "v1" | "v2", write: (res: ServerResponse, frame: string) => boolean): void {
    if (this.clients.size >= MAX_SSE_SUBSCRIBERS) {
      json(res, 503, errorBody("ServiceUnavailableError", "Too many SSE subscribers"));
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    this.clients.set(res, flavor);
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
      flavor === "v2"
        ? {
            id: `evt_${Date.now()}`,
            created: Date.now(),
            type: "server.connected",
            location: { directory: this.options.defaultDirectory },
            data: {},
          }
        : { type: "server.connected", properties: {} };
    write(res, `data: ${JSON.stringify(connected)}\n\n`);
  }
}
