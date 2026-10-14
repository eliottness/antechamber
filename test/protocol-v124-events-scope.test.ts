import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
  const directory = mkdtempSync(join(tmpdir(), "antechamber-v124-events-scope-"));
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
    events,
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

test("V124-009: filters directory-scoped streams", { timeout: 10_000 }, async (t) => {
  const { directory, url } = await startServer(t);
  const firstDirectory = join(directory, "first");
  const secondDirectory = join(directory, "second");
  mkdirSync(firstDirectory);
  mkdirSync(secondDirectory);
  const first = await openEvents(`${url}/event?directory=${encodeURIComponent(firstDirectory)}`);
  const second = await openEvents(`${url}/event?directory=${encodeURIComponent(secondDirectory)}`);
  t.after(() => first.close());
  t.after(() => second.close());
  await Promise.all([
    first.wait((event) => event.type === "server.connected"),
    second.wait((event) => event.type === "server.connected"),
  ]);

  const createdFirst = first.wait(
    (event) =>
      event.type === "session.created" &&
      isRecord(event.properties.info) &&
      event.properties.info.directory === firstDirectory,
  );
  await createSession(url, firstDirectory);
  await createdFirst;
  const createdSecond = second.wait(
    (event) =>
      event.type === "session.created" &&
      isRecord(event.properties.info) &&
      event.properties.info.directory === secondDirectory,
  );
  await createSession(url, secondDirectory);
  await createdSecond;

  const leaks = second.events.filter(
    (event) =>
      event.type === "session.created" &&
      isRecord(event.properties.info) &&
      event.properties.info.directory === firstDirectory,
  );
  assert.equal(leaks.length, 0);
});

test("V124-011: emits message.part.delta frames", { timeout: 10_000 }, async (t) => {
  const { directory, url } = await startServer(t);
  const sessionID = await createSession(url, directory);
  const stream = await openEvents(`${url}/event?directory=${encodeURIComponent(directory)}`);
  t.after(() => stream.close());
  await stream.wait((event) => event.type === "server.connected");
  const emitted = stream.wait((event) => event.type === "message.part.delta");
  const idle = stream.wait((event) => event.type === "session.idle" && event.properties.sessionID === sessionID);

  const response = await fetch(`${url}/session/${sessionID}/prompt_async?directory=${encodeURIComponent(directory)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messageID: "msg-delta", parts: [{ type: "text", text: "stream this" }] }),
  });
  assert.equal(response.status, 204);
  const delta = await emitted;
  assert.equal(delta.type, "message.part.delta");
  assert.equal(delta.properties.sessionID, sessionID);
  assert.equal(typeof delta.properties.messageID, "string");
  assert.notEqual(delta.properties.messageID, "msg-delta");
  assert.equal(typeof delta.properties.partID, "string");
  assert.equal(delta.properties.field, "text");
  assert.equal(typeof delta.properties.delta, "string");
  await idle;
  assert.ok(
    stream.events.some(
      (event) =>
        event.type === "message.updated" &&
        isRecord(event.properties.info) &&
        event.properties.info.role === "assistant" &&
        event.properties.info.id === delta.properties.messageID,
    ),
  );
  const textByPart = new Map<string, string>();
  const deltas: string[] = [];
  for (const event of stream.events) {
    const props = event.properties;
    if (event.type === "message.part.delta" && typeof props.partID === "string" && typeof props.delta === "string") {
      deltas.push(props.delta);
      textByPart.set(props.partID, (textByPart.get(props.partID) ?? "") + props.delta);
      assert.equal(textByPart.get(props.partID), "result", "delta must append once before its snapshot");
    }
    if (
      event.type === "message.part.updated" &&
      isRecord(props.part) &&
      props.part.messageID === delta.properties.messageID &&
      typeof props.part.id === "string" &&
      typeof props.part.text === "string"
    ) {
      assert.equal(props.delta, undefined, "snapshots must not also carry append deltas");
      textByPart.set(props.part.id, props.part.text);
    }
  }
  assert.deepEqual(deltas, ["result"]);
  assert.equal(textByPart.get(String(delta.properties.partID)), "result");
});
