import assert from "node:assert/strict";
import { globSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { AdapterServer } from "../src/server.js";
import { SessionManager } from "../src/sessions.js";
import { openEvents } from "./bug-harness.js";

async function startServer(t: TestContext, holdCompact = false, progress = false) {
  const root = mkdtempSync(join(tmpdir(), "antechamber-v261-turns-"));
  const keys = [
    "ANTECHAMBER_PI_BINARY",
    "ANTECHAMBER_STATE_DIR",
    "PI_CODING_AGENT_DIR",
    "ANTECHAMBER_TEST_HOLD_COMPACT",
    "ANTECHAMBER_TEST_COMPACT_PROGRESS",
  ];
  const saved = keys.map((key) => [key, process.env[key]] as const);
  process.env.ANTECHAMBER_PI_BINARY = resolve("test/fixtures/turn-omo.mjs");
  process.env.ANTECHAMBER_STATE_DIR = join(root, "state");
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  if (holdCompact) process.env.ANTECHAMBER_TEST_HOLD_COMPACT = "1";
  if (progress) process.env.ANTECHAMBER_TEST_COMPACT_PROGRESS = "1";
  let server = new AdapterServer({ host: "127.0.0.1", port: 0, defaultDirectory: root });
  await server.start();
  t.after(async () => {
    await server.stop();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const headers = { "content-type": "application/json", "x-opencode-directory": encodeURIComponent(root) };
  const request = (path: string, body?: object) =>
    fetch(`${server.url}${path}`, {
      headers,
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5_000),
    });
  const created = await request("/api/session", { location: { directory: root } });
  assert.equal(created.status, 200);
  const { data } = (await created.json()) as { data: { id: string } };
  return {
    root,
    get server() {
      return server;
    },
    request,
    sessionID: data.id,
    native() {
      const manager: unknown = Reflect.get(server, "sessions");
      assert.ok(manager instanceof SessionManager);
      return manager;
    },
    async restart() {
      await server.stop();
      server = new AdapterServer({ host: "127.0.0.1", port: 0, defaultDirectory: root });
      await server.start();
    },
  };
}

async function messages(request: (path: string) => Promise<Response>, id: string) {
  const response = await request(`/api/session/${id}/message?order=asc`);
  assert.equal(response.status, 200);
  return ((await response.json()) as { data: Array<Record<string, unknown>> }).data;
}

test("completed native turn has a durable idle outcome after history reload", { timeout: 15_000 }, async (t) => {
  const { request, sessionID, server, restart } = await startServer(t);
  const stream = await openEvents(`${server.url}/api/event`);
  t.after(() => stream.close());
  const idleEvent = stream.wait((event) => event.type === "session.idle");
  const prompted = await request(`/api/session/${sessionID}/prompt`, { text: "normal", id: "msg_turn" });
  assert.equal(prompted.status, 200);
  await idleEvent;
  const first = await messages(request, sessionID);
  const idle = first.find((message) => message.type === "idle");
  assert.equal(idle?.outcome, "succeeded");
  assert.ok(idle);
  await restart();
  const second = await messages(request, sessionID);
  const restored = second.find((message) => message.type === "idle");
  assert.equal(restored?.id, idle.id);
  assert.equal(restored?.outcome, idle.outcome);
});

test("a held tool turn has no idle record until native execution ends", { timeout: 15_000 }, async (t) => {
  const { request, sessionID, server, restart, native } = await startServer(t);
  const stream = await openEvents(`${server.url}/api/event`);
  t.after(() => stream.close());
  const admitted = stream.wait((event) => event.type === "session.inbox.enqueued");
  assert.equal(
    (await request(`/api/session/${sessionID}/prompt`, { text: "interrupted-work", id: "msg_held" })).status,
    200,
  );
  await admitted;
  assert.deepEqual(
    (await messages(request, sessionID)).filter((message) => message.type === "idle"),
    [],
  );
  const idleEvent = stream.wait((event) => event.type === "session.idle");
  assert.equal((await native().sessionRpc(sessionID, { type: "release" })).success, true);
  await idleEvent;
  const before = (await messages(request, sessionID)).filter((message) => message.type === "idle");
  assert.equal(before.length, 1);
  assert.equal(before[0]?.outcome, "succeeded");
  await restart();
  assert.deepEqual(
    (await messages(request, sessionID)).filter((message) => message.type === "idle"),
    before,
  );
});

test("interruption between tool steps has a durable interrupted boundary", { timeout: 15_000 }, async (t) => {
  const { request, sessionID, server, restart, native } = await startServer(t);
  const stream = await openEvents(`${server.url}/api/event`);
  t.after(() => stream.close());
  const admitted = stream.wait((event) => event.type === "session.inbox.enqueued");
  await request(`/api/session/${sessionID}/prompt`, { text: "interrupted-work", id: "msg_interrupted" });
  await admitted;
  assert.equal((await request(`/api/session/${sessionID}/interrupt`, {})).status, 200);
  const idleEvent = stream.wait((event) => event.type === "session.idle");
  // OmO may end an aborted tool run without emitting another assistant message.
  await native().sessionRpc(sessionID, { type: "emit", frame: { type: "agent_end" } });
  await native().sessionRpc(sessionID, { type: "emit", frame: { type: "agent_idle" } });
  await idleEvent;
  const before = (await messages(request, sessionID)).filter((message) => message.type === "idle");
  assert.equal(before.length, 1);
  assert.equal(before[0]?.outcome, "interrupted");
  await restart();
  assert.deepEqual(
    (await messages(request, sessionID)).filter((message) => message.type === "idle"),
    before,
  );
});

for (const [text, outcome] of [
  ["error", "failed"],
  ["aborted", "interrupted"],
] as const) {
  test(`native ${text} turn restores its ${outcome} idle outcome`, { timeout: 15_000 }, async (t) => {
    const { request, sessionID, server, restart } = await startServer(t);
    const stream = await openEvents(`${server.url}/api/event`);
    t.after(() => stream.close());
    const idleEvent = stream.wait((event) => event.type === "session.idle");
    assert.equal((await request(`/api/session/${sessionID}/prompt`, { text })).status, 200);
    await idleEvent;
    const before = (await messages(request, sessionID)).find((message) => message.type === "idle");
    assert.equal(before?.outcome, outcome);
    assert.ok(before);
    await restart();
    const after = (await messages(request, sessionID)).find((message) => message.type === "idle");
    assert.equal(after?.id, before.id);
    assert.equal(after?.outcome, outcome);
  });
}

test("native compaction lists as a completed compaction record", { timeout: 15_000 }, async (t) => {
  const { request, sessionID, server, restart } = await startServer(t);
  assert.equal((await request(`/api/session/${sessionID}/prompt`, { text: "normal" })).status, 200);
  const stream = await openEvents(`${server.url}/api/event`);
  t.after(() => stream.close());
  const ended = stream.wait((event) => event.type === "session.compaction.ended");
  const idle = stream.wait(
    (event) =>
      event.type === "session.status" && (event.data as { status?: { type?: string } }).status?.type === "idle",
  );
  assert.equal((await request(`/api/session/${sessionID}/compact`, { id: "msg_compact_requested" })).status, 200);
  await ended;
  await idle;
  const history = await messages(request, sessionID);
  const compacted = history.find((message) => message.type === "compaction");
  assert.equal(compacted?.status, "completed");
  assert.equal(compacted?.summary, "Summary of earlier work");
  assert.equal(compacted?.id, "msg_compact_requested");
  assert.ok(compacted);
  assert.equal(
    history.some((message) => message.type === "user" && message.text === "/compact"),
    false,
  );
  await restart();
  const restored = (await messages(request, sessionID)).find((message) => message.type === "compaction");
  assert.equal(restored?.id, compacted.id);
  assert.equal(restored?.status, compacted.status);
  assert.equal(restored?.summary, compacted.summary);
});

test("automatic native compaction preserves its reason after restart", { timeout: 15_000 }, async (t) => {
  const { server, request, sessionID, restart } = await startServer(t);
  const stream = await openEvents(`${server.url}/api/event`);
  t.after(() => stream.close());
  const ended = stream.wait((event) => event.type === "session.compaction.ended");
  assert.equal((await request(`/api/session/${sessionID}/prompt`, { text: "auto-compaction" })).status, 200);
  await ended;
  const live = (await messages(request, sessionID)).find((message) => message.type === "compaction");
  assert.equal(live?.reason, "auto");
  await restart();
  const restored = (await messages(request, sessionID)).find((message) => message.type === "compaction");
  assert.equal(restored?.reason, "auto");
  assert.equal(restored?.id, live?.id);
});

test("synthetic notice retains its description after history reload", { timeout: 15_000 }, async (t) => {
  const { request, sessionID, server, restart } = await startServer(t);
  const stream = await openEvents(`${server.url}/api/event`);
  t.after(() => stream.close());
  const delivered = stream.wait((event) => event.type === "session.inbox.delivered");
  assert.equal(
    (
      await request(`/api/session/${sessionID}/synthetic`, {
        text: "private context",
        description: "User-facing notice",
      })
    ).status,
    200,
  );
  await delivered;
  await restart();
  const history = await messages(request, sessionID);
  assert.equal(history.find((message) => message.type === "synthetic")?.description, "User-facing notice");
});

test("command carries attached files, agent mentions and queued delivery", { timeout: 15_000 }, async (t) => {
  const { root, request, sessionID, server } = await startServer(t);
  assert.equal(
    (await request(`/api/session/${sessionID}/prompt`, { text: "interrupted-work", id: "msg_active" })).status,
    200,
  );
  const stream = await openEvents(`${server.url}/api/event`);
  t.after(() => stream.close());
  const enqueued = stream.wait(
    (event) =>
      event.type === "session.inbox.enqueued" && (event.data as { inboxID?: string }).inboxID === "msg_command",
  );
  const response = await request(`/api/session/${sessionID}/command`, {
    name: "fixture",
    text: "inspect",
    id: "msg_command",
    files: [{ uri: "data:text/plain;base64,aGVsbG8=", name: "note.txt" }],
    agents: [{ name: "build" }],
    delivery: "queue",
  });
  assert.equal(response.status, 204);
  const delivered = await enqueued;
  assert.equal((delivered.data as { item: { delivery: string } }).item.delivery, "queue");
  const [sessionFile] = globSync(join(root, "agent", "sessions", "*", "*.jsonl"));
  assert.ok(sessionFile);
  const native = readFileSync(sessionFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { data?: { prepared?: { text?: string } } });
  const queuedText = native.findLast((entry) => entry.data?.prepared?.text)?.data?.prepared?.text;
  assert.match(queuedText ?? "", /note\.txt \(text\/plain\):\nhello/);
  assert.match(queuedText ?? "", /@build/);
  const history = await messages(request, sessionID);
  const command = history.find((message) => message.id === "msg_command");
  assert.equal(command?.type, "user");
  assert.deepEqual(
    (command?.files as Array<{ name: string }> | undefined)?.map((file) => file.name),
    ["note.txt"],
  );
  assert.deepEqual(
    (command?.agents as Array<{ name: string }> | undefined)?.map((agent) => agent.name),
    ["build"],
  );
});

test("compact returns its admitted item while native work is still running", { timeout: 15_000 }, async (t) => {
  const { server, request, sessionID } = await startServer(t, true);
  assert.equal((await request(`/api/session/${sessionID}/prompt`, { text: "normal" })).status, 200);
  const stream = await openEvents(`${server.url}/api/event`);
  t.after(() => stream.close());
  const started = stream.wait((event) => event.type === "session.compaction.started");
  const response = await request(`/api/session/${sessionID}/compact`, { id: "msg_requested_compact" });
  assert.equal(response.status, 200);
  const item = ((await response.json()) as { data: Record<string, unknown> }).data;
  assert.equal(item.id, "msg_requested_compact");
  assert.equal(item.type, "compaction");
  assert.equal(item.status, "running");
  await started;
});

for (const owner of ["user", "assistant", "synthetic"] as const) {
  test(`compaction rejects an ID owned by a ${owner} message`, { timeout: 15_000 }, async (t) => {
    const { server, request, sessionID, native } = await startServer(t);
    const stream = await openEvents(`${server.url}/api/event`);
    t.after(() => stream.close());
    const idle = stream.wait((event) => event.type === "session.idle");
    await request(`/api/session/${sessionID}/prompt`, { text: "normal", id: "msg_existing_user" });
    await idle;
    if (owner === "synthetic") {
      const delivered = stream.wait((event) => event.type === "session.inbox.delivered");
      await request(`/api/session/${sessionID}/synthetic`, { text: "context", id: "msg_context" });
      await delivered;
    }
    const before = await messages(request, sessionID);
    const owned = before.find((message) => message.type === owner);
    assert.ok(owned);
    const response = await request(`/api/session/${sessionID}/compact`, { id: owned.id });
    assert.equal(response.status, 409);
    assert.equal(((await response.json()) as { name: string }).name, "ConflictError");
    const inspected = await native().sessionRpc<{ commands: Array<{ type: string }> }>(sessionID, { type: "inspect" });
    assert.equal(
      inspected.data?.commands.some((command) => command.type === "compact"),
      false,
    );
    assert.deepEqual(await messages(request, sessionID), before);
  });
}

test("pending compaction retries reuse the admission without native redispatch", { timeout: 15_000 }, async (t) => {
  const { server, request, sessionID, native } = await startServer(t, true);
  await request(`/api/session/${sessionID}/prompt`, { text: "normal" });
  const stream = await openEvents(`${server.url}/api/event`);
  t.after(() => stream.close());
  const started = stream.wait((event) => event.type === "session.compaction.started");
  const [first, retry] = await Promise.all([
    request(`/api/session/${sessionID}/compact`, { id: "msg_pending" }),
    request(`/api/session/${sessionID}/compact`, { id: "msg_pending" }),
  ]);
  assert.equal(first.status, 200);
  assert.equal(retry.status, 200);
  const item = (await first.json()) as { data: Record<string, unknown> };
  assert.deepEqual(await retry.json(), item);
  await started;
  // Like OpenCode's pending inbox, a second request with a fresh ID joins the pending compaction.
  const joined = await request(`/api/session/${sessionID}/compact`, { id: "msg_joined" });
  assert.equal(joined.status, 200);
  assert.deepEqual(await joined.json(), item);
  const pi = native().get(sessionID)?.pi;
  assert.ok(pi);
  const inspected = await pi.command<{ commands: Array<{ type: string }> }>({ type: "inspect" });
  assert.equal(inspected.data?.commands.filter((command) => command.type === "compact").length, 1);
});

test("completed compaction retries retain the admitted ID across restart", { timeout: 15_000 }, async (t) => {
  const { server, request, sessionID, restart, native } = await startServer(t);
  await request(`/api/session/${sessionID}/prompt`, { text: "normal" });
  const stream = await openEvents(`${server.url}/api/event`);
  t.after(() => stream.close());
  const ended = stream.wait((event) => event.type === "session.compaction.ended");
  await request(`/api/session/${sessionID}/compact`, { id: "msg_idempotent" });
  await ended;
  // Await the operation barrier so completion's history binding has finished.
  await native().sessionRpc(sessionID, { type: "inspect" });
  const compacted = (await messages(request, sessionID)).find((message) => message.id === "msg_idempotent");
  assert.equal(compacted?.status, "completed");
  const retry = await request(`/api/session/${sessionID}/compact`, { id: "msg_idempotent" });
  assert.equal(retry.status, 200);
  assert.deepEqual(((await retry.json()) as { data: unknown }).data, compacted);
  await restart();
  const restored = await request(`/api/session/${sessionID}/compact`, { id: "msg_idempotent" });
  assert.equal(restored.status, 200);
  assert.deepEqual(((await restored.json()) as { data: unknown }).data, compacted);
});

test("native compaction progress emits its actual summary fragment", { timeout: 15_000 }, async (t) => {
  const { server, request, sessionID } = await startServer(t, false, true);
  assert.equal((await request(`/api/session/${sessionID}/prompt`, { text: "normal" })).status, 200);
  const stream = await openEvents(`${server.url}/api/event`);
  t.after(() => stream.close());
  const fragment = stream.wait((event) => event.type === "session.compaction.delta");
  assert.equal((await request(`/api/session/${sessionID}/compact`, { id: "msg_fragment" })).status, 200);
  const event = await fragment;
  assert.equal((event.data as { text: string }).text, "native summary fragment");
  assert.equal(typeof (event.data as { sessionID: string }).sessionID, "string");
});

test("native compaction refusal is reported after admission as a failure event", { timeout: 15_000 }, async (t) => {
  const { server, request, sessionID } = await startServer(t);
  const stream = await openEvents(`${server.url}/api/event`);
  t.after(() => stream.close());
  const failed = stream.wait((event) => event.type === "session.compaction.failed");
  const response = await request(`/api/session/${sessionID}/compact`, { id: "msg_refused" });
  assert.equal(response.status, 200);
  const item = ((await response.json()) as { data: { id: string } }).data;
  assert.equal(item.id, "msg_refused");
  const event = await failed;
  assert.equal((event.data as { inputID: string }).inputID, item.id);
});

test("an agent that dies during a compaction fails it, and the next compact starts a new one", {
  timeout: 20_000,
}, async (t) => {
  const { request, sessionID, server, native } = await startServer(t);
  const stream = await openEvents(`${server.url}/api/event`);
  t.after(() => stream.close());
  const idle = stream.wait((event) => event.type === "session.idle");
  await request(`/api/session/${sessionID}/prompt`, { text: "normal" });
  await idle;
  const started = stream.wait((event) => event.type === "session.compaction.started");
  await native().sessionRpc(sessionID, { type: "emit", frame: { type: "compaction_start", reason: "threshold" } });
  const deadID = ((await started).data as { inputID: string }).inputID;
  const failed = stream.wait(
    (event) => event.type === "session.compaction.failed" && (event.data as { inputID?: string }).inputID === deadID,
  );
  void native()
    .sessionRpc(sessionID, { type: "exit" })
    .catch(() => undefined);
  assert.equal(((await failed).data as { reason: string }).reason, "threshold");

  const compacted = await request(`/api/session/${sessionID}/compact`, {});
  assert.equal(compacted.status, 200);
  const item = ((await compacted.json()) as { data: { id: string } }).data;
  assert.notEqual(item.id, deadID, "a new compaction, not the dead one");
  const history = await messages(request, sessionID);
  assert.equal(
    history.some((message) => message.id === deadID && message.status === "running"),
    false,
  );
});
