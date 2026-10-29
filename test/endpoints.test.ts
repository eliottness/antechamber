import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { AdapterServer } from "../src/server.js";
import type { PiRpcClient } from "../src/pi-rpc.js";
import { SessionPersistenceError, SessionStore } from "../src/session-store.js";
import { SessionManager } from "../src/sessions.js";
import { modelRefFromBody, numberParam } from "../src/route-services.js";

const fakeRpc = resolve("test/fixtures/fake-omo-endpoints.mjs");
const unsupportedShare = { name: "UnsupportedError", data: { message: "Sharing is not available with OmO" } };

type TestEvent = { type: string; properties?: Record<string, unknown>; data?: Record<string, unknown> };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

function startEvents(url: string, path = "/event") {
  const controller = new AbortController();
  const events = new EventEmitter();
  const history: TestEvent[] = [];

  const ready = fetch(`${url}${path}`, { signal: controller.signal }).then(async (response) => {
    assert.equal(response.status, 200);
    assert.ok(response.body);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    void (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const end = buffer.indexOf("\n\n");
          if (end < 0) break;
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = frame.split("\n").find((line) => line.startsWith("data: "));
          if (data === undefined) continue;
          const parsed: unknown = JSON.parse(data.slice(6));
          if (!isRecord(parsed) || typeof parsed.type !== "string") continue;
          const event: TestEvent = {
            type: parsed.type,
            ...(isRecord(parsed.properties) ? { properties: parsed.properties } : {}),
            ...(isRecord(parsed.data) ? { data: parsed.data } : {}),
          };
          history.push(event);
          events.emit(event.type, event);
        }
      }
    })().catch((error: unknown) => {
      if (!controller.signal.aborted) throw error;
    });
  });

  return {
    ready,
    close: () => controller.abort(),
    mark(): number {
      return history.length;
    },
    waitFor(type: string, predicate: (event: TestEvent) => boolean): Promise<TestEvent> {
      const existing = history.find((event) => event.type === type && predicate(event));
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolveEvent, rejectEvent) => {
        const timeout = AbortSignal.timeout(10_000);
        const onTimeout = (): void => {
          events.off(type, onEvent);
          rejectEvent(new Error(`timed out waiting for ${type}`));
        };
        const onEvent = (event: TestEvent): void => {
          if (!predicate(event)) return;
          events.off(type, onEvent);
          resolveEvent(event);
        };
        timeout.addEventListener("abort", onTimeout, { once: true });
        events.on(type, onEvent);
      });
    },
    waitForAfter(after: number, type: string, predicate: (event: TestEvent) => boolean): Promise<TestEvent> {
      const existing = history.slice(after).find((event) => event.type === type && predicate(event));
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolveEvent, rejectEvent) => {
        const timeout = AbortSignal.timeout(10_000);
        const onTimeout = (): void => {
          events.off(type, onEvent);
          rejectEvent(new Error("timed out waiting for a new bridge event"));
        };
        const onEvent = (event: TestEvent): void => {
          if (!predicate(event)) return;
          events.off(type, onEvent);
          resolveEvent(event);
        };
        timeout.addEventListener("abort", onTimeout, { once: true });
        events.on(type, onEvent);
      });
    },
  };
}

async function startServer(t: TestContext, fixture = fakeRpc) {
  const directory = mkdtempSync(join(tmpdir(), "antechamber-t11-"));
  const previousBinary = process.env.ANTECHAMBER_PI_BINARY;
  const previousState = process.env.ANTECHAMBER_STATE_DIR;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.ANTECHAMBER_PI_BINARY = fixture;
  process.env.ANTECHAMBER_STATE_DIR = join(directory, "state");
  process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
  const server = new AdapterServer({ host: "127.0.0.1", port: 0, defaultDirectory: directory });
  t.after(async () => {
    await server.stop();
    if (previousBinary === undefined) delete process.env.ANTECHAMBER_PI_BINARY;
    else process.env.ANTECHAMBER_PI_BINARY = previousBinary;
    if (previousState === undefined) delete process.env.ANTECHAMBER_STATE_DIR;
    else process.env.ANTECHAMBER_STATE_DIR = previousState;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(directory, { recursive: true, force: true });
  });
  await server.start();
  return { url: server.url, directory, server };
}

async function createSession(url: string): Promise<string> {
  const response = await fetch(`${url}/session`, { method: "POST", body: "{}" });
  assert.equal(response.status, 200);
  const session: unknown = await response.json();
  assert.ok(isRecord(session));
  if (typeof session.id !== "string") throw new Error("session id missing from create response");
  return session.id;
}

