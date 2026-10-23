import assert from "node:assert/strict";
import test from "node:test";
import { AdapterServer } from "../src/server.js";
import { bugHarness, openEvents } from "./bug-harness.js";

test("v2 HTTP validates delivery and publishes admitted inbox identities through SSE and GET", {
  timeout: 15000,
}, async (t) => {
  const h = bugHarness(t);
  const server = new AdapterServer({ host: "127.0.0.1", port: 0, defaultDirectory: h.root });
  await server.start();
  const stream = await openEvents(`${server.url}/api/event`);
  t.after(async () => {
    await stream.close();
    await server.stop();
  });
  const created = (await (await fetch(`${server.url}/api/session`, { method: "POST", body: "{}" })).json()) as {
    data: { id: string };
  };
  const sessionID = created.data.id;
  const prompt = (body: Record<string, unknown>) =>
    fetch(`${server.url}/api/session/${sessionID}/prompt`, { method: "POST", body: JSON.stringify(body) });
  assert.equal((await prompt({ id: "invalid", text: "hold", delivery: "bogus" })).status, 400);
  const first = stream.wait(
    (e) => e.type === "session.inbox.enqueued" && (e.data as { inboxID: string }).inboxID === "msg_hold",
  );
  const response = await prompt({ id: "msg_hold", text: "hold" });
  assert.equal(response.status, 200);
  await first;
  const accepted = stream.wait(
    (e) => e.type === "session.inbox.enqueued" && (e.data as { inboxID: string }).inboxID === "msg_queued",
  );
  assert.equal((await prompt({ id: "msg_queued", text: "same", delivery: "queue" })).status, 200);
  const event = await accepted;
  assert.equal((event.data as { item: { delivery: string } }).item.delivery, "queue");
  const history = (await (await fetch(`${server.url}/api/session/${sessionID}/message?order=asc`)).json()) as {
    data: Array<{ id: string }>;
  };
  assert.deepEqual(
    history.data.filter((m) => ["msg_hold", "msg_queued"].includes(m.id)).map((m) => m.id),
    ["msg_hold", "msg_queued"],
  );
  assert.equal(
    stream.frames.some(
      (e) => e.type === "session.inbox.delivered" && (e.data as { inboxID: string }).inboxID === "msg_queued",
    ),
    false,
  );
});

function bounded<T>(work: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("admission waited for held turn")), 3000);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

for (const delivery of ["steer", "queue"] as const) {
  test(`${delivery} admits busy input before releasing the held run and preserves its identity`, {
    timeout: 15000,
  }, async (t) => {
    const h = bugHarness(t);
    const session = await h.manager.create(h.root);
    await h.manager.prompt(session.id, "hold", undefined, false, "msg_first");
    const managed = h.manager.get(session.id);
    assert.ok(managed?.pi);
    const tool = managed.toolByCallId.get("held-tool");
    assert.ok(tool);
    await bounded(h.manager.prompt(session.id, "same", undefined, false, "msg_second", delivery));
    await bounded(h.manager.prompt(session.id, "same", undefined, false, "msg_third", delivery));
    const inspection = await managed.pi.command<{
      active: string;
      commands: Array<{ type: string; streamingBehavior?: string; clientMessageId?: string }>;
    }>({ type: "inspect" });
    assert.equal(inspection.data?.active, "msg_first");
    assert.deepEqual(
      inspection.data?.commands.filter((c) => c.type === "prompt").map((c) => c.streamingBehavior),
      ["steer", delivery === "queue" ? "followUp" : "steer", delivery === "queue" ? "followUp" : "steer"],
    );
    assert.equal(managed.status.type, "busy");
    assert.equal(managed.toolByCallId.get("held-tool"), tool);
    assert.equal(h.events.filter((e) => e.type === "session.error").length, 0);
    assert.equal(
      h.frames.filter(
        (e) => e.type === "session.inbox.enqueued" && ["msg_second", "msg_third"].includes(String(e.data.inboxID)),
      ).length,
      2,
    );
    assert.equal(
      h.frames.filter(
        (e) => e.type === "session.inbox.delivered" && ["msg_second", "msg_third"].includes(String(e.data.inboxID)),
      ).length,
      0,
    );
    await managed.pi.command({ type: "release" });
    const users = h.manager.messages(session.id)?.filter((m) => m.info.role === "user");
    assert.deepEqual(
      users?.map((m) => m.info.id),
      ["msg_first", "msg_second", "msg_third"],
    );
    const answers = h.manager
      .messages(session.id)
      ?.filter((m) => m.info.role === "assistant" && m.info.time.completed !== undefined);
    assert.deepEqual(
      answers?.map((m) => (m.info.role === "assistant" ? m.info.parentID : "")),
      ["msg_first", "msg_second", "msg_third"],
    );
    assert.equal(
      h.frames.filter(
        (e) => e.type === "session.inbox.delivered" && ["msg_second", "msg_third"].includes(String(e.data.inboxID)),
      ).length,
      2,
    );
    await h.restart();
    assert.deepEqual(
      h.manager
        .messages(session.id)
        ?.filter((m) => m.info.role === "user")
        .map((m) => m.info.id),
      ["msg_first", "msg_second", "msg_third"],
    );
  });
}

