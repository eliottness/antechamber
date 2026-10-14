import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { AdapterServer } from "../src/server.js";

const endpointFixture = resolve("test/fixtures/fake-omo-endpoints.mjs");
const turnFixture = resolve("test/fixtures/turn-omo.mjs");
const approvalFixture = resolve("test/fixtures/approval-rpc.mjs");

type RecordValue = Record<string, unknown>;
type Envelope = RecordValue & { type: string; data?: RecordValue; location?: { directory?: string } };

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): RecordValue {
  assert.ok(isRecord(value), `${label} must be an object`);
  return value as RecordValue;
}

async function startServer(t: TestContext, fixture = endpointFixture) {
  const root = mkdtempSync(join(tmpdir(), "antechamber-v232-events-"));
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
  return { root, url: server.url };
}

async function postJson(url: string, path: string, body: unknown) {
  return fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function createSession(url: string, body: RecordValue = {}, directory?: string) {
  const query = directory === undefined ? "" : `?directory=${encodeURIComponent(directory)}`;
  const response = await postJson(url, `/api/session${query}`, body);
  assert.equal(response.status, 200);
  const session = record(record(await response.json(), "session response").data, "session data");
  if (typeof session.id !== "string") assert.fail("session data.id must be a string");
  return session.id;
}

function openSse(t: TestContext, url: string, path = "/api/event", headers: Record<string, string> = {}) {
  const controller = new AbortController();
  const bus = new EventEmitter();
  const history: Envelope[] = [];
  const ready = fetch(`${url}${path}`, { signal: controller.signal, headers }).then(async (response) => {
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
            const payload = JSON.parse(line.slice("data: ".length));
            if (
              !isRecord(payload) ||
              (typeof payload.type !== "string" &&
                (!isRecord(payload.payload) || typeof payload.payload.type !== "string"))
            )
              continue;
            const event = payload as Envelope;
            history.push(event);
            bus.emit("event", event);
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) bus.emit("error", error);
      }
    })();
  });
  t.after(() => controller.abort());
  return {
    history,
    ready,
    wait(predicate: (event: Envelope) => boolean, label: string) {
      const found = history.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise<Envelope>((resolveEvent, reject) => {
        const timer = setTimeout(() => {
          bus.off("event", listener);
          bus.off("error", failed);
          reject(new Error(`SSE deadline: ${label}`));
        }, 5000);
        const listener = (event: Envelope) => {
          if (!predicate(event)) return;
          clearTimeout(timer);
          bus.off("error", failed);
          resolveEvent(event);
        };
        const failed = (error: unknown) => {
          clearTimeout(timer);
          bus.off("event", listener);
          reject(error);
        };
        bus.on("event", listener);
        bus.once("error", failed);
      });
    },
  };
}

async function promptAndWait(url: string, sessionID: string, stream: ReturnType<typeof openSse>, text: string) {
  const idle = stream.wait(
    (event) => event.type === "session.idle" && event.data?.sessionID === sessionID,
    "session idle",
  );
  const response = await postJson(url, `/api/session/${sessionID}/prompt`, {
    text,
    id: "msg_v232_boundary",
  });
  assert.equal(response.status, 200);
  await idle;
}

test("V232-EVENTS-01: an unscoped v2 stream is global, live and on replay; explicit scopes still filter", async (t) => {
  const { root, url } = await startServer(t);
  const other = join(root, "other");
  mkdirSync(other);
  const global = openSse(t, url);
  const scoped = openSse(t, url, `/api/event?directory=${encodeURIComponent(root)}`);
  await Promise.all([global.ready, scoped.ready]);

  const created = (directory: string) => (event: Envelope) =>
    event.type === "session.created" && event.location?.directory === directory;
  const otherCreated = global.wait(created(other), "other-directory session on the global stream");
  const otherID = await createSession(url, {}, other);
  const otherEvent = await otherCreated;
  assert.equal(otherEvent.data?.sessionID, otherID);

  // Events are written in order, so once the scoped stream sees its own later session it
  // would already have received the other directory's event if it leaked.
  const rootCreated = scoped.wait(created(root), "default-directory session on the scoped stream");
  await createSession(url);
  await rootCreated;
  assert.equal(scoped.history.filter(created(other)).length, 0);

  const replay = openSse(t, url, "/api/event", { "last-event-id": "0" });
  await replay.ready;
  const replayed = await replay.wait(created(other), "other-directory session replayed to a global stream");
  assert.equal(replayed.data?.sessionID, otherID);
});

