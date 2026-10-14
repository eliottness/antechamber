import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { AdapterServer } from "../src/server.js";

const turnRpc = resolve("test/fixtures/turn-omo.mjs");

type EventFrame = { type: string; properties: Record<string, unknown> };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

function toEvent(value: unknown): EventFrame | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  return { type: value.type, properties: isRecord(value.properties) ? value.properties : {} };
}

async function startServer(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "antechamber-v124-prompts-"));
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

async function openEvents(url: string) {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  assert.equal(response.status, 200);
  if (!response.body) throw new TypeError("expected an SSE body");
  const events: EventFrame[] = [];
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
      const event = toEvent(JSON.parse(data));
      if (event === undefined) continue;
      events.push(event);
      bus.emit("event", event);
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
    wait(predicate: (event: EventFrame) => boolean): Promise<EventFrame> {
      const existing = events.find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolveEvent, rejectEvent) => {
        const timeout = AbortSignal.timeout(5_000);
        const listener = (event: EventFrame) => {
          if (!predicate(event)) return;
          timeout.removeEventListener("abort", expired);
          bus.off("event", listener);
          resolveEvent(event);
        };
        const expired = () => {
          bus.off("event", listener);
          rejectEvent(new Error("SSE event deadline"));
        };
        timeout.addEventListener("abort", expired, { once: true });
        bus.on("event", listener);
      });
    },
    async close() {
      controller.abort();
      await reading;
    },
  };
}

async function sessionMessages(url: string, directory: string, sessionID: string) {
  const response = await fetch(`${url}/session/${sessionID}/message?directory=${encodeURIComponent(directory)}`);
  assert.equal(response.status, 200);
  const messages: unknown = await response.json();
  if (!Array.isArray(messages)) throw new TypeError("expected a message list");
  return messages;
}

function messageWithID(messages: unknown[], messageID: string): Record<string, unknown> & { parts: unknown[] } {
  const message = messages.find(
    (candidate) => isRecord(candidate) && isRecord(candidate.info) && candidate.info.id === messageID,
  );
  if (!isRecord(message) || !Array.isArray(message.parts)) throw new TypeError(`expected message ${messageID}`);
  return { ...message, parts: message.parts };
}

test("V124-003: preserves queued delivery and file parts", { timeout: 10_000 }, async (t) => {
  const { directory, url } = await startServer(t);
  const sessionID = await createSession(url, directory);
  const stream = await openEvents(`${url}/event?directory=${encodeURIComponent(directory)}`);
  t.after(() => stream.close());
  await stream.wait((event) => event.type === "server.connected");
  const enqueued = stream.wait(
    (event) =>
      event.type === "session.inbox.enqueued" &&
      event.properties.inboxID === "msg_queue_file" &&
      isRecord(event.properties.item),
  );
  const userPart = stream.wait(
    (event) =>
      event.type === "message.part.updated" &&
      isRecord(event.properties.part) &&
      event.properties.part.messageID === "msg_queue_file",
  );

  const response = await fetch(`${url}/session/${sessionID}/prompt_async?directory=${encodeURIComponent(directory)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messageID: "msg_queue_file",
      delivery: "queue",
      parts: [
        { type: "text", text: "Read the attachment" },
        { type: "file", filename: "brief.txt", mime: "text/plain", url: "file:///tmp/brief.txt" },
      ],
    }),
  });
  assert.equal(response.status, 204);
  const admission = await enqueued;
  const item = admission.properties.item;
  if (!isRecord(item)) throw new TypeError("expected inbox item");
  assert.equal(item.delivery, "queue");
  await userPart;

  const message = messageWithID(await sessionMessages(url, directory, sessionID), "msg_queue_file");
  const parts = message.parts.filter(isRecord);
  assert.ok(parts.some((part) => part.type === "text" && part.text === "Read the attachment"));
  assert.ok(parts.some((part) => part.type === "file" && part.filename === "brief.txt" && part.mime === "text/plain"));
});

test("V124-008: preserves slash-command file parts", { timeout: 10_000 }, async (t) => {
  const { directory, url } = await startServer(t);
  const sessionID = await createSession(url, directory);
  const stream = await openEvents(`${url}/event?directory=${encodeURIComponent(directory)}`);
  t.after(() => stream.close());
  await stream.wait((event) => event.type === "server.connected");
  const userPart = stream.wait(
    (event) =>
      event.type === "message.part.updated" &&
      isRecord(event.properties.part) &&
      event.properties.part.messageID === "msg_cmd_file",
  );

  const response = await fetch(`${url}/session/${sessionID}/command?directory=${encodeURIComponent(directory)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      command: "review",
      arguments: "brief",
      messageID: "msg_cmd_file",
      parts: [{ type: "file", filename: "brief.txt", mime: "text/plain", url: "file:///tmp/brief.txt" }],
    }),
  });
  assert.equal(response.status, 200);
  await userPart;

  const message = messageWithID(await sessionMessages(url, directory, sessionID), "msg_cmd_file");
  const parts = message.parts.filter(isRecord);
  assert.ok(parts.some((part) => part.type === "file" && part.filename === "brief.txt" && part.mime === "text/plain"));
});
