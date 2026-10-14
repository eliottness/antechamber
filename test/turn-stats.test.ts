import assert from "node:assert/strict";
import test from "node:test";
import { toV2Message } from "../src/v2.js";
import type { V2Message } from "../src/v2.js";
import type { OCMessageWithParts } from "../src/types.js";
import { AdapterServer } from "../src/server.js";
import { bugHarness, openEvents } from "./bug-harness.js";

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