test("a bare busy RPC prompt reproduces the short command timeout", async (t) => {
  const h = bugHarness(t);
  const session = await h.manager.create(h.root);
  const pi = h.manager.get(session.id)?.pi;
  assert.ok(pi);
  await pi.command({ type: "prompt", message: "hold", streamingBehavior: "steer" });
  await assert.rejects(pi.command({ type: "prompt", message: "bare" }, 25), {
    reason: { kind: "timeout", command: "prompt", ms: 25 },
  });
});

test("queued durable admission restores one pending card until its input is consumed", async (t) => {
  const h = bugHarness(t);
  const session = await h.manager.create(h.root);
  await h.manager.prompt(session.id, "hold", undefined, false, "msg_first");
  await bounded(h.manager.prompt(session.id, "same", undefined, false, "msg_pending", "queue"));
  await h.restart();
  const pending = h.manager.messages(session.id)?.filter((m) => m.info.id === "msg_pending");
  assert.equal(pending?.length, 1);
  assert.equal(pending?.[0]?.info.role, "user");
  assert.equal(pending?.[0]?.parts[0]?.type === "text" ? pending[0].parts[0].text : "", "same");
});

test("native injected user messages are visible once and become the assistant parent", async (t) => {
  const h = bugHarness(t);
  const session = await h.manager.create(h.root);
  await h.manager.prompt(session.id, "normal", undefined, false, "msg_first");
  const pi = h.manager.get(session.id)?.pi;
  assert.ok(pi);
  await pi.command({ type: "inject", message: "native-input" });
  const messages = h.manager.messages(session.id) ?? [];
  const injected = messages.filter(
    (m) => m.info.role === "user" && m.parts.some((p) => p.type === "text" && p.text === "native-input"),
  );
  assert.equal(injected.length, 1);
  const answer = messages.at(-1);
  assert.equal(answer?.info.role === "assistant" ? answer.info.parentID : "", injected[0]?.info.id);
});

test("admission rejection removes phantom input while successful idle input starts immediately", async (t) => {
  const h = bugHarness(t);
  const session = await h.manager.create(h.root);
  await h.manager.prompt(session.id, "normal", undefined, false, "msg_started", "queue");
  assert.equal(h.manager.messages(session.id)?.filter((m) => m.info.role === "assistant").length, 1);
  await h.manager.prompt(session.id, "reject", undefined, false, "msg_rejected");
  assert.equal(
    h.manager.messages(session.id)?.some((m) => m.info.id === "msg_rejected"),
    false,
  );
  assert.ok(h.events.some((e) => e.type === "message.removed" && e.properties.messageID === "msg_rejected"));
  assert.equal(
    h.frames.some((e) => e.type === "session.inbox.enqueued" && e.data.inboxID === "msg_rejected"),
    false,
  );
});