for (const action of ["reply", "reject"] as const) {
  test(`R-033: direct v2 question ${action} observes native refusal and settles once`, {
    timeout: 15_000,
  }, async (t) => {
    const { url, server } = await startServer(t, resolve("test/fixtures/question-rpc.mjs"));
    const sessionID = await createSession(url);
    const stream = startEvents(url, "/api/event");
    t.after(stream.close);
    await stream.ready;
    const created = stream.waitFor("form.created", () => true);
    await sendPrompt(url, sessionID, "idle");
    await created;
    const listed: unknown = await (await fetch(`${url}/api/session/${sessionID}/question`)).json();
    assert.ok(isRecord(listed) && Array.isArray(listed.data));
    const question: unknown = listed.data[0];
    assert.ok(isRecord(question) && typeof question.id === "string");
    const path = `/api/session/${sessionID}/question/${question.id}`;
    assert.equal((await fetch(`${url}${path}`)).status, 200);
    assert.equal((await fetch(`${url}/api/session/${sessionID}/question/missing`)).status, 404);
    const pi = server["sessions"].get(sessionID)?.pi;
    assert.ok(pi);
    const respond = (body: unknown = { answers: [["A"], ["details"]] }) =>
      fetch(`${url}${path}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    if (action === "reply") {
      assert.equal((await respond({ answers: "invalid" })).status, 400);
      assert.equal((await respond({ answers: [] })).status, 409);
    }
    await pi.command({ type: "refuse_next" });
    assert.equal((await respond()).status, 409);
    assert.equal((await fetch(`${url}${path}`)).status, 200);
    const settled = stream.waitFor(action === "reply" ? "form.replied" : "form.cancelled", () => true);
    assert.equal((await respond()).status, 204);
    await settled;
    assert.equal((await fetch(`${url}${path}`)).status, 404);
    assert.equal((await respond()).status, 404);
    const native = await pi.command<{ prompts: number; responses: Array<{ cancelled?: boolean }> }>({
      type: "get_state",
    });
    assert.equal(native.data?.prompts, 1);
    assert.equal(native.data?.responses.at(-1)?.cancelled === true, action === "reject");
  });
}

test("R-033: model parsing preserves precedence and ignores incomplete selectors", () => {
  assert.equal(modelRefFromBody(undefined), undefined);
  assert.equal(modelRefFromBody({ providerID: "fake" }), undefined);
  assert.equal(modelRefFromBody({ modelID: "model" }), undefined);
  assert.deepEqual(modelRefFromBody({ providerID: "fake", id: "v2", modelID: "legacy", variant: "low" }, "high"), {
    providerID: "fake",
    modelID: "v2",
    variant: "high",
  });
  assert.deepEqual(modelRefFromBody({ providerID: "fake", modelID: "legacy", variant: "low" }), {
    providerID: "fake",
    modelID: "legacy",
    variant: "low",
  });
  for (const value of [null, "", "-1", "NaN", "Infinity"]) assert.equal(numberParam(value), undefined);
  assert.equal(numberParam("0"), 0);
});

test("R-033: registry updates retain unrelated records and reject malformed metadata", (t) => {
  const root = mkdtempSync(join(tmpdir(), "antechamber-registry-edges-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  const entry = { piSessionId: "native", piPath: join(root, "session.jsonl"), directory: root, created: 1, updated: 2 };
  store.set("ses_custom", { ...entry, metadata: { openchamber: { work: { state: "active" } } } });
  store.update("missing", { title: "must not create" });
  store.update("ses_custom", { title: "renamed" });
  const restored = new SessionStore(root);
  assert.equal(restored.get("missing"), undefined);
  assert.equal(restored.idFor("native"), "ses_custom");
  assert.equal(restored.get("ses_custom")?.title, "renamed");
  assert.deepEqual(restored.get("ses_custom")?.metadata, { openchamber: { work: { state: "active" } } });
  writeFileSync(
    join(root, "sessions.json"),
    JSON.stringify({
      ses_valid: entry,
      ses_invalid: { ...entry, metadata: [] },
    }),
  );
  const parsed = new SessionStore(root);
  assert.ok(parsed.get("ses_valid"));
  assert.equal(parsed.get("ses_invalid"), undefined);
});

test("session identity and OpenChamber metadata survive manager restart", async (t) => {
  const { directory } = await startServer(t);
  const state = join(directory, "metadata-state");
  const first = new SessionManager(() => undefined, new SessionStore(state), directory);
  const metadata = { openchamber: { multirun: { version: 1 }, work: { state: "active" } } };
  const info = await first.create(directory, undefined, "ses_parent", {
    id: "ses_requested",
    agent: "build",
    metadata,
  });
  await first.update(info.id, { metadata: { ...metadata, source: "patched" } });
  await first.disposeAll();
  const second = new SessionManager(() => undefined, new SessionStore(state), directory);
  t.after(() => second.disposeAll());
  const restored = second.get(info.id);
  assert.equal(restored?.info.id, "ses_requested");
  assert.equal(restored?.info.parentID, "ses_parent");
  assert.equal(restored?.info.agent, "build");
  assert.deepEqual(restored?.info.metadata, { ...metadata, source: "patched" });
});

test("v2 session creation rejects invalid settings and concurrent duplicate identities", {
  timeout: 15_000,
}, async (t) => {
  const { url } = await startServer(t);
  const create = (body: unknown) =>
    fetch(`${url}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  for (const body of [
    null,
    { id: 1 },
    { agent: 1 },
    { title: 1 },
    { parentID: 1 },
    { location: 1 },
    { location: { directory: 0 } },
    { model: { providerID: "fake" } },
    { metadata: [] },
  ]) {
    assert.equal((await create(body)).status, 400, JSON.stringify(body));
  }
  const responses = await Promise.all([create({ id: "ses_duplicate" }), create({ id: "ses_duplicate" })]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 400]);
});

async function sendPrompt(url: string, sessionId: string, text: string): Promise<void> {
  assert.equal(
    (
      await fetch(`${url}/session/${sessionId}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parts: [{ type: "text", text }] }),
      })
    ).status,
    200,
  );
}

for (const failure of ["rejected", "unsuccessful"])
  test(`abort ${failure} returns an OpenCode error without cancelling children`, { timeout: 30_000 }, async (t) => {
    const { url, server } = await startServer(t);
    const sessionId = await createSession(url);
    const pi = server["sessions"].get(sessionId)?.pi;
    assert.ok(pi);
    const original = pi.command.bind(pi);
    t.mock.method(pi, "command", async (...args: Parameters<PiRpcClient["command"]>) => {
      if (args[0].type !== "abort") return original(...args);
      if (failure === "rejected") throw new Error("abort transport failed");
      return { type: "response", id: "abort", command: "abort", success: false, error: "abort denied" };
    });
    const stop = t.mock.method(server["sessions"].subagents, "stopParent", () => {});
    for (const path of [`/session/${sessionId}/abort`, `/api/session/${sessionId}/interrupt`]) {
      const response = await fetch(`${url}${path}`, { method: "POST" });
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), {
        name: "UnknownError",
        data: { message: failure === "rejected" ? "abort transport failed" : "abort denied" },
      });
      assert.equal(stop.mock.callCount(), 0);
    }
  });

test("command catalog maps OmO commands for v1 and v2", { timeout: 30_000 }, async (t) => {
  const { url, directory } = await startServer(t);
  const expected = [
    { name: "fixture", description: "Fixture command", template: "", source: "command", hints: [], subtask: false },
  ];

  const v1 = await fetch(`${url}/command`);
  assert.equal(v1.status, 200);
  assert.deepEqual(await v1.json(), expected);

  const v2 = await fetch(`${url}/api/command`);
  assert.equal(v2.status, 200);
  assert.deepEqual(await v2.json(), { location: { directory }, data: expected });
});

test("slash command routes prompt OmO and reject an empty command", { timeout: 30_000 }, async (t) => {
  const { url } = await startServer(t);
  const sessionId = await createSession(url);

  const empty = await fetch(`${url}/session/${sessionId}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command: "", arguments: "" }),
  });
  assert.equal(empty.status, 400);

  const v1 = await fetch(`${url}/session/${sessionId}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command: "missing-command", arguments: "one" }),
  });
  assert.equal(v1.status, 200);
  assert.match(JSON.stringify(await v1.json()), /\/missing-command one/);

  const v2 = await fetch(`${url}/api/session/${sessionId}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "another-missing-command", text: "two" }),
  });
  assert.equal(v2.status, 204);
  assert.equal(await v2.text(), "");
  const history = await (await fetch(`${url}/session/${sessionId}/message`)).json();
  assert.match(JSON.stringify(history), /\/another-missing-command two/);
});

