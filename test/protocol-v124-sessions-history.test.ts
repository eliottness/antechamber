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
  const directory = mkdtempSync(join(tmpdir(), "antechamber-v124-history-"));
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

async function createSession(url: string, directory: string, title: string) {
  const response = await fetch(`${url}/session?directory=${encodeURIComponent(directory)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
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

async function enqueueText(url: string, directory: string, sessionID: string, messageID: string, text: string) {
  const response = await fetch(`${url}/session/${sessionID}/prompt_async?directory=${encodeURIComponent(directory)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messageID, noReply: true, parts: [{ type: "text", text }] }),
  });
  assert.equal(response.status, 204);
}

test("V124-005: returns bounded experimental-session pages", { timeout: 10_000 }, async (t) => {
  const { directory, url } = await startServer(t);
  await createSession(url, directory, "first");
  await createSession(url, directory, "second");
  await createSession(url, directory, "third");

  const first = await fetch(
    `${url}/experimental/session?directory=${encodeURIComponent(directory)}&roots=true&archived=true&limit=1`,
  );
  assert.equal(first.status, 200);
  const page: unknown = await first.json();
  if (!Array.isArray(page)) throw new TypeError("expected a session page");
  assert.equal(page.length, 1);
  const firstSession = page[0];
  if (!isRecord(firstSession) || typeof firstSession.id !== "string") throw new TypeError("expected a session row");
  const cursor = first.headers.get("x-next-cursor");
  if (cursor === null) throw new TypeError("expected a next cursor");

  const next = await fetch(
    `${url}/experimental/session?directory=${encodeURIComponent(directory)}&roots=true&archived=true&limit=1&cursor=${encodeURIComponent(cursor)}`,
  );
  assert.equal(next.status, 200);
  const nextPage: unknown = await next.json();
  if (!Array.isArray(nextPage) || !isRecord(nextPage[0])) throw new TypeError("expected a second session page");
  assert.notEqual(nextPage[0].id, firstSession.id);
});

test("V124-006: honors message list limit", { timeout: 10_000 }, async (t) => {
  const { directory, url } = await startServer(t);
  const sessionID = await createSession(url, directory, "limited");
  const stream = await openEvents(`${url}/event?directory=${encodeURIComponent(directory)}`);
  t.after(() => stream.close());
  await stream.wait((event) => event.type === "server.connected");

  const first = stream.wait((event) => event.type === "message.updated" && isRecord(event.properties.info));
  await enqueueText(url, directory, sessionID, "msg-one", "first");
  await first;
  const second = stream.wait(
    (event) =>
      event.type === "message.updated" && isRecord(event.properties.info) && event.properties.info.id === "msg-two",
  );
  await enqueueText(url, directory, sessionID, "msg-two", "second");
  await second;

  const response = await fetch(
    `${url}/session/${sessionID}/message?directory=${encodeURIComponent(directory)}&limit=1`,
  );
  assert.equal(response.status, 200);
  const messages: unknown = await response.json();
  if (!Array.isArray(messages)) throw new TypeError("expected a message array");
  assert.equal(messages.length, 1);
  assert.ok(isRecord(messages[0]));
  assert.equal(messages[0].info && isRecord(messages[0].info) ? messages[0].info.id : undefined, "msg-two");
});

test("V124-007: returns a v1 message by id", { timeout: 10_000 }, async (t) => {
  const { directory, url } = await startServer(t);
  const sessionID = await createSession(url, directory, "lookup");
  const stream = await openEvents(`${url}/event?directory=${encodeURIComponent(directory)}`);
  t.after(() => stream.close());
  await stream.wait((event) => event.type === "server.connected");

  const created = stream.wait(
    (event) =>
      event.type === "message.updated" && isRecord(event.properties.info) && event.properties.info.id === "msg-lookup",
  );
  await enqueueText(url, directory, sessionID, "msg-lookup", "lookup me");
  await created;

  const response = await fetch(
    `${url}/session/${sessionID}/message/msg-lookup?directory=${encodeURIComponent(directory)}`,
  );
  assert.equal(response.status, 200);
  const message: unknown = await response.json();
  if (!isRecord(message) || !isRecord(message.info)) throw new TypeError("expected message info");
  assert.equal(message.info.id, "msg-lookup");
  assert.ok(Array.isArray(message.parts));
});
