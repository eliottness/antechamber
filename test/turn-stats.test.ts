import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import test from "node:test";
import { toV2Message, V2EventTranslator } from "../src/v2.js";
import type { V2Message } from "../src/v2.js";
import type { OCMessageWithParts } from "../src/types.js";
import { AdapterServer } from "../src/server.js";
import { parsePiSessionText } from "../src/session-history.js";
import type { ManagedSession } from "../src/sessions.js";
import { bugHarness, openEvents } from "./bug-harness.js";

for (const entrypoint of ["get", "list", "listAll"] as const) {
  test(`cold ${entrypoint} exposes session usage before reading history`, { timeout: 15000 }, async (t) => {
    const h = bugHarness(t);
    const directory = realpathSync(h.root);
    const session = await h.manager.create(directory);
    await h.manager.prompt(session.id, "steps");
    const expected = structuredClone(h.manager.get(session.id)?.info);
    assert.ok(expected?.cost && expected.tokens);
    await h.restart();

    const restored =
      entrypoint === "get"
        ? h.manager.get(session.id)?.info
        : (entrypoint === "list" ? h.manager.list(directory) : h.manager.listAll()).find((s) => s.id === session.id);

    assert.equal(restored?.cost, expected.cost);
    assert.deepEqual(restored?.tokens, expected.tokens);
    assert.equal(h.manager.liveSessions().length, 0);
  });
}

test("v2 usage stays cumulative across steps and turns", { timeout: 15000 }, async (t) => {
  const h = bugHarness(t);
  const session = await h.manager.create(h.root);
  await h.manager.prompt(session.id, "steps");
  const firstUsage = h.frames.filter((frame) => frame.type === "session.usage.updated");
  assert.equal(firstUsage[0]?.data.cost, 0.0123);
  assert.ok(firstUsage.length >= 2);
  assert.ok(firstUsage.slice(1).every((frame) => frame.data.cost === 0.0246));
  await h.manager.prompt(session.id, "normal");

  const lastUsage = h.frames.filter((frame) => frame.type === "session.usage.updated").at(-1);
  assert.equal(lastUsage?.data.cost, h.manager.get(session.id)?.info.cost);
  assert.deepEqual(lastUsage?.data.tokens, h.manager.get(session.id)?.info.tokens);
  const steps = h.frames.filter((frame) => frame.type === "session.step.ended");
  assert.deepEqual(
    steps.map((frame) => frame.data.cost),
    [0.0123, 0.0123, 0.0123],
  );
});

test("v2 session updates publish restored usage without starting a step", () => {
  const translator = new V2EventTranslator();
  const tokens = { input: 20, output: 5, reasoning: 2, cache: { read: 8, write: 3 } };
  const frames = translator.translate("/project", {
    type: "session.updated",
    properties: {
      info: {
        id: "ses_restored",
        projectID: "/project",
        directory: "/project",
        title: "Restored",
        version: "test",
        time: { created: 0, updated: 1 },
        cost: 1.25,
        tokens,
      },
    },
  });

  const usage = frames.filter((frame) => frame.type === "session.usage.updated");
  assert.equal(usage.length, 1);
  assert.deepEqual(usage[0]?.data, { sessionID: "ses_restored", cost: 1.25, tokens });
  assert.equal(
    frames.some((frame) => frame.type === "session.step.started"),
    false,
  );
});

