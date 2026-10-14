import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { AdapterServer } from "../src/server.js";

const endpointFixture = resolve("test/fixtures/fake-omo-endpoints.mjs");
const approvalFixture = resolve("test/fixtures/approval-rpc.mjs");
const diffFixture = resolve("test/fixtures/diff-omo.mjs");

type RecordValue = Record<string, unknown>;
type V2Envelope = RecordValue & { type: string; data?: RecordValue; location?: { directory?: string } };

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): RecordValue {
  assert.ok(isRecord(value), `${label} must be an object`);
  return value as RecordValue;
}

async function startServer(t: TestContext, fixture = endpointFixture) {
  const root = mkdtempSync(join(tmpdir(), "antechamber-v232-"));
  const saved = new Map(
    ["ANTECHAMBER_PI_BINARY", "ANTECHAMBER_STATE_DIR", "PI_CODING_AGENT_DIR"].map((key) => [key, process.env[key]]),
  );
  process.env.ANTECHAMBER_PI_BINARY = fixture;
  process.env.ANTECHAMBER_STATE_DIR = join(root, "state");
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const server = new AdapterServer({ port: 0, host: "127.0.0.1", defaultDirectory: root });
  await server.start();
  t.after(async () => {
    await server.stop();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, server, url: server.url };
}

async function postJson(url: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function createSession(url: string, body: RecordValue = {}, headers: Record<string, string> = {}) {
  const response = await postJson(url, "/api/session", body, headers);
  assert.equal(response.status, 200);
  const data = record(record(await response.json(), "session response").data, "session response data");
  if (typeof data.id !== "string") assert.fail("session response data.id must be a string");
  return data.id;
}

function openSse(t: TestContext, url: string, path = "/api/event") {
  const controller = new AbortController();
  const events = new EventEmitter();
  const history: V2Envelope[] = [];
  const ready = fetch(`${url}${path}`, { signal: controller.signal }).then(async (response) => {
    assert.equal(response.status, 200);
    const body = response.body;
    assert.ok(body);
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          for (;;) {
            const end = buffer.indexOf("\n\n");
            if (end < 0) break;
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const line = frame.split("\n").find((candidate) => candidate.startsWith("data: "));
            if (!line) continue;
            const value = JSON.parse(line.slice("data: ".length));
            if (!isRecord(value) || typeof value.type !== "string") continue;
            const envelope = value as V2Envelope;
            history.push(envelope);
            events.emit("event", envelope);
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) events.emit("error", error);
      }
    })();
  });
  t.after(() => controller.abort());
  return {
    history,
    ready,
    wait(predicate: (event: V2Envelope) => boolean, label: string) {
      const found = history.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise<V2Envelope>((resolveEvent, reject) => {
        const timer = setTimeout(() => {
          events.off("event", listener);
          events.off("error", failed);
          reject(new Error(`SSE deadline: ${label}`));
        }, 5000);
        const listener = (event: V2Envelope) => {
          if (!predicate(event)) return;
          clearTimeout(timer);
          events.off("error", failed);
          resolveEvent(event);
        };
        const failed = (error: unknown) => {
          clearTimeout(timer);
          events.off("event", listener);
          reject(error);
        };
        events.on("event", listener);
        events.once("error", failed);
      });
    },
  };
}

async function promptAndWait(url: string, sessionID: string, stream: ReturnType<typeof openSse>, text: string) {
  const after = stream.history.length;
  const idle = stream.wait(
    (event) =>
      stream.history.indexOf(event) >= after && event.type === "session.idle" && event.data?.sessionID === sessionID,
    "session idle",
  );
  const response = await postJson(url, `/api/session/${sessionID}/prompt`, {
    id: `msg_${text}`,
    text,
  });
  assert.equal(response.status, 200);
  await idle;
}

test("V232-002: session list preserves cursor and filters", async (t) => {
  const { url } = await startServer(t);
  const parentID = await createSession(url, { title: "parent" });
  await createSession(url, { title: "child", parentID });
  await createSession(url, { title: "child two", parentID });
  await createSession(url, { title: "other" });

  const response = await fetch(`${url}/api/session?parentID=${parentID}&order=asc&limit=1`);
  assert.equal(response.status, 200);
  const page = record(await response.json(), "session page");
  assert.equal(Array.isArray(page.data), true);
  assert.equal((page.data as unknown[]).length, 1);
  assert.equal(record((page.data as unknown[])[0], "filtered session").parentID, parentID);
  const cursor = record(page.cursor, "session cursor");
  assert.equal(typeof cursor.next, "string", "OpenChamber needs a continuation cursor for a filtered page");
});

