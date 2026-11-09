import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import { AdapterServer } from "../src/server.js";

const fixture = resolve("test/fixtures/fake-omo-endpoints.mjs");

export function record(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value))
    return Object.fromEntries(Object.entries(value));
  throw new Error("Expected an object");
}

export function spawnCount(path: string): number {
  return readFileSync(path, "utf8").trim().split("\n").length;
}

export async function serverFor(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "antechamber-catalog-"));
  const saved = new Map(
    [
      "ANTECHAMBER_PI_BINARY",
      "ANTECHAMBER_STATE_DIR",
      "OMO_CODING_AGENT_DIR",
      "SENPI_CODING_AGENT_DIR",
      "PI_CODING_AGENT_DIR",
      "FAKE_OMO_SPAWN_LOG",
    ].map((key) => [key, process.env[key]]),
  );
  const spawnLog = join(root, "spawns.log");
  process.env.FAKE_OMO_SPAWN_LOG = spawnLog;
  process.env.ANTECHAMBER_PI_BINARY = fixture;
  process.env.ANTECHAMBER_STATE_DIR = join(root, "state");
  for (const key of ["OMO_CODING_AGENT_DIR", "SENPI_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR"])
    process.env[key] = join(root, "agent");
  const server = new AdapterServer({ host: "127.0.0.1", port: 0, defaultDirectory: root });
  await server.start();
  t.after(async () => {
    await server.stop();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, url: server.url, spawnLog };
}

type CatalogEvent = { type: string; data: Record<string, unknown> };

export async function events(t: TestContext, url: string) {
  const controller = new AbortController();
  const response = await fetch(`${url}/api/event`, { signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("Missing SSE response body");
  await reader.read();
  const bus = new EventEmitter();
  const seen: CatalogEvent[] = [];
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        buffer += decoder.decode(chunk.value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          if (frame.startsWith(": heartbeat")) {
            bus.emit("heartbeat");
            continue;
          }
          const line = frame.split("\n").find((part) => part.startsWith("data: "));
          if (!line) continue;
          const value: unknown = JSON.parse(line.slice(6));
          const event = record(value);
          if (typeof event.type !== "string") continue;
          const item = { type: event.type, data: record(event.data) };
          seen.push(item);
          bus.emit("event", item);
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) bus.emit("error", error);
    }
  })();
  t.after(() => controller.abort());
  return {
    count: (type: string) => seen.filter((event) => event.type === type).length,
    wait(type: string, deadline = 5000, afterCount = 0): Promise<CatalogEvent> {
      const previous = seen.filter((event) => event.type === type)[afterCount];
      if (previous !== undefined) return Promise.resolve(previous);
      return new Promise((resolveEvent, reject) => {
        const timer = setTimeout(() => {
          bus.off("event", onEvent);
          reject(new Error(`missing ${type} event`));
        }, deadline);
        const onEvent = (event: CatalogEvent) => {
          if (event.type !== type || seen.filter((item) => item.type === type).length <= afterCount) return;
          clearTimeout(timer);
          bus.off("event", onEvent);
          resolveEvent(event);
        };
        bus.on("event", onEvent);
      });
    },
    heartbeat(): Promise<void> {
      return new Promise((resolveBeat, reject) => {
        const timer = setTimeout(() => {
          bus.off("heartbeat", onBeat);
          reject(new Error("missing SSE heartbeat"));
        }, 12_000);
        const onBeat = () => {
          clearTimeout(timer);
          resolveBeat();
        };
        bus.once("heartbeat", onBeat);
      });
    },
  };
}