test("v1 and v2 HTTP history agree with completion SSE before and after restart", { timeout: 15000 }, async (t) => {
  const h = bugHarness(t);
  let server = new AdapterServer({ host: "127.0.0.1", port: 0, defaultDirectory: h.root });
  await server.start();
  const v1 = await openEvents(`${server.url}/event`);
  const v2 = await openEvents(`${server.url}/api/event`);
  t.after(async () => {
    await v1.close();
    await v2.close();
    await server.stop();
  });
  const session = (await (await fetch(`${server.url}/session`, { method: "POST", body: "{}" })).json()) as {
    id: string;
  };
  const completed1 = v1.wait(
    (e) =>
      e.type === "message.updated" &&
      (e.properties as { info: { role: string; time: { completed?: number } } }).info.role === "assistant" &&
      (e.properties as { info: { time: { completed?: number } } }).info.time.completed !== undefined,
  );
  const completed2 = v2.wait((e) => e.type === "session.step.ended");
  const response = await fetch(`${server.url}/session/${session.id}/message`, {
    method: "POST",
    body: JSON.stringify({ messageID: "msg_http", parts: [{ type: "text", text: "normal" }] }),
  });
  assert.equal(response.status, 200);
  const event1 = await completed1;
  const event2 = await completed2;
  const assistant = (event1.properties as { info: OCMessageWithParts["info"] }).info;
  assert.equal(assistant.role, "assistant");
  if (assistant.role !== "assistant") return;
  const step = event2.data as Record<string, unknown>;
  assert.equal(step.finish, "stop");
  assert.equal(step.cost, assistant.cost);
  assert.deepEqual(step.tokens, assistant.tokens);
  for (const restored of [false, true]) {
    if (restored) {
      await v1.close();
      await v2.close();
      await server.stop();
      server = new AdapterServer({ host: "127.0.0.1", port: 0, defaultDirectory: h.root });
      await server.start();
    }
    const history1 = (await (
      await fetch(`${server.url}/session/${session.id}/message`)
    ).json()) as OCMessageWithParts[];
    const history2 = (await (await fetch(`${server.url}/api/session/${session.id}/message?order=asc`)).json()) as {
      data: V2Message[];
    };
    const found1 = history1.find((m) => m.info.role === "assistant");
    const found2 = history2.data.find((m) => m.type === "assistant");
    assert.ok(found1?.info.role === "assistant" && found2);
    assert.equal(found1.info.finish, "stop");
    assert.equal(found2.finish, "stop");
    assert.equal(found2.cost, assistant.cost);
    assert.deepEqual(found2.tokens, assistant.tokens);
    assert.equal(found2.model?.id, "served");
    assert.equal(found2.agent, assistant.mode);
    assert.equal(found1.info.time.completed, found2.time.completed);
    if (restored) assert.ok(found2.time.completed !== undefined && found2.time.completed > found2.time.created);
  }
});