test("slash command reuses the client messageID for its user message", { timeout: 30_000 }, async (t) => {
  const { url } = await startServer(t);
  const sessionId = await createSession(url);
  const messageID = "msg_client_optimistic_command";

  const response = await fetch(`${url}/session/${sessionId}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command: "skill:fixture", arguments: "plan it", messageID }),
  });
  assert.equal(response.status, 200);
  await response.json();

  const history: unknown = await (await fetch(`${url}/session/${sessionId}/message`)).json();
  assert.ok(Array.isArray(history));
  const users = history.filter(
    (message: unknown) => isRecord(message) && isRecord(message.info) && message.info.role === "user",
  );
  assert.deepEqual(
    users.map((message: { info: { id: string } }) => message.info.id),
    [messageID],
  );
});

test("bare skill slash command resends as OmO's /skill: form", { timeout: 30_000 }, async (t) => {
  const { url } = await startServer(t);
  const sessionId = await createSession(url);

  const response = await fetch(`${url}/session/${sessionId}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command: "impeccable", arguments: "polish it" }),
  });
  assert.equal(response.status, 200);
  const history = JSON.stringify(await (await fetch(`${url}/session/${sessionId}/message`)).json());
  assert.match(history, /reply: \/skill:impeccable polish it/);
  assert.doesNotMatch(history, /Unknown command/);
});

test("v2 shell lifecycle uses native shell and output resource shapes", { timeout: 15_000 }, async (t) => {
  const { url, directory } = await startServer(t);
  const sessionID = await createSession(url);
  const stream = startEvents(url, "/api/event");
  t.after(stream.close);
  await stream.ready;
  const started = stream.waitFor("session.shell.started", (event) => event.data?.sessionID === sessionID);
  const ended = stream.waitFor("session.shell.ended", (event) => event.data?.sessionID === sessionID);
  const response = await fetch(`${url}/api/session/${sessionID}/shell`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command: "exit 7" }),
  });
  assert.equal(response.status, 204);
  const [start, end] = await Promise.all([started, ended]);
  const shell = end.data?.shell;
  const output = end.data?.output;
  assert.ok(isRecord(shell) && isRecord(output));
  assert.equal(shell.status, "exited");
  assert.equal(shell.exit, 7);
  assert.equal(shell.cwd, directory);
  assert.equal(shell.command, "exit 7");
  assert.ok(isRecord(start.data?.shell));
  assert.equal(start.data.shell.id, shell.id);
  assert.equal(start.data.shell.status, "running");
  assert.ok(isRecord(shell.time));
  assert.equal(typeof shell.time.started, "number");
  assert.equal(typeof shell.time.completed, "number");
  assert.equal(output.output, "SHELL_OUTPUT");
  assert.equal(output.cursor, Buffer.byteLength("SHELL_OUTPUT"));
  assert.equal(output.size, Buffer.byteLength("SHELL_OUTPUT"));
  assert.equal(output.truncated, false);
});

test("shell route emits a bash card with output and exit code", { timeout: 30_000 }, async (t) => {
  const { url } = await startServer(t);
  const sessionId = await createSession(url);
  const stream = startEvents(url);
  t.after(stream.close);
  await stream.ready;

  const assistantUpdated = stream.waitFor(
    "message.updated",
    (event) =>
      JSON.stringify(event).includes(`"sessionID":"${sessionId}"`) &&
      JSON.stringify(event).includes('"role":"assistant"'),
  );
  const completedPart = stream.waitFor(
    "message.part.updated",
    (event) =>
      JSON.stringify(event).includes('"tool":"bash"') && JSON.stringify(event).includes('"status":"completed"'),
  );
  const response = await fetch(`${url}/session/${sessionId}/shell`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command: "exit 3" }),
  });
  assert.equal(response.status, 200);
  assert.match(JSON.stringify(await response.json()), /"role":"assistant"/);
  const [messageEvent, partEvent] = await Promise.all([assistantUpdated, completedPart]);
  assert.match(JSON.stringify(messageEvent), /assistant/);
  assert.match(JSON.stringify(partEvent), /SHELL_OUTPUT/);
  assert.match(JSON.stringify(partEvent), /"exitCode":3/);

  const v2CompletedPart = stream.waitFor("message.part.updated", (event) =>
    JSON.stringify(event).includes('"exitCode":4'),
  );
  const v2 = await fetch(`${url}/api/session/${sessionId}/shell`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command: "exit 4", agent: "OmO" }),
  });
  assert.equal(v2.status, 204);
  assert.equal(await v2.text(), "");
  await v2CompletedPart;
});

test("shell synthetic users arrive over v2 SSE without an optimistic prompt", { timeout: 30_000 }, async (t) => {
  const { url } = await startServer(t);
  const sessionId = await createSession(url);
  const stream = startEvents(url, "/api/event");
  t.after(stream.close);
  await stream.ready;
  const prompted = stream.waitFor("session.prompted", (event) => event.data?.sessionID === sessionId);
  const shell = await fetch(`${url}/api/session/${sessionId}/shell`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command: "echo paired" }),
  });
  assert.equal(shell.status, 204);
  const event = await prompted;
  const history: unknown = await (await fetch(`${url}/api/session/${sessionId}/message?order=asc`)).json();
  assert.ok(isRecord(history) && Array.isArray(history.data));
  const user: unknown = history.data.find((message: unknown) => isRecord(message) && message.type === "user");
  assert.ok(isRecord(user));
  assert.equal(user.type, "user");
  assert.equal(event.data?.messageID, user.id);
  assert.ok(isRecord(event.data?.prompt));
  assert.equal(event.data.prompt.text, user.text);
});