test("V232-003: messages paginate with a stable cursor", async (t) => {
  const { url } = await startServer(t);
  const stream = openSse(t, url);
  await stream.ready;
  await stream.wait((event) => event.type === "server.connected", "v2 connection");
  const sessionID = await createSession(url);
  await promptAndWait(url, sessionID, stream, "first");
  await promptAndWait(url, sessionID, stream, "second");

  const response = await fetch(`${url}/api/session/${sessionID}/message?order=desc&limit=1`);
  assert.equal(response.status, 200);
  const page = record(await response.json(), "message page");
  const cursor = record(page.cursor, "message cursor");
  assert.equal(typeof cursor.next, "string", "OpenChamber requires a next cursor while older messages remain");
});

test("V232-004: prompt preserves rich input fields", async (t) => {
  const { url } = await startServer(t);
  const sessionID = await createSession(url);
  const response = await postJson(url, `/api/session/${sessionID}/prompt`, {
    parts: [
      { type: "text", text: "review this" },
      { type: "file", path: "src/server.ts" },
    ],
    mentions: [{ type: "file", path: "src/routes-v2.ts" }],
    skills: ["protocol-audit"],
    metadata: { source: "openchamber" },
  });
  assert.equal(response.status, 200);
  const accepted = record(record(await response.json(), "prompt response").data, "prompt response data");
  assert.deepEqual(accepted.prompt, {
    text: "review this",
    parts: [
      { type: "text", text: "review this" },
      { type: "file", path: "src/server.ts" },
    ],
    mentions: [{ type: "file", path: "src/routes-v2.ts" }],
    skills: ["protocol-audit"],
    metadata: { source: "openchamber" },
  });
});

test("V232-005: accepts synthetic context admission", async (t) => {
  const { url } = await startServer(t);
  const sessionID = await createSession(url);
  const response = await postJson(url, `/api/session/${sessionID}/context`, {
    text: "Synthetic context from OpenChamber",
  });
  assert.equal(response.status, 200);
  const data = record(record(await response.json(), "context response").data, "context record");
  assert.equal(data.type, "synthetic");
  assert.equal(data.sessionID, sessionID);
  assert.deepEqual(data.payload, { text: "Synthetic context from OpenChamber" });
});

test("V232-006: accepts the v2 command payload", async (t) => {
  const { url } = await startServer(t);
  const sessionID = await createSession(url);
  const response = await postJson(url, `/api/session/${sessionID}/command`, { name: "help", text: "" });
  assert.equal(response.status, 204);
});

test("V232-007: compacts through the v2 compact path", async (t) => {
  const { url } = await startServer(t);
  const sessionID = await createSession(url);
  const stream = openSse(t, url);
  await stream.ready;
  await promptAndWait(url, sessionID, stream, "compact");
  const response = await postJson(url, `/api/session/${sessionID}/compact`, {});
  assert.equal(response.status, 200);
});

test("V232-008: replies to permissions with decision", async (t) => {
  const { url } = await startServer(t, approvalFixture);
  const stream = openSse(t, url);
  await stream.ready;
  await stream.wait((event) => event.type === "server.connected", "v2 connection");
  const sessionID = await createSession(url);
  const asked = stream.wait(
    (event) => event.type === "permission.asked" && event.data?.sessionID === sessionID,
    "permission request",
  );
  const prompt = await postJson(url, `/api/session/${sessionID}/prompt`, {
    parts: [{ type: "text", text: "permission" }],
  });
  assert.equal(prompt.status, 200);
  const permission = record((await asked).data, "permission event data");
  assert.equal(typeof permission.id, "string");
  const response = await postJson(url, `/api/session/${sessionID}/permission/${permission.id}/reply`, {
    decision: "once",
  });
  assert.equal(response.status, 204);
});

test("V232-014: preserves requested session identity", async (t) => {
  const { root, url } = await startServer(t);
  const response = await postJson(url, "/api/session", {
    id: "ses_openchamber_identity",
    title: "OpenChamber configured session",
    agent: "build",
    model: { providerID: "fake", modelID: "requested" },
    location: { directory: root },
    metadata: { source: "v232" },
  });
  assert.equal(response.status, 200);
  const session = record(record(await response.json(), "session response").data, "session data");
  assert.equal(session.id, "ses_openchamber_identity");
});

test("V232-015: shell returns an empty success response", async (t) => {
  const { url } = await startServer(t);
  const sessionID = await createSession(url);
  const response = await postJson(url, `/api/session/${sessionID}/shell`, { command: "echo protocol" });
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
});

