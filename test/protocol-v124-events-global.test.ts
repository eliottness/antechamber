import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { AdapterServer } from "../src/server.js";

const turnRpc = resolve("test/fixtures/turn-omo.mjs");

type SseRecord = { id: string | undefined; data: Record<string, unknown> };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

function payloadOf(record: SseRecord): Record<string, unknown> {
  return isRecord(record.data.payload) ? record.data.payload : record.data;
}

function eventType(record: SseRecord): string | undefined {
  const payload = payloadOf(record);
  return typeof payload.type === "string" ? payload.type : undefined;
}

function messageIDOf(record: SseRecord): string | undefined {
  const properties = payloadOf(record).properties;
  if (!isRecord(properties) || !isRecord(properties.info) || typeof properties.info.id !== "string") return undefined;
  return properties.info.id;
}

async function startServer(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "antechamber-v124-events-global-"));
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

async function createSession(url: string, directory: string) {
  const response = await fetch(`${url}/session?directory=${encodeURIComponent(directory)}`, { method: "POST" });
  assert.equal(response.status, 200);
  const session: unknown = await response.json();
  if (!isRecord(session) || typeof session.id !== "string") throw new TypeError("expected a session id");
  return session.id;
}

async function openGlobalEvents(url: string, headers: Record<string, string> = {}) {
  const controller = new AbortController();
  const response = await fetch(`${url}/global/event`, { headers, signal: controller.signal });
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
    records,
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

async function promptAsync(url: string, directory: string, sessionID: string, messageID: string, noReply = false) {
  const response = await fetch(`${url}/session/${sessionID}/prompt_async?directory=${encodeURIComponent(directory)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messageID, noReply, parts: [{ type: "text", text: messageID }] }),
  });
  assert.equal(response.status, 204);
}

test("V124-004: envelopes global idle events with directory", { timeout: 10_000 }, async (t) => {
  const { directory, url } = await startServer(t);
  const sessionID = await createSession(url, directory);
  const stream = await openGlobalEvents(url);
  t.after(() => stream.close());
  const idle = stream.wait((record) => eventType(record) === "session.idle" && isRecord(payloadOf(record).properties));

  await promptAsync(url, directory, sessionID, "msg-idle");
  const record = await idle;
  assert.equal(record.data.directory, directory);
  if (!isRecord(record.data.payload)) throw new TypeError("expected an envelope payload");
  assert.equal(record.data.payload.type, "session.idle");
  if (!isRecord(record.data.payload.properties)) throw new TypeError("expected idle properties");
  assert.equal(record.data.payload.properties.sessionID, sessionID);
});

test("V124-010: replays SSE events after Last-Event-ID", { timeout: 10_000 }, async (t) => {
  const { directory, url } = await startServer(t);
  const sessionID = await createSession(url, directory);
  const initial = await openGlobalEvents(url);
  t.after(() => initial.close());
  const firstUpdated = initial.wait(
    (record) => eventType(record) === "message.updated" && messageIDOf(record) === "msg-before-reconnect",
  );
  await promptAsync(url, directory, sessionID, "msg-before-reconnect", true);
  const first = await firstUpdated;
  const firstID = first.id ?? "";
  assert.equal(typeof first.id, "string");

  await initial.close();
  await promptAsync(url, directory, sessionID, "msg-after-reconnect", true);
  const replay = await openGlobalEvents(url, { "Last-Event-ID": firstID });
  t.after(() => replay.close());
  const later = await replay.wait(
    (record) => eventType(record) === "message.updated" && messageIDOf(record) === "msg-after-reconnect",
  );
  assert.ok(later.id);
  assert.notEqual(later.id, firstID);
  assert.equal(
    replay.records.some(
      (record) => eventType(record) === "message.updated" && messageIDOf(record) === "msg-before-reconnect",
    ),
    false,
  );
});