test("slash command refreshes entries persisted without agent events", { timeout: 30_000 }, async (t) => {
  const { url } = await startServer(t);
  const sessionId = await createSession(url);
  await sendPrompt(url, sessionId, "before slash command");
  const stream = startEvents(url);
  t.after(stream.close);
  await stream.ready;
  const output = stream.waitFor("message.part.updated", (event) =>
    JSON.stringify(event).includes("Slash command output without agent events"),
  );
  const response = await fetch(`${url}/session/${sessionId}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command: "fixture", arguments: "" }),
  });
  assert.equal(response.status, 200);
  assert.match(JSON.stringify(await response.json()), /Slash command output without agent events/);
  const history = await fetch(`${url}/session/${sessionId}/message`);
  assert.equal(history.status, 200);
  assert.match(JSON.stringify(await history.json()), /Slash command output without agent events/);
  await output;
});

test("empty shell commands return a client error without creating a card", { timeout: 30_000 }, async (t) => {
  const { url } = await startServer(t);
  const sessionId = await createSession(url);
  const response = await fetch(`${url}/session/${sessionId}/shell`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command: "" }),
  });
  assert.equal(response.status, 400);
});

test("abort cancels a pending shell within ten seconds and tolerates repeated interruptions", {
  timeout: 30_000,
}, async (t) => {
  const { url, server } = await startServer(t);
  const sessionId = await createSession(url);
  const stream = startEvents(url);
  t.after(stream.close);
  await stream.ready;
  const pi = server["sessions"].get(sessionId)?.pi;
  assert.ok(pi);
  let resolveAbortBash: () => void = () => {};
  const abortBashDispatched = new Promise<void>((resolve) => {
    resolveAbortBash = resolve;
  });
  const pending = new Promise<void>((resolvePending) => {
    pi.onEvent((event) => {
      if (event.type === "fixture_bash_pending") resolvePending();
      if (event.type === "fixture_abort_bash") resolveAbortBash();
    });
  });
  const cancelled = stream.waitFor(
    "message.part.updated",
    (event) => JSON.stringify(event).includes('"status":"error"') && JSON.stringify(event).includes('"cancelled":true'),
  );
  const idle = stream.waitFor("session.idle", (event) => event.properties?.sessionID === sessionId);
  const shell = fetch(`${url}/session/${sessionId}/shell`, {
    method: "POST",
    body: JSON.stringify({ command: "sleep 600" }),
    signal: AbortSignal.timeout(10_000),
  });
  await pending;
  // R-069: the idle check and the busy transition happen in one tick, so a second shell is rejected.
  const second = await fetch(`${url}/session/${sessionId}/shell`, {
    method: "POST",
    body: JSON.stringify({ command: "echo SECOND" }),
  });
  assert.equal(second.status, 409);
  const started = performance.now();
  const aborts = await Promise.all([1, 2].map(() => fetch(`${url}/session/${sessionId}/abort`, { method: "POST" })));
  for (const response of aborts) {
    assert.equal(response.status, 200);
    assert.equal(await response.json(), true);
  }
  assert.equal((await shell).status, 200);
  // abort_bash is a notification, so the waiter is released before the agent reports it.
  await Promise.all([cancelled, idle, abortBashDispatched]);
  assert.ok(performance.now() - started < 10_000);
  assert.equal(server["sessions"].get(sessionId)?.status.type, "idle");
  assert.doesNotMatch(JSON.stringify(server["sessions"].messages(sessionId)), /echo SECOND/);
  const resumed = await fetch(`${url}/session/${sessionId}/shell`, {
    method: "POST",
    body: JSON.stringify({ command: "echo RESUMED" }),
  });
  assert.equal(resumed.status, 200);
});

test("a late bash reply cannot resurrect or duplicate a cancelled shell after reload", {
  timeout: 30_000,
}, async (t) => {
  const { url, server } = await startServer(t);
  const sessionId = await createSession(url);
  const pi = server["sessions"].get(sessionId)?.pi;
  assert.ok(pi);
  const pending = new Promise<void>((resolvePending) => {
    pi.onEvent((event) => {
      if (event.type === "fixture_bash_pending") resolvePending();
    });
  });
  const shell = fetch(`${url}/session/${sessionId}/shell`, {
    method: "POST",
    body: JSON.stringify({ command: "sleep 600 late" }),
    signal: AbortSignal.timeout(10_000),
  });
  await pending;
  await fetch(`${url}/session/${sessionId}/abort`, { method: "POST" });
  assert.equal((await shell).status, 200);
  // Release the fixture's native reply out of band. A queued HTTP shell must
  // not overtake the cancelled operation while its native reply is outstanding.
  assert.equal((await pi.command({ type: "bash", command: "echo RELEASE_LATE" })).success, true);
  await server["sessions"].reloadMessages(sessionId);
  const messages = server["sessions"].messages(sessionId) ?? [];
  const cancelled = messages
    .flatMap((message) => message.parts)
    .filter((part) => part.type === "tool" && part.state.input.command === "sleep 600 late");
  assert.equal(cancelled.length, 1);
  assert.match(JSON.stringify(cancelled[0]), /"status":"error"/);
  assert.match(JSON.stringify(cancelled[0]), /"cancelled":true/);
  assert.doesNotMatch(JSON.stringify(messages), /STALE_SUCCESS/);
  assert.equal(server["sessions"].get(sessionId)?.status.type, "idle");
});

// The transport's no-deadline behavior for bash is tested in pi-rpc.test.ts; this locks the route's wiring.
test("the shell route sends bash without an RPC deadline", {
  timeout: 30_000,
}, async (t) => {
  const { url, server } = await startServer(t);
  const sessionId = await createSession(url);
  const pi = server["sessions"].get(sessionId)?.pi;
  assert.ok(pi);
  const command = t.mock.method(pi, "command");
  const response = await fetch(`${url}/session/${sessionId}/shell`, {
    method: "POST",
    body: JSON.stringify({ command: "echo LOGIN" }),
  });
  assert.equal(response.status, 200);
  const bash = command.mock.calls.find((call) => call.arguments[0].type === "bash");
  assert.ok(bash);
  assert.equal(bash.arguments[1], undefined);
});

test("a running user shell shows its output live, before the command ends", { timeout: 30_000 }, async (t) => {
  const { url, server } = await startServer(t);
  const sessionId = await createSession(url);
  const stream = startEvents(url);
  const v2 = startEvents(url, "/api/event");
  t.after(stream.close);
  t.after(v2.close);
  await Promise.all([stream.ready, v2.ready]);
  const expected = "Open https://login.example.test/device\nWaiting for login...\n";
  const live = stream.waitFor("message.part.updated", (event) => {
    const text = JSON.stringify(event);
    return text.includes('"status":"running"') && text.includes("Waiting for login");
  });
  const progress = v2.waitFor("session.tool.progress", (event) => JSON.stringify(event).includes("Waiting for login"));
  const shell = fetch(`${url}/session/${sessionId}/shell`, {
    method: "POST",
    body: JSON.stringify({ command: "fixture-login" }),
    signal: AbortSignal.timeout(10_000),
  });
  const event = await live;
  const part = event.properties?.part as { state: { metadata?: { output?: unknown } } };
  assert.equal(part.state.metadata?.output, expected);
  const v2Event = (await progress) as { data?: { metadata?: { output?: unknown } } };
  assert.equal(v2Event.data?.metadata?.output, expected);
  assert.equal((await fetch(`${url}/session/${sessionId}/abort`, { method: "POST" })).status, 200);
  assert.equal((await shell).status, 200);
  // Stop keeps what the command printed on the cancelled card.
  const card = (server["sessions"].messages(sessionId) ?? [])
    .flatMap((message) => message.parts)
    .find((item) => item.type === "tool" && item.state.input.command === "fixture-login");
  assert.ok(card?.type === "tool" && card.state.status === "error");
  assert.equal(card.state.metadata?.cancelled, true);
  assert.equal(card.state.metadata?.output, expected);
});

test("a native cancelled bash reply without exitCode ends the card as cancelled", { timeout: 30_000 }, async (t) => {
  const { url } = await startServer(t);
  const sessionId = await createSession(url);
  const response = await fetch(`${url}/session/${sessionId}/shell`, {
    method: "POST",
    body: JSON.stringify({ command: "fixture-cancelled" }),
  });
  assert.equal(response.status, 200);
  const history = await fetch(`${url}/session/${sessionId}/message`).then((res) => res.json());
  assert.match(JSON.stringify(history), /"status":"error"/);
  assert.match(JSON.stringify(history), /"cancelled":true/);
  assert.match(JSON.stringify(history), /"exitCode":null/);
});

test("abort releases a shell waiting on history refresh and ignores the late entries reply", {
  timeout: 30_000,
}, async (t) => {
  const { url, server } = await startServer(t);
  const sessionId = await createSession(url);
  const pi = server["sessions"].get(sessionId)?.pi;
  assert.ok(pi);
  const pending = new Promise<void>((resolvePending) => {
    pi.onEvent((event) => {
      if (event.type === "fixture_entries_pending") resolvePending();
    });
  });
  const shell = fetch(`${url}/session/${sessionId}/shell`, {
    method: "POST",
    body: JSON.stringify({ command: "fixture-reload-pending" }),
    signal: AbortSignal.timeout(10_000),
  });
  await pending;
  const started = performance.now();
  assert.equal((await fetch(`${url}/session/${sessionId}/abort`, { method: "POST" })).status, 200);
  assert.equal((await shell).status, 200);
  assert.ok(performance.now() - started < 10_000);
  assert.equal(server["sessions"].get(sessionId)?.status.type, "idle");
  // The fixture control cannot itself be queued behind the refresh it releases.
  assert.equal((await pi.command({ type: "bash", command: "echo RELEASE_ENTRIES" })).success, true);
  await server["sessions"].reloadMessages(sessionId);
  const parts = (server["sessions"].messages(sessionId) ?? [])
    .flatMap((message) => message.parts)
    .filter((part) => part.type === "tool" && part.state.input.command === "fixture-reload-pending");
  assert.equal(parts.length, 1);
  assert.match(JSON.stringify(parts), /"status":"error"/);
  assert.match(JSON.stringify(parts), /"cancelled":true/);
  assert.equal(server["sessions"].get(sessionId)?.status.type, "idle");
});

test("abort without a running shell is a no-op", { timeout: 30_000 }, async (t) => {
  const { url, server } = await startServer(t);
  const sessionId = await createSession(url);
  const before = structuredClone(server["sessions"].messages(sessionId));
  const response = await fetch(`${url}/session/${sessionId}/abort`, { method: "POST" });
  assert.equal(response.status, 200);
  assert.equal(await response.json(), true);
  assert.deepEqual(server["sessions"].messages(sessionId), before);
  assert.equal(server["sessions"].get(sessionId)?.status.type, "idle");
});

test("F2 B5 abort cancels a queued shell before the preceding refresh completes", { timeout: 10_000 }, async (t) => {
  const { url, server } = await startServer(t);
  const sessionId = await createSession(url);
  const manager = server["sessions"];
  const pi = manager.get(sessionId)?.pi;
  assert.ok(pi);
  const command = pi.command.bind(pi);
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const commands: string[] = [];
  pi.command = async <T>(...args: Parameters<PiRpcClient["command"]>) => {
    commands.push(String(args[0].type));
    const response = await command<T>(...args);
    if (args[0].type === "get_entries") {
      held.resolve();
      await release.promise;
    }
    return response;
  };
  const stream = startEvents(url);
  t.after(stream.close);
  await stream.ready;
  const refresh = manager.reloadMessages(sessionId);
  await held.promise;
  const running = stream.waitFor("message.part.updated", (event) =>
    JSON.stringify(event).includes('"status":"running"'),
  );
  const shell = fetch(`${url}/session/${sessionId}/shell`, {
    method: "POST",
    body: JSON.stringify({ command: "echo NEVER_DISPATCH" }),
    signal: AbortSignal.timeout(2_000),
  });
  try {
    await running;
    const started = performance.now();
    assert.equal((await fetch(`${url}/session/${sessionId}/abort`, { method: "POST" })).status, 200);
    const response = await shell;
    assert.equal(response.status, 200);
    assert.ok(performance.now() - started < 2_000);
    assert.equal(manager.get(sessionId)?.status.type, "idle");
    const parts = manager.messages(sessionId)?.flatMap((message) => message.parts) ?? [];
    assert.ok(
      parts.some(
        (part) => part.type === "tool" && part.state.status === "error" && part.state.metadata?.cancelled === true,
      ),
    );
    assert.equal(commands.includes("bash"), false);
  } finally {
    release.resolve();
    await refresh;
    await manager["operations"].get(sessionId);
    pi.command = command;
  }
  assert.equal(commands.includes("bash"), false, "cancelled queue entries must never dispatch later");
  assert.equal(
    (
      await fetch(`${url}/session/${sessionId}/shell`, {
        method: "POST",
        body: JSON.stringify({ command: "echo RESUMED" }),
      })
    ).status,
    200,
  );
});

for (const version of ["v1", "v2"])
  test(`F2 B3 ${version} async prompt registry failure emits an error and retains visible failed state`, {
    timeout: 15_000,
  }, async (t) => {
    const { url, server } = await startServer(t);
    const sessionId = await createSession(url);
    const manager = server["sessions"];
    const pi = manager.get(sessionId)?.pi;
    assert.ok(pi);
    // Use the real failing filesystem boundary, not a mocked rejection.
    Object.defineProperty(manager, "store", { value: new SessionStore("/dev/null/F2-registry-failure") });
    const commands: string[] = [];
    const command = pi.command.bind(pi);
    pi.command = <T>(...args: Parameters<PiRpcClient["command"]>) => {
      commands.push(String(args[0].type));
      return command<T>(...args);
    };
    const stream = startEvents(url);
    t.after(stream.close);
    await stream.ready;
    const error = stream.waitFor("session.error", (event) => event.properties?.sessionID === sessionId);
    void error.catch(() => undefined);
    const path = version === "v1" ? `/session/${sessionId}/prompt_async` : `/api/session/${sessionId}/prompt`;
    const body =
      version === "v1"
        ? { messageID: "msg_failed_prompt", parts: [{ type: "text", text: "P3" }] }
        : { id: "msg_failed_prompt", text: "P3" };
    const response = await fetch(url + path, {
      method: "POST",
      body: JSON.stringify(body),
    });
    assert.equal(response.status, version === "v1" ? 204 : 200);
    await manager["operations"].get(sessionId);
    assert.equal(commands.includes("prompt"), false);
    // The direct control must still propagate the same essential write failure.
    await assert.rejects(manager.prompt(sessionId, "P3 control"), SessionPersistenceError);
    const event = await error;
    assert.ok(isRecord(event.properties?.error));
    assert.equal(event.properties.error.name, "SessionPersistenceError");
    const history: unknown = await fetch(`${url}/session/${sessionId}/message`).then((res) => res.json());
    assert.ok(Array.isArray(history));
    assert.ok(
      history.some(
        (message) =>
          isRecord(message) &&
          isRecord(message.info) &&
          message.info.role === "assistant" &&
          isRecord(message.info.error) &&
          message.info.error.name === "SessionPersistenceError",
      ),
    );
    assert.equal(manager.get(sessionId)?.status.type, "idle");
  });

test("a print-only slash command renders its notification and returns idle without agent events", {
  timeout: 30_000,
}, async (t) => {
  const { url, server } = await startServer(t);
  const sessionId = await createSession(url);
  const stream = startEvents(url);
  t.after(stream.close);
  await stream.ready;
  const output = stream.waitFor("message.part.updated", (event) =>
    JSON.stringify(event).includes("Print-only command output"),
  );
  const idle = stream.waitFor("session.idle", (event) => event.properties?.sessionID === sessionId);
  const response = await fetch(`${url}/session/${sessionId}/command`, {
    method: "POST",
    body: JSON.stringify({ command: "notify-fixture", arguments: "" }),
  });
  assert.equal(response.status, 200);
  assert.match(JSON.stringify(await response.json()), /Print-only command output/);
  await Promise.all([output, idle]);
  assert.equal(server["sessions"].get(sessionId)?.status.type, "idle");
});

test("shell refreshes persisted entries appended without agent events and retains its bash card", {
  timeout: 30_000,
}, async (t) => {
  const { url } = await startServer(t);
  const sessionId = await createSession(url);
  await sendPrompt(url, sessionId, "before shell");
  const stream = startEvents(url);
  t.after(stream.close);
  await stream.ready;
  const persistedPart = stream.waitFor("message.part.updated", (event) =>
    JSON.stringify(event).includes("Persisted shell output: exit 7"),
  );
  const updated = stream.waitFor("session.updated", (event) => JSON.stringify(event).includes(`"id":"${sessionId}"`));
  const response = await fetch(`${url}/session/${sessionId}/shell`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command: "exit 7" }),
  });
  assert.equal(response.status, 200);
  const history = await fetch(`${url}/session/${sessionId}/message`);
  assert.equal(history.status, 200);
  const messages: unknown = await history.json();
  assert.match(JSON.stringify(messages), /Persisted shell output: exit 7/);
  assert.match(JSON.stringify(messages), /"tool":"bash"/);
  assert.match(JSON.stringify(messages), /"output":"SHELL_OUTPUT"/);
  assert.match(JSON.stringify(messages), /"exitCode":7/);
  await Promise.all([persistedPart, updated]);
});

test("compact returns the small-session error and reloads compacted history", { timeout: 30_000 }, async (t) => {
  const { url } = await startServer(t);
  const smallSessionId = await createSession(url);
  const smallEvents = startEvents(url);
  t.after(smallEvents.close);
  await smallEvents.ready;
  const smallNotice = smallEvents.waitFor("message.part.updated", (event) =>
    JSON.stringify(event).includes("Nothing to compact"),
  );
  const small = await fetch(`${url}/session/${smallSessionId}/summarize`, { method: "POST", body: "{}" });
  assert.equal(small.status, 400);
  assert.match(JSON.stringify(await small.json()), /Nothing to compact \(session too small\)/);
  await smallNotice;

  const sessionId = await createSession(url);
  await sendPrompt(url, sessionId, "long context");
  const stream = startEvents(url);
  t.after(stream.close);
  await stream.ready;
  const updated = stream.waitFor("session.updated", (event) => JSON.stringify(event).includes(`"id":"${sessionId}"`));
  const compacted = await fetch(`${url}/session/${sessionId}/summarize`, { method: "POST", body: "{}" });
  assert.equal(compacted.status, 200);
  assert.equal(await compacted.json(), true);
  await updated;

  const history = await fetch(`${url}/session/${sessionId}/message`);
  assert.equal(history.status, 200);
  assert.match(JSON.stringify(await history.json()), /Compacted summary 1/);

  const v2Marker = stream.mark();
  const updatedV2 = stream.waitForAfter(v2Marker, "session.updated", (event) =>
    JSON.stringify(event).includes(`"id":"${sessionId}"`),
  );
  const compactedV2 = await fetch(`${url}/api/session/${sessionId}/summarize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(compactedV2.status, 200);
  assert.deepEqual(await compactedV2.json(), { data: true });
  await updatedV2;

  const v2History = await fetch(`${url}/api/session/${sessionId}/message?order=asc`);
  assert.equal(v2History.status, 200);
  assert.match(JSON.stringify(await v2History.json()), /Compacted summary 2/);
});

test("share and unshare return the unsupported payload on both API surfaces", { timeout: 30_000 }, async (t) => {
  const { url } = await startServer(t);
  const sessionId = await createSession(url);
  for (const [path, method] of [
    [`/session/${sessionId}/share`, "POST"],
    [`/session/${sessionId}/share`, "DELETE"],
    [`/api/session/${sessionId}/share`, "POST"],
    [`/api/session/${sessionId}/share`, "DELETE"],
  ] as const) {
    const response = await fetch(`${url}${path}`, { method });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), unsupportedShare);
  }
});

