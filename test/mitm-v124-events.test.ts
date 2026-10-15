import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { AdapterServer } from "../src/server.js";

const turnRpc = resolve("test/fixtures/turn-omo.mjs");
const golden = JSON.parse(readFileSync(resolve("test/fixtures/mitm-v124/events-global.json"), "utf8")) as {
  event: { body: { payload: { type: string } } };
};

type SseRecord = { id: string | undefined; data: Record<string, unknown> };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

function expectRecord(value: unknown, message: string): Record<string, unknown> {
  assert.ok(isRecord(value), message);
  return value as Record<string, unknown>;
}

async function startServer(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "antechamber-mitm-v124-events-"));
  const saved = new Map(
    ["ANTECHAMBER_PI_BINARY", "ANTECHAMBER_STATE_DIR", "PI_CODING_AGENT_DIR"].map((key) => [key, process.env[key]]),
  );
  process.env.ANTECHAMBER_PI_BINARY = turnRpc;
  process.env.ANTECHAMBER_STATE_DIR = join(directory, "state");
  process.env.PI_CODING_AGENT_DIR = join(directory, "pi");
  const server = new AdapterServer({ host: "127.0.0.1", port: 0, defaultDirectory: directory });
  t.after(async () => {
    await server.stop();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  await server.start();
  return { directory, url: server.url };
}

async function openGlobalEvents(url: string) {
  const controller = new AbortController();
  const response = await fetch(`${url}/global/event`, {
    headers: { accept: "text/event-stream" },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  if (!response.body) throw new TypeError("expected an SSE body");

  const records: SseRecord[] = [];
  const bus = new EventEmitter();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const consume = (text: string) => {
    buffer += text;
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary < 0) return;
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!data) continue;
      const parsed: unknown = JSON.parse(data);
      if (!isRecord(parsed)) continue;
      const id = frame
        .split("\n")
        .find((line) => line.startsWith("id:"))
        ?.slice(3)
        .trim();
      const record = { id, data: parsed };
      records.push(record);
      bus.emit("record", record);
    }
  };
  const reading = (async () => {
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) return;
        consume(decoder.decode(next.value, { stream: true }));
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  })();
  void reading.catch((error: unknown) => {
    if (!controller.signal.aborted) throw error;
  });

  return {
    wait(predicate: (record: SseRecord) => boolean): Promise<SseRecord> {
      const existing = records.find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolveRecord, rejectRecord) => {
        const timeout = AbortSignal.timeout(5_000);
        const listener = (record: SseRecord) => {
          if (!predicate(record)) return;
          timeout.removeEventListener("abort", expired);
          bus.off("record", listener);
          resolveRecord(record);
        };
        const expired = () => {
          bus.off("record", listener);
          rejectRecord(new Error("global SSE record deadline"));
        };
        timeout.addEventListener("abort", expired, { once: true });
        bus.on("record", listener);
      });
    },
    async close() {
      controller.abort();
      await reading;
    },
  };
}

function eventPayload(record: SseRecord): Record<string, unknown> | undefined {
  return isRecord(record.data.payload) ? record.data.payload : undefined;
}

test("MITM124-01: global v1 events preserve captured payload identities", { timeout: 10_000 }, async (t) => {
  const { directory, url } = await startServer(t);
  const stream = await openGlobalEvents(url);
  t.after(() => stream.close());

  const created = stream.wait((record) => eventPayload(record)?.type === golden.event.body.payload.type);
  const response = await fetch(`${url}/session?directory=${encodeURIComponent(directory)}`, {
    method: "POST",
    headers: { accept: "application/json" },
  });
  assert.equal(response.status, 200);

  const record = await created;
  const payload = expectRecord(eventPayload(record), "global v1 payload must be an object");
  const properties = expectRecord(payload.properties, "global v1 payload properties must be an object");
  const info = expectRecord(properties.info, "session-created info must be an object");
  assert.equal(typeof record.id, "string");
  assert.equal(typeof record.data.directory, "string");
  assert.equal(typeof record.data.project, "string");
  assert.equal(typeof payload.id, "string");
  assert.equal(payload.type, golden.event.body.payload.type);
  assert.equal(typeof properties.sessionID, "string");
  assert.equal(typeof info.id, "string");
});