for (const input of ["normal", "steps", "no-usage", "error", "aborted", "length", "pending", "deferred"]) {
  test(`turn statistics preserve protocol values live and restored for ${input}`, { timeout: 15000 }, async (t) => {
    const h = bugHarness(t);
    const session = await h.manager.create(h.root);
    await h.manager.prompt(session.id, input, undefined, false, "msg_input");
    const live = h.manager.messages(session.id)?.filter((m) => m.info.role === "assistant") ?? [];
    assert.equal(live.length, input === "steps" ? 2 : 1);
    const expected =
      input === "steps"
        ? ["tool-calls", "stop"]
        : [
            input === "error" || input === "aborted"
              ? "error"
              : input === "length"
                ? "length"
                : ["pending", "deferred"].includes(input)
                  ? undefined
                  : "stop",
          ];
    live.forEach((message, index) => {
      assert.equal(message.info.role, "assistant");
      if (message.info.role !== "assistant") return;
      assert.equal(message.info.finish, expected[index]);
      assert.equal(message.info.modelID, "served");
      assert.equal(message.info.parentID, "msg_input");
      assert.ok(message.info.time.completed);
      assert.equal(message.info.cost, input === "no-usage" ? 0 : 0.0123);
      assert.equal(message.info.tokens.input, input === "no-usage" ? 0 : 111);
      assert.equal(message.info.tokens.output, input === "no-usage" ? 0 : 22);
      assert.equal(message.info.tokens.reasoning, input === "no-usage" ? 0 : 3);
      assert.deepEqual(
        message.info.tokens.cache,
        input === "no-usage" ? { read: 0, write: 0 } : { read: 44, write: 5 },
      );
      if (input === "error" || input === "aborted") assert.ok(message.info.error);
      const completed = h.events.filter(
        (e) =>
          e.type === "message.updated" &&
          e.properties.info.role === "assistant" &&
          e.properties.info.id === message.info.id &&
          e.properties.info.time.completed !== undefined,
      );
      assert.equal(completed.length, 1);
      const deltas = h.frames.filter(
        (e) => e.type === "session.text.delta" && e.data.assistantMessageID === message.info.id,
      );
      assert.deepEqual(
        deltas.map((e) => e.data.delta),
        ["result"],
      );
      const v1Deltas = h.events.filter(
        (e) => e.type === "message.part.delta" && e.properties.messageID === message.info.id,
      );
      assert.deepEqual(
        v1Deltas.map((e) => (e.type === "message.part.delta" ? e.properties.delta : undefined)),
        ["result"],
      );
      const step = h.frames.filter(
        (e) =>
          e.type === (input === "error" || input === "aborted" ? "session.step.failed" : "session.step.ended") &&
          e.data.assistantMessageID === message.info.id,
      );
      assert.equal(step.length, 1);
      assert.equal(step[0]?.data[input === "error" || input === "aborted" ? "rawFinish" : "finish"], expected[index]);
      assert.deepEqual(step[0]?.data.tokens, message.info.tokens);
      if (input === "error" || input === "aborted") {
        assert.equal(step[0]?.data.cost, message.info.cost);
        assert.equal(step[0]?.data.finish, undefined);
        assert.deepEqual(step[0]?.data.error, message.info.error);
        const terminal = h.frames.filter(
          (e) =>
            e.data.sessionID === session.id &&
            ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(
              e.type,
            ),
        );
        assert.equal(terminal.length, 1);
        assert.equal(
          terminal[0]?.type,
          input === "error" ? "session.execution.failed" : "session.execution.interrupted",
        );
        if (input === "aborted") assert.equal(terminal[0]?.data.reason, "user");
      }
      const v2 = toV2Message(message);
      assert.equal(v2.finish, message.info.finish);
      assert.equal(v2.cost, message.info.cost);
      assert.deepEqual(v2.tokens, message.info.tokens);
    });
    const spent = live.reduce((sum, message) => sum + (message.info.role === "assistant" ? message.info.cost : 0), 0);
    // An absent cost means nothing was spent.
    assert.equal(h.manager.get(session.id)?.info.cost ?? 0, spent);
    const announced = h.events.flatMap((e) =>
      e.type === "session.updated" && e.properties.info.id === session.id ? [e.properties.info.cost ?? 0] : [],
    );
    assert.equal(announced.at(-1) ?? 0, spent);
    await h.restart();
    const restored = h.manager.messages(session.id)?.filter((m) => m.info.role === "assistant") ?? [];
    assert.equal(restored.length, live.length);
    assert.equal(h.manager.get(session.id)?.info.cost ?? 0, spent);
    restored.forEach((message, index) => {
      const previous = live[index];
      assert.ok(previous);
      assert.equal(message.info.role, "assistant");
      if (message.info.role !== "assistant" || previous.info.role !== "assistant") return;
      assert.equal(message.info.finish, expected[index]);
      assert.equal(message.info.modelID, "served");
      assert.equal(message.info.time.created, 1100);
      assert.equal(message.info.time.completed, 2000);
      const projection = toV2Message(message);
      assert.deepEqual(projection.tokens, previous.info.tokens);
      assert.equal(projection.cost, previous.info.cost);
      assert.equal(projection.finish, expected[index]);
    });
  });
}