const emptyInputRoutes = [
  { path: "/session", route: "prompt_async", v1: true, noReply: false },
  { path: "/session", route: "prompt_async", v1: true, noReply: true },
  { path: "/session", route: "message", v1: true, noReply: false },
  { path: "/session", route: "message", v1: true, noReply: true },
  { path: "/api/session", route: "prompt", v1: false, noReply: false },
  { path: "/api/session", route: "synthetic", v1: false, noReply: false },
  { path: "/api/session", route: "context", v1: false, noReply: false },
] as const;

for (const { path, route, v1, noReply } of emptyInputRoutes) {
  for (const dormant of [false, true]) {
    test(`B2: ${path}/${route} noReply=${noReply} rejects empty input while ${dormant ? "dormant" : "live"}`, {
      timeout: 15_000,
    }, async (t) => {
      const { url, server } = await startServer(t);
      const sessionID = await createSession(url);
      const manager = server["sessions"];
      const managed = manager.get(sessionID);
      assert.ok(managed?.pi);
      const pi = managed.pi;
      const command = pi.command.bind(pi);
      const commands: string[] = [];
      t.mock.method(pi, "command", (...args: Parameters<PiRpcClient["command"]>) => {
        commands.push(String(args[0].type));
        return command(...args);
      });
      if (dormant) await manager["lifecycle"].dormant(managed);
      const emit = manager["emit"];
      const events: unknown[] = [];
      manager["emit"] = (...args) => {
        events.push(args);
        emit(...args);
      };
      const before = structuredClone({ info: managed.info, tree: managed.tree, messages: managed.messages });
      const operation = manager["operations"].get(sessionID);
      const inputs = v1
        ? [
            {},
            { parts: null },
            { parts: {} },
            { parts: "text" },
            { parts: [] },
            { parts: [{ type: "text", text: "" }] },
            { parts: [{ type: "text", text: " \n\t" }] },
          ]
        : [
            {},
            { text: null },
            { text: 123 },
            { text: {} },
            { text: "" },
            { text: " \n\t" },
            { text: " ", files: [], agents: [] },
          ];
      for (const input of inputs) {
        const response = await fetch(`${url}${path}/${sessionID}/${route}`, {
          method: "POST",
          body: JSON.stringify({ ...input, ...(noReply ? { noReply: true } : {}) }),
        });
        assert.equal(response.status, 400, JSON.stringify(input));
        const body: unknown = await response.json();
        assert.ok(isRecord(body));
        if (v1) {
          assert.equal(body.name, "InvalidRequestError");
          assert.ok(isRecord(body.data) && typeof body.data.message === "string");
        } else {
          assert.equal(body._tag, "InvalidRequestError");
          assert.equal(typeof body.message, "string");
        }
        assert.equal(manager["operations"].get(sessionID), operation, "no queue admission");
        assert.equal(managed.pi, dormant ? undefined : pi, "no session revival");
        assert.deepEqual({ info: managed.info, tree: managed.tree, messages: managed.messages }, before);
        assert.deepEqual(commands, [], "no RPC commands, including prompt and send_custom_message");
        assert.deepEqual(events, [], "no message or inbox events");
      }
    });
  }
}