test("V232-009: interruption emits a cancelled execution", async (t) => {
  const { url } = await startServer(t, resolve("test/fixtures/fake-omo.mjs"));
  const stream = openSse(t, url);
  await stream.ready;
  await stream.wait((event) => event.type === "server.connected", "v2 connection");
  const sessionID = await createSession(url);
  const started = stream.wait(
    (event) => event.type === "session.execution.started" && event.data?.sessionID === sessionID,
    "execution start",
  );
  const prompt = await postJson(url, `/api/session/${sessionID}/prompt`, { text: "pending-turn" });
  assert.equal(prompt.status, 200);
  await started;
  const terminal = stream.wait(
    (event) =>
      ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(
        event.type,
      ) && event.data?.sessionID === sessionID,
    "interrupted terminal event",
  );
  const interrupted = await postJson(url, `/api/session/${sessionID}/interrupt`, {});
  assert.equal(interrupted.status, 200);
  const frame = await terminal;
  assert.equal(frame.type, "session.execution.interrupted");
  assert.equal(frame.data?.reason, "user");
  assert.equal(
    stream.history.some((event) => event.type === "session.execution.succeeded" && event.data?.sessionID === sessionID),
    false,
  );
});

test("V232-010: emits OpenChamber permission event names", async (t) => {
  const { url } = await startServer(t, approvalFixture);
  const stream = openSse(t, url);
  await stream.ready;
  await stream.wait((event) => event.type === "server.connected", "v2 connection");
  const sessionID = await createSession(url);
  const asked = stream.wait(
    (event) => event.type === "permission.asked" && event.data?.sessionID === sessionID,
    "current permission event",
  );
  assert.equal(
    (await postJson(url, `/api/session/${sessionID}/prompt`, { parts: [{ type: "text", text: "permission" }] })).status,
    200,
  );
  assert.equal((await asked).type, "permission.asked");
});

test("V232-022: child creation includes ancestry", async (t) => {
  const { url } = await startServer(t);
  const parentID = await createSession(url, { title: "parent" });
  const stream = openSse(t, url);
  await stream.ready;
  await stream.wait((event) => event.type === "server.connected", "v2 connection");
  const created = stream.wait(
    (event) => event.type === "session.created" && event.data?.parentID === parentID,
    "child session event",
  );
  const child = await postJson(url, "/api/session", { parentID, title: "child" });
  assert.equal(child.status, 200);
  const frame = await created;
  assert.equal(frame.data?.parentID, parentID);
});

test("V232-023: staging emits a revert event", async (t) => {
  const { url } = await startServer(t, resolve("test/fixtures/fake-omo.mjs"));
  const stream = openSse(t, url);
  await stream.ready;
  await stream.wait((event) => event.type === "server.connected", "v2 connection");
  const sessionID = await createSession(url);
  await promptAndWait(url, sessionID, stream, "first");
  const staged = stream.wait(
    (event) => event.type === "session.revert.staged" && event.data?.sessionID === sessionID,
    "staged revert",
  );
  const response = await postJson(url, `/session/${sessionID}/revert`, { messageID: "msg_v232_boundary" });
  assert.equal(response.status, 200);
  assert.deepEqual((await staged).data?.revert, { messageID: "msg_v232_boundary" });
});

