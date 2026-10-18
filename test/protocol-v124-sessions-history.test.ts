import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { compactionMessages } from "../src/pi-event-translation.js";
import { AdapterServer } from "../src/server.js";
import type { OCMessageWithParts } from "../src/types.js";

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
  return { directory, url: server.url, server };
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

test("V124-006b: pages older messages through x-next-cursor and before", { timeout: 10_000 }, async (t) => {
  const { directory, url } = await startServer(t);
  const sessionID = await createSession(url, directory, "paged");
  const stream = await openEvents(`${url}/event?directory=${encodeURIComponent(directory)}`);
  t.after(() => stream.close());
  await stream.wait((event) => event.type === "server.connected");

  for (const id of ["msg-page-1", "msg-page-2", "msg-page-3"]) {
    const stored = stream.wait(
      (event) => event.type === "message.updated" && isRecord(event.properties.info) && event.properties.info.id === id,
    );
    await enqueueText(url, directory, sessionID, id, id);
    await stored;
  }

  const base = `${url}/session/${sessionID}/message?directory=${encodeURIComponent(directory)}`;
  const ids = (body: unknown): string[] => {
    if (!Array.isArray(body)) throw new TypeError("expected a message array");
    return body.map((message) => (isRecord(message) && isRecord(message.info) ? String(message.info.id) : ""));
  };
  const full = await fetch(base);
  assert.equal(full.headers.get("x-next-cursor"), null);
  const all = ids(await full.json());
  assert.ok(all.length >= 3);

  // OpenChamber's loader only asks for older pages when a cursor is returned.
  const collected: string[] = [];
  let cursor: string | null = null;
  do {
    const response = await fetch(`${base}&limit=1${cursor === null ? "" : `&before=${encodeURIComponent(cursor)}`}`);
    assert.equal(response.status, 200);
    const page = ids(await response.json());
    assert.equal(page.length, 1);
    collected.unshift(...page);
    cursor = response.headers.get("x-next-cursor");
    if (cursor !== null) assert.equal(cursor, page[0]);
  } while (cursor !== null && collected.length <= all.length);
  assert.deepEqual(collected, all);

  const unknown = await fetch(`${base}&limit=1&before=msg-missing`);
  assert.deepEqual(await unknown.json(), []);
  assert.equal(unknown.headers.get("x-next-cursor"), null);
});

test("V124-006c: a page without a prompt reaches back to its turn's user message", { timeout: 10_000 }, async (t) => {
  const { directory, url } = await startServer(t);
  const sessionID = await createSession(url, directory, "long turn");
  const base = `${url}/session/${sessionID}/message?directory=${encodeURIComponent(directory)}`;
  for (const text of ["normal", "steps"]) {
    const sent = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text }] }),
    });
    assert.equal(sent.status, 200);
  }
  const roles = (body: unknown): string[] =>
    (Array.isArray(body) ? body : []).map((message) =>
      isRecord(message) && isRecord(message.info) ? String(message.info.role) : "",
    );
  const all: unknown = await (await fetch(base)).json();
  assert.deepEqual(roles(all), ["user", "assistant", "user", "assistant", "assistant"]);

  // OpenChamber 1.24 widens a prompt-less page only up to 120 messages, then renders it blank.
  const newest = await fetch(`${base}&limit=1`);
  const page: unknown = await newest.json();
  assert.deepEqual(roles(page), ["user", "assistant", "assistant"]);
  assert.deepEqual(page, (all as unknown[]).slice(2));
  const cursor = newest.headers.get("x-next-cursor");
  assert.equal(cursor, (all as Array<{ info: { id: string } }>)[2]?.info.id);

  // A page that already holds a prompt keeps its size.
  const two: unknown = await (await fetch(`${base}&limit=3`)).json();
  assert.deepEqual(roles(two), ["user", "assistant", "assistant"]);
  const older: unknown = await (await fetch(`${base}&limit=1&before=${encodeURIComponent(cursor ?? "")}`)).json();
  assert.deepEqual(roles(older), ["user", "assistant"]);
});

test("V124-006d: compaction does not replace the parent anchor of a paged turn", { timeout: 10_000 }, async (t) => {
  const { directory, url, server } = await startServer(t);
  const sessionID = await createSession(url, directory, "compacted long turn");
  const base = `${url}/session/${sessionID}/message?directory=${encodeURIComponent(directory)}`;
  for (const text of ["normal", "steps"]) {
    const response = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text }] }),
    });
    assert.equal(response.status, 200);
  }
  const manager = server["sessions"];
  const session = manager.get(sessionID);
  const initial = manager.messages(sessionID) ?? [];
  const prompt = initial.findLast((message) => message.info.role === "user");
  const reply = initial.at(-1);
  assert.ok(session && prompt && reply?.info.role === "assistant");
  for (let index = 0; index < 205; index++) {
    if (index === 175) {
      for (const message of compactionMessages(session, "paged", "Earlier work", Date.now(), session.model, undefined))
        manager.appendMessage(sessionID, message);
    }
    manager.appendMessage(sessionID, {
      info: { ...reply.info, id: `msg_step_${index}`, parentID: prompt.info.id },
      parts: [],
    });
  }
  for (const limit of [1, 30, 50, 150]) {
    const response = await fetch(`${base}&limit=${limit}`);
    const page = (await response.json()) as OCMessageWithParts[];
    assert.equal(page[0]?.info.id, prompt.info.id);
    assert.equal(page.at(-1)?.info.id, "msg_step_204");
    const ids = new Set(page.map((message) => message.info.id));
    for (const message of page) {
      if (message.info.role === "assistant") assert.ok(ids.has(message.info.parentID), message.info.id);
    }
    assert.equal(response.headers.get("x-next-cursor"), prompt.info.id);
  }
  const older = await fetch(`${base}&limit=30&before=${encodeURIComponent(prompt.info.id)}`);
  assert.deepEqual(await older.json(), initial.slice(0, 2));
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