test("B2: v2 prompt requires text even with explicit parts or attachments", { timeout: 10_000 }, async (t) => {
  const { url, server } = await startServer(t);
  const sessionID = await createSession(url);
  const manager = server["sessions"];
  const pi = manager.get(sessionID)?.pi;
  assert.ok(pi);
  const command = pi.command.bind(pi);
  const commands: string[] = [];
  t.mock.method(pi, "command", (...args: Parameters<PiRpcClient["command"]>) => {
    commands.push(String(args[0].type));
    return command(...args);
  });
  for (const body of [
    { parts: [{ type: "text", text: "not a replacement for text" }] },
    { files: [{ uri: "file:///workspace/brief.txt" }] },
    { text: null, agents: [{ name: "reviewer" }] },
    { text: "", parts: [{ type: "text", text: "not a replacement for text" }] },
  ]) {
    const response = await fetch(`${url}/api/session/${sessionID}/prompt`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400);
    const error: unknown = await response.json();
    assert.ok(isRecord(error) && error._tag === "InvalidRequestError");
  }
  assert.deepEqual(commands, []);
  assert.deepEqual(manager.messages(sessionID), []);
});

for (const v1 of [true, false]) {
  test(`B2: ${v1 ? "v1" : "v2"} attachment-only prompts still reach the agent`, {
    timeout: 15_000,
  }, async (t) => {
    const { url, server } = await startServer(t);
    const sessionID = await createSession(url);
    const manager = server["sessions"];
    const pi = manager.get(sessionID)?.pi;
    assert.ok(pi);
    const command = pi.command.bind(pi);
    const dispatched: Record<string, unknown>[] = [];
    t.mock.method(pi, "command", (...args: Parameters<PiRpcClient["command"]>) => {
      if (args[0].type === "prompt") dispatched.push(args[0]);
      return command(...args);
    });
    const inputs = v1
      ? [
          { parts: [{ type: "file", mime: "image/png", url: "data:image/png;base64,aW1hZ2U=" }] },
          { parts: [{ type: "file", mime: "text/plain", url: "data:text/plain,attachment" }] },
          { parts: [{ type: "file", mime: "text/plain", url: "file:///workspace/brief.txt" }] },
          { parts: [{ type: "agent", name: "reviewer" }] },
          {
            parts: [
              { type: "text", text: " " },
              { type: "text", text: "content" },
            ],
          },
        ]
      : [
          { text: "", files: [{ uri: "data:image/png;base64,aW1hZ2U=" }] },
          { text: " ", files: [{ uri: "data:text/plain,attachment" }] },
          { text: "", files: [{ uri: "file:///workspace/brief.txt" }] },
          { text: "\n", agents: [{ name: "reviewer" }] },
        ];
    for (const body of inputs) {
      const response = await fetch(
        `${url}${v1 ? `/session/${sessionID}/message` : `/api/session/${sessionID}/prompt`}`,
        { method: "POST", body: JSON.stringify(body) },
      );
      assert.equal(response.status, 200);
      await manager["operations"].get(sessionID);
    }
    assert.equal(dispatched.length, inputs.length);
    assert.deepEqual(dispatched[0]?.images, [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]);
    assert.ok(dispatched.slice(1).every((input) => String(input.message).trim() !== ""));
  });
}