test("V232-024: clearing emits a revert event", async (t) => {
  const { url } = await startServer(t, resolve("test/fixtures/fake-omo.mjs"));
  const stream = openSse(t, url);
  await stream.ready;
  await stream.wait((event) => event.type === "server.connected", "v2 connection");
  const sessionID = await createSession(url);
  await promptAndWait(url, sessionID, stream, "first");
  const staged = await postJson(url, `/session/${sessionID}/revert`, { messageID: "msg_v232_boundary" });
  assert.equal(staged.status, 200);
  const cleared = stream.wait(
    (event) => event.type === "session.revert.cleared" && event.data?.sessionID === sessionID,
    "cleared revert",
  );
  const response = await postJson(url, `/session/${sessionID}/unrevert`, {});
  assert.equal(response.status, 200);
  await cleared;
});

test("V232-025: committing emits a revert event", async (t) => {
  const { url } = await startServer(t, resolve("test/fixtures/fake-omo.mjs"));
  const stream = openSse(t, url);
  await stream.ready;
  await stream.wait((event) => event.type === "server.connected", "v2 connection");
  const sessionID = await createSession(url);
  await promptAndWait(url, sessionID, stream, "first");
  const response = await postJson(url, `/session/${sessionID}/revert`, { messageID: "msg_v232_boundary" });
  assert.equal(response.status, 200);
  assert.equal(
    stream.history.some((event) => event.type === "session.revert.committed"),
    false,
  );
  const committed = stream.wait(
    (event) => event.type === "session.revert.committed" && event.data?.sessionID === sessionID,
    "committed revert",
  );
  assert.equal((await postJson(url, `/api/session/${sessionID}/revert/commit`, {})).status, 204);
  assert.equal((await committed).data?.to, "msg_v232_boundary");
});

test("V232-026: emits compaction lifecycle frames", async (t) => {
  const { url } = await startServer(t, turnFixture);
  const stream = openSse(t, url);
  await stream.ready;
  await stream.wait((event) => event.type === "server.connected", "v2 connection");
  const sessionID = await createSession(url);
  await promptAndWait(url, sessionID, stream, "summarize me");
  const ended = stream.wait(
    (event) => event.type === "session.compaction.ended" && event.data?.sessionID === sessionID,
    "compaction end",
  );
  const response = await postJson(url, `/api/session/${sessionID}/summarize`, {});
  assert.equal(response.status, 200);
  await ended;
  assert.deepEqual(
    stream.history
      .filter((event) => event.data?.sessionID === sessionID)
      .map((event) => event.type)
      .filter((type) => type.startsWith("session.compaction.")),
    ["session.compaction.started", "session.compaction.ended"],
  );
});

test("V232-027: emits shell lifecycle frames", async (t) => {
  const { url } = await startServer(t);
  const stream = openSse(t, url);
  await stream.ready;
  await stream.wait((event) => event.type === "server.connected", "v2 connection");
  const sessionID = await createSession(url);
  const ended = stream.wait(
    (event) => event.type === "session.shell.ended" && event.data?.sessionID === sessionID,
    "shell end",
  );
  const response = await postJson(url, `/api/session/${sessionID}/shell`, { command: "echo shell-start" });
  assert.ok(response.status === 200 || response.status === 204);
  await ended;
  const shellEvents = stream.history.filter((event) => event.data?.sessionID === sessionID);
  assert.deepEqual(
    shellEvents.map((event) => event.type).filter((type) => type.startsWith("session.shell.")),
    ["session.shell.started", "session.shell.ended"],
  );
});

test("V232-034: legacy global events wrap payloads and local events retain v1 framing", async (t) => {
  const { root, url } = await startServer(t);
  const event = openSse(t, url, "/event");
  const global = openSse(t, url, "/global/event");
  await Promise.all([event.ready, global.ready]);
  const [eventConnected, globalConnected] = await Promise.all([
    event.wait((frame) => frame.type === "server.connected", "legacy event connection"),
    global.wait(
      (frame) => isRecord(frame.payload) && frame.payload.type === "server.connected",
      "legacy global connection",
    ),
  ]);
  assert.deepEqual(eventConnected, { type: "server.connected", properties: {} });
  assert.equal(globalConnected.directory, root);
  assert.ok(isRecord(globalConnected.payload));
  assert.equal(globalConnected.payload.type, "server.connected");
  assert.deepEqual(globalConnected.payload.properties, {});
  assert.equal(typeof globalConnected.payload.id, "string");
});