test("V232-016: interrupt returns the bare interrupted flag OpenChamber reads", async (t) => {
  const { url } = await startServer(t);
  const sessionID = await createSession(url);
  const response = await postJson(url, `/api/session/${sessionID}/interrupt`, {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { interrupted: true });
});

test("V232-017: forks sessions through the v2 route", async (t) => {
  const { url } = await startServer(t, resolve("test/fixtures/fake-omo.mjs"));
  const sessionID = await createSession(url);
  const stream = openSse(t, url);
  await stream.ready;
  await promptAndWait(url, sessionID, stream, "fork");
  const response = await postJson(url, `/api/session/${sessionID}/fork`, {});
  assert.equal(response.status, 200);
  assert.notEqual(record(record(await response.json(), "fork").data, "fork data").id, sessionID);
});

test("V232-018: stages reverts through the v2 route", async (t) => {
  const { url } = await startServer(t, resolve("test/fixtures/fake-omo.mjs"));
  const sessionID = await createSession(url);
  const stream = openSse(t, url);
  await stream.ready;
  await promptAndWait(url, sessionID, stream, "target");
  const response = await postJson(url, `/api/session/${sessionID}/revert`, { messageID: "msg_target" });
  assert.equal(response.status, 200);
});

test("V232-019: clears reverts through the v2 route", async (t) => {
  const { url } = await startServer(t);
  const sessionID = await createSession(url);
  const response = await fetch(`${url}/api/session/${sessionID}/revert`, { method: "DELETE" });
  assert.equal(response.status, 204);
});

test("V232-020: honors diff range filters", async (t) => {
  const { url } = await startServer(t, diffFixture);
  const stream = openSse(t, url);
  await stream.ready;
  await stream.wait((event) => event.type === "server.connected", "v2 connection");
  const sessionID = await createSession(url);
  await promptAndWait(url, sessionID, stream, JSON.stringify([{ path: "first.txt", content: "one" }]));
  await promptAndWait(url, sessionID, stream, JSON.stringify([{ path: "second.txt", content: "two" }]));
  const messages = record(
    await (await fetch(`${url}/api/session/${sessionID}/message?order=asc`)).json(),
    "session messages",
  );
  assert.equal(Array.isArray(messages.data), true);
  const first = record((messages.data as unknown[])[0], "first message");
  const last = record((messages.data as unknown[]).at(-1), "last message");
  if (typeof first.id !== "string") assert.fail("first message id must be a string");
  if (typeof last.id !== "string") assert.fail("last message id must be a string");
  const response = await fetch(`${url}/api/session/${sessionID}/diff?from=${first.id}&to=${last.id}&context=0`);
  assert.equal(response.status, 200);
  const diff = record(await response.json(), "diff response");
  assert.equal(Array.isArray(diff.data), true);
  assert.deepEqual(
    (diff.data as unknown[]).map((entry) => record(entry, "diff entry").path),
    ["first.txt"],
  );
});

test("V232-021: scopes pending permissions by location", async (t) => {
  const { root, url } = await startServer(t, approvalFixture);
  const firstDirectory = join(root, "v232-a");
  const secondDirectory = join(root, "v232-b");
  mkdirSync(firstDirectory);
  mkdirSync(secondDirectory);
  const stream = openSse(t, url, `/api/event?directory=${encodeURIComponent(firstDirectory)}`);
  const secondStream = openSse(t, url, `/api/event?directory=${encodeURIComponent(secondDirectory)}`);
  await Promise.all([stream.ready, secondStream.ready]);
  const firstSession = await createSession(url, {}, { "x-opencode-directory": firstDirectory });
  const secondSession = await createSession(url, {}, { "x-opencode-directory": secondDirectory });
  const firstAsked = stream.wait(
    (event) => event.type === "permission.asked" && event.data?.sessionID === firstSession,
    "first permission",
  );
  assert.equal(
    (await postJson(url, `/api/session/${firstSession}/prompt`, { parts: [{ type: "text", text: "permission" }] }))
      .status,
    200,
  );
  await firstAsked;
  const secondAsked = secondStream.wait(
    (event) => event.type === "permission.asked" && event.data?.sessionID === secondSession,
    "second permission",
  );
  assert.equal(
    (await postJson(url, `/api/session/${secondSession}/prompt`, { parts: [{ type: "text", text: "permission" }] }))
      .status,
    200,
  );
  await secondAsked;
  const response = await fetch(`${url}/api/permission/request`, {
    headers: { "x-opencode-directory": firstDirectory },
  });
  assert.equal(response.status, 200);
  const listed = record(await response.json(), "permission list");
  assert.equal(Array.isArray(listed.data), true);
  assert.deepEqual(
    (listed.data as unknown[]).map((entry) => record(entry, "permission entry").sessionID),
    [firstSession],
  );
});

test("V232-033: persists a session agent choice", async (t) => {
  const { url } = await startServer(t);
  const sessionID = await createSession(url);
  const selected = await postJson(url, `/api/session/${sessionID}/agent`, { agent: "build" });
  assert.equal(selected.status, 204);
  const session = record(await (await fetch(`${url}/api/session/${sessionID}`)).json(), "session read");
  assert.equal(record(session.data, "session data").agent, "build");
  const unknown = await postJson(url, `/api/session/${sessionID}/agent`, { agent: "custom-v232-agent" });
  assert.equal(unknown.status, 400);
});