test("inline attachments the native RPC cannot carry reach the agent as saved files", {
  timeout: 15_000,
}, async (t) => {
  const { url, directory, server } = await startServer(t);
  const sessionID = await createSession(url);
  const manager = server["sessions"];
  const pi = manager.get(sessionID)?.pi;
  assert.ok(pi);
  const command = pi.command.bind(pi);
  const dispatched: Record<string, unknown>[] = [];
  t.mock.method(pi, "command", (...args: Parameters<PiRpcClient["command"]>) => {
    if (args[0].type === "prompt") dispatched.push(args[0]);
    return command(...args);
  });
  const pdf = Buffer.from("%PDF-1.7\n\0binary");
  const uri = `data:application/pdf;base64,${pdf.toString("base64")}`;
  const v1 = await fetch(`${url}/session/${sessionID}/message`, {
    method: "POST",
    body: JSON.stringify({
      messageID: "msg_pdf",
      parts: [
        { type: "text", text: "summarize" },
        { type: "file", filename: "../report.pdf", mime: "application/pdf", url: uri },
      ],
    }),
  });
  assert.equal(v1.status, 200);
  await manager["operations"].get(sessionID);
  const v2 = await fetch(`${url}/api/session/${sessionID}/prompt`, {
    method: "POST",
    body: JSON.stringify({ text: "", files: [{ uri: "data:application/zip;base64,UEsDBA==" }] }),
  });
  assert.equal(v2.status, 200);
  await manager["operations"].get(sessionID);

  assert.equal(dispatched.length, 2);
  const references = dispatched.map((input) => {
    const line = String(input.message)
      .split("\n\n")
      .find((chunk) => chunk.startsWith("{"));
    assert.ok(line, String(input.message));
    return JSON.parse(line) as { filename?: string; mime: string; url: string };
  });
  const attachments = join(directory, "state", "attachments");
  const pdfPath = fileURLToPath(references[0]?.url ?? "");
  assert.equal(references[0]?.mime, "application/pdf");
  assert.equal(pdfPath, join(attachments, createHash("sha256").update(pdf).digest("hex"), "report.pdf"));
  assert.deepEqual(readFileSync(pdfPath), pdf);
  assert.equal(statSync(pdfPath).mode & 0o777, 0o600);
  const zipPath = fileURLToPath(references[1]?.url ?? "");
  assert.equal(references[1]?.mime, "application/zip");
  assert.ok(zipPath.startsWith(attachments) && zipPath.endsWith("/attachment"));
  assert.deepEqual(readFileSync(zipPath), Buffer.from("PK\x03\x04", "latin1"));

  // The saved path is re-derived when history binds the prompt, so it keeps one user identity.
  await manager.reloadMessages(sessionID);
  const users = manager.messages(sessionID)?.filter((message) => message.info.role === "user");
  assert.equal(users?.filter((message) => message.info.id === "msg_pdf").length, 1);
  assert.equal(users?.length, 2);
});