test("restored replies sort after their prompt when the request started before pi wrote the prompt", () => {
  // Timing from a real OmO session file (2026-10-27): the prompt entry is written about 80 ms after the prompt's own
  // message.timestamp, and the reply's request (its message.timestamp) starts 15-18 ms before that entry.
  const at = (ms: number) => new Date(1_793_098_000_000 + ms).toISOString();
  let parent: string | undefined;
  const lines = [JSON.stringify({ type: "session", id: "pi", cwd: "/tmp/order", timestamp: at(0) })];
  const entry = (id: string, ms: number, message: Record<string, unknown>) => {
    lines.push(JSON.stringify({ type: "message", id, parentId: parent, timestamp: at(ms), message }));
    parent = id;
  };
  const user = (id: string, ms: number, sent: number, clientMessageId?: string) =>
    entry(id, ms, {
      role: "user",
      content: [{ type: "text", text: id }],
      timestamp: 1_793_098_000_000 + sent,
      ...(clientMessageId ? { clientMessageId } : {}),
    });
  const reply = (id: string, ms: number, started: number, content: unknown[], stopReason: string) =>
    entry(id, ms, {
      role: "assistant",
      content,
      provider: "fake",
      model: "served",
      timestamp: 1_793_098_000_000 + started,
      stopReason,
    });
  const cell = (id: string) => ({ type: "toolCall", id, name: "eval", arguments: { language: "js", code: "1" } });
  user("u1", 1470, 1387);
  reply("a1", 5746, 1455, [{ type: "text", text: "first" }, cell("cell1")], "toolUse");
  entry("r1", 5804, { role: "toolResult", toolCallId: "cell1", content: [{ type: "text", text: "ok" }] });
  reply("a2", 8598, 7436, [{ type: "text", text: "done" }], "stop");
  user("u2", 456_090, 456_020);
  reply("a3", 459_307, 456_072, [cell("cell2")], "toolUse");
  entry("r2", 459_362, { role: "toolResult", toolCallId: "cell2", content: [{ type: "text", text: "ok" }] });
  reply("a4", 460_733, 459_369, [{ type: "text", text: "done" }], "stop");
  // Same millisecond as its prompt entry, with an id that sorts before the prompt's: only time can order them.
  user("u3", 500_000, 499_900, "msg_zz_prompt");
  reply("a5", 500_000, 500_000, [{ type: "text", text: "instant" }], "stop");
  const s: ManagedSession = {
    info: {
      id: "ses_order",
      projectID: "/tmp/order",
      directory: "/tmp/order",
      title: "Order",
      version: "test",
      time: { created: 1000, updated: 1000 },
    },
    pi: undefined,
    model: undefined,
    streaming: undefined,
    status: { type: "idle" },
    messages: [],
    toolByCallId: new Map(),
    tree: { messageEntries: {} },
    hasPendingInteraction: () => false,
    hasRunningChildren: () => false,
  };
  const history = parsePiSessionText(s, "OmO", `${lines.join("\n")}\n`);
  const replies = history.filter((message) => message.info.role === "assistant");
  assert.equal(replies.length, 5);
  assert.equal(history.filter((message) => message.info.role === "user").length, 3);

  // OpenChamber 2.x orders by time.created, then synthetic records first, then id
  // (compareMessagesChronologically, packages/ui/src/sync/message-ordering.ts, v2.5.2), and opens a turn at each prompt.
  const v2 = history.map(toV2Message);
  const order = (a: V2Message, b: V2Message) =>
    a.time.created - b.time.created ||
    Number(b.type === "synthetic") - Number(a.type === "synthetic") ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  let prompt: string | undefined;
  const turnOf = new Map<string, string | undefined>();
  for (const message of v2.toSorted(order)) {
    if (message.type === "user") prompt = message.id;
    else turnOf.set(message.id, prompt);
  }
  for (const message of replies) {
    if (message.info.role !== "assistant") continue;
    assert.equal(turnOf.get(message.info.id), message.info.parentID, `${message.info.id} drawn in the wrong turn`);
    assert.ok(message.info.time.completed !== undefined && message.info.time.completed >= message.info.time.created);
  }
  // Request start stays the reply's creation time whenever it already follows the prompt.
  assert.equal(replies[1]?.info.time.created, 1_793_098_007_436);
});