test("rich v1 prompts preserve native attachments and one user identity through reload", {
  timeout: 10_000,
}, async (t) => {
  const { url, directory, server } = await startServer(t);
  const sessionID = await createSession(url);
  const pi = server["sessions"].get(sessionID)?.pi;
  assert.ok(pi);
  const command = pi.command.bind(pi);
  const dispatched: Record<string, unknown>[] = [];
  t.mock.method(pi, "command", async (...args: Parameters<PiRpcClient["command"]>) => {
    if (args[0].type === "prompt") dispatched.push(args[0]);
    return command(...args);
  });
  const parts = [
    { type: "text", text: "use these" },
    { type: "file", filename: "brief.txt", mime: "text/plain", url: "data:text/plain;base64,aGVsbG8=" },
    { type: "file", filename: "image.png", mime: "image/png", url: "data:image/png;base64,aW1hZ2U=" },
    { type: "agent", name: "reviewer" },
  ];
  const response = await fetch(`${url}/session/${sessionID}/message`, {
    method: "POST",
    body: JSON.stringify({ messageID: "msg_rich", parts, delivery: "queue" }),
  });
  assert.equal(response.status, 200);
  await server["sessions"].reloadMessages(sessionID);
  const users = server["sessions"].messages(sessionID)?.filter((message) => message.info.role === "user");
  assert.deepEqual(
    users?.map((message) => message.info.id),
    ["msg_rich"],
  );
  assert.deepEqual(
    users?.[0]?.parts.map(({ id: _id, sessionID: _sessionID, messageID: _messageID, ...part }) => part),
    parts,
  );
  assert.equal(dispatched[0]?.streamingBehavior, "followUp");
  assert.deepEqual(dispatched[0]?.images, [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]);
  assert.ok(String(dispatched[0]?.message).includes("hello"));
  assert.ok(String(dispatched[0]?.message).includes("reviewer"));
  const { SessionManager } = await import("../src/sessions.js");
  const restored = new SessionManager(() => {}, undefined, directory);
  t.after(() => restored.disposeAll());
  assert.deepEqual(
    restored.messages(sessionID)?.find((message) => message.info.id === "msg_rich")?.parts,
    users?.[0]?.parts,
  );
});

test("unavailable sharing emits a user-visible session error", { timeout: 30_000 }, async (t) => {
  const { url } = await startServer(t);
  const sessionId = await createSession(url);
  const stream = startEvents(url);
  t.after(stream.close);
  await stream.ready;
  const shareError = stream.waitFor("session.error", (event) =>
    JSON.stringify(event).includes("Sharing is not available with OmO"),
  );
  const notice = stream.waitFor("message.part.updated", (event) =>
    JSON.stringify(event).includes('"text":"Sharing is not available with OmO"'),
  );

  const response = await fetch(`${url}/session/${sessionId}/share`, { method: "POST" });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), unsupportedShare);
  const [event] = await Promise.all([shareError, notice]);
  assert.match(JSON.stringify(event), /Sharing is not available with OmO/);
});
