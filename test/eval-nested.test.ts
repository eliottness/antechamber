import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parsePiSessionText } from "../src/session-history.js";
import type { ManagedSession } from "../src/sessions.js";
import { mapTool, nestedToolParts } from "../src/tool-map.js";
import type { OCMessageWithParts, OCToolPart } from "../src/types.js";
import { bugHarness } from "./bug-harness.js";

// Sanitized shapes from raw RPC capture of installed omo-ai 5.1.33 / senpi runtime, 2026-10-17.
const history = readFileSync(new URL("./fixtures/eval-nested.jsonl", import.meta.url), "utf8");
const command = "printf 'NESTBASH 1\\nNESTBASH 2\\n'";

function tools(messages: OCMessageWithParts[]): OCToolPart[] {
  return messages.flatMap((message) => message.parts).filter((part): part is OCToolPart => part.type === "tool");
}

function nested(messages: OCMessageWithParts[]): OCToolPart[] {
  return tools(messages).filter((part) => part.state.status !== "pending" && part.state.metadata?.nested === true);
}

function session(): ManagedSession {
  return {
    info: {
      id: "ses_nested",
      projectID: "/tmp/nested",
      directory: "/tmp/nested",
      title: "Nested tools",
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
}

test("finished nested bash cards arrive live while eval still runs", { timeout: 15_000 }, async (t) => {
  // Given: a fake agent holds eval open after two nested calls finish.
  const h = bugHarness(t);
  const info = await h.manager.create(h.root);
  const parentRunning = h.wait(
    (event) =>
      event.type === "message.part.updated" &&
      event.properties.part.type === "tool" &&
      event.properties.part.callID === "eval-parent" &&
      event.properties.part.state.status === "running",
  );
  // When: captured partialResult.details.toolCalls frames cross the real JSONL transport twice.
  await h.manager.prompt(info.id, "nested-eval", undefined, false);
  await parentRunning;
  const managed = h.manager.get(info.id);
  assert.ok(managed);
  const cards = nested(h.manager.messages(info.id) ?? []);
  // Then: previews are terminal tool cards, not active tools or duplicates.
  assert.equal(cards.length, 2, "live eval update must expose two nested cards");
  const bash = cards[0];
  assert.ok(bash?.state.status === "completed");
  assert.equal(bash.tool, "bash");
  assert.equal(bash.state.input.command, command);
  assert.equal(bash.state.title, command);
  assert.equal(bash.state.output, "NESTBASH 1 NESTBASH 2");
  assert.deepEqual(bash.state.metadata, { nested: true, parentCallID: "eval-parent", durationMs: 9116 });
  assert.equal(bash.state.time.end - bash.state.time.start, 9116);
  assert.equal(managed.toolByCallId.has(bash.callID), false);
  assert.deepEqual([...managed.toolByCallId.keys()], ["eval-parent", "read-sibling"]);
  const owner = managed.messages?.find((message) => message.info.id === bash.messageID);
  assert.ok(owner?.info.role === "assistant");
  assert.equal(owner.info.time.completed, undefined);
  assert.deepEqual(
    owner?.parts.map((part) => (part.type !== "tool" ? part.type : part.callID === "eval-parent" ? "eval" : part.tool)),
    ["text", "eval", "bash", "read", "read", "text"],
  );
  const published = h.events.filter(
    (event) => event.type === "message.part.updated" && event.properties.part.id === bash.id,
  );
  assert.equal(published.length, 2, "repeated snapshots update the same card");
  const success = h.frames.filter((frame) => frame.type === "session.tool.success" && frame.data.id === bash.callID);
  assert.equal(success.length, 1);
  assert.deepEqual(success[0]?.data.content, [{ type: "text", text: "NESTBASH 1 NESTBASH 2" }]);
});

for (const via of ["end", "turn", "late"]) {
  test(`final nested results via ${via} survive a history reload with identical ids`, {
    timeout: 15_000,
  }, async (t) => {
    // Given: eval has no nested partial updates; final details arrive at end, turn_end, or both in sequence.
    const h = bugHarness(t);
    const info = await h.manager.create(h.root);
    await h.manager.prompt(info.id, via === "end" ? "nested-eval" : "nested-final", undefined, false);
    const managed = h.manager.get(info.id);
    assert.ok(managed?.pi);
    const idle = h.wait((event) => event.type === "session.idle" && event.properties.sessionID === info.id);
    // When: the fixture releases the final results, then the adapter restarts.
    await managed.pi.command({ type: "nested_finish", via });
    await idle;
    const live = h.manager.messages(info.id) ?? [];
    const cards = nested(live);
    assert.equal(cards.length, 7, "final eval result must expose every non-task nested card");
    assert.deepEqual(
      cards.map((part) => part.tool),
      ["bash", "read", "todo", "bash_output", "write", "custom_tool", "bash"].map((name) => mapTool(name, {}).tool),
    );
    assert.equal(cards[1]?.state.input.filePath, "notes.txt");
    assert.match(JSON.stringify(cards[3]?.state.input), /bash_2/);
    assert.ok(cards[4]?.state.status === "error");
    assert.equal(cards[4].state.error, "Permission denied");
    assert.ok(cards[5]?.state.status === "completed");
    assert.equal(cards[5].state.output, "");
    assert.ok(cards[6]?.state.status === "error");
    assert.equal(cards[6].state.error, "failed");
    assert.equal(new Set(cards.map((part) => part.id)).size, 7);
    assert.equal(managed.toolByCallId.size, 0);
    const owner = live.find((message) => message.info.id === cards[0]?.messageID);
    assert.ok(owner?.info.role === "assistant");
    assert.ok(owner.info.time.completed);
    assert.deepEqual(
      owner.parts.map((part) =>
        part.type !== "tool" ? part.type : part.callID === "eval-parent" ? "eval" : part.tool,
      ),
      ["text", "eval", ...cards.map((part) => part.tool), "read", "text"],
    );
    assert.equal(
      h.frames.filter((frame) => frame.type === "session.tool.success" && frame.data.id === cards[0]?.callID).length,
      1,
    );
    await h.restart();
    // Then: published IDs, ownership, input, preview, errors and order survive registry/history reconstruction.
    const restored = nested(h.manager.messages(info.id) ?? []);
    const comparable = (part: OCToolPart) => {
      const { time, ...state } = part.state.status === "pending" ? { ...part.state, time: undefined } : part.state;
      return { ...part, state };
    };
    assert.deepEqual(restored.map(comparable), cards.map(comparable));
  });
}

test("run finalization preserves finished nested cards when eval never returns", { timeout: 15_000 }, async (t) => {
  // Given: two captured nested results and an eval still awaiting its final result.
  const h = bugHarness(t);
  const info = await h.manager.create(h.root);
  await h.manager.prompt(info.id, "nested-eval", undefined, false);
  const managed = h.manager.get(info.id);
  assert.ok(managed?.pi);
  const before = structuredClone(nested(h.manager.messages(info.id) ?? []));
  assert.equal(before.length, 2);
  const interrupted = h.wait(
    (event) =>
      event.type === "message.part.updated" &&
      event.properties.part.type === "tool" &&
      event.properties.part.callID === "eval-parent" &&
      event.properties.part.state.status === "error",
  );
  // When: the run ends without a result for its active eval.
  await managed.pi.command({ type: "emit", frame: { type: "agent_end" } });
  await interrupted;
  // Then: dangling-tool cleanup touches the parent, not its finished nested calls.
  assert.deepEqual(nested(h.manager.messages(info.id) ?? []), before);
  assert.equal(managed.toolByCallId.size, 0);
});

test("JSONL history rebuilds nested cards without shifting previously saved native part identities", () => {
  // Given: saved identities from before nested cards existed.
  const managed = session();
  managed.tree.messageEntries.msg_saved = "nested-assistant";
  managed.tree.messageParts = { msg_saved: ["prt_before", "prt_eval", "prt_sibling", "prt_after"] };
  // When: the persisted toolResult details are reconstructed, including a second parse after persistence.
  const messages = parsePiSessionText(managed, "omo", history);
  const cards = nested(messages);
  // Then: native and synthetic identities remain distinct and stable in the correct positions.
  assert.equal(cards.length, 7, "persisted eval details must rebuild seven nested cards");
  const owner = messages.find((message) => message.info.id === "msg_saved");
  assert.ok(owner);
  assert.deepEqual(
    owner.parts.map((part) => part.id),
    ["prt_before", "prt_eval", ...cards.map((part) => part.id), "prt_sibling", "prt_after"],
  );
  assert.equal(cards[0]?.id, "prt_ses_nested_nested_eval-parent:id:js-nested-bash");
  assert.equal(cards[5]?.id, "prt_ses_nested_nested_eval-parent:index:6");
  assert.equal(cards[6]?.id, "prt_ses_nested_nested_eval-parent:index:7");
  assert.ok(cards[0]?.state.status === "completed");
  assert.equal(cards[0].state.input.command, command);
  assert.equal(cards[0].state.output, "NESTBASH 1 NESTBASH 2");
  assert.equal(cards[0].state.time.end - cards[0].state.time.start, 9116);
  managed.tree.messageParts.msg_saved = owner.parts.map((part) => part.id);
  assert.deepEqual(parsePiSessionText(managed, "omo", history), messages);
  assert.equal(managed.toolByCallId.size, 0);
});

test("nested agent() calls are labelled by their label or prompt, failures keep the error", () => {
  const parent: OCToolPart = {
    id: "prt_eval",
    messageID: "msg_eval",
    sessionID: "ses_nested",
    type: "tool",
    tool: "eval",
    callID: "parent",
    state: { status: "running", input: {}, time: { start: 10 } },
  };
  // Shape from a persisted OmO toolResult (details.toolCalls) for agent() inside eval, 2026-10-17.
  const [labelled, failed, prompted] = nestedToolParts(parent, {
    toolCalls: [
      { name: "__agent__", ok: true, durationMs: 5, callId: "a", args: { prompt: "Reply OK", label: "graph-node-1" } },
      { name: "__agent__", ok: false, durationMs: 8, callId: "b", error: "agent() requires a task_id", args: {} },
      { name: "__agent__", ok: true, durationMs: 5, callId: "c", args: { prompt: "First line\nsecond" } },
    ],
  });
  assert.ok(labelled?.state.status === "completed");
  assert.equal(labelled.tool, "agent");
  assert.equal(labelled.state.title, "agent: graph-node-1");
  assert.ok(failed?.state.status === "error");
  assert.equal(failed.state.error, "agent() requires a task_id");
  assert.ok(prompted?.state.status === "completed");
  assert.equal(prompted.state.title, "agent: First line");
});

test("nested extraction ignores unrelated and malformed details and namespaces call identities", () => {
  // Given: one eval card and untrusted tool result details.
  const parent: OCToolPart = {
    id: "prt_eval",
    messageID: "msg_eval",
    sessionID: "ses_nested",
    type: "tool",
    tool: "eval",
    callID: "parent",
    state: { status: "running", input: {}, time: { start: 10 } },
  };
  const entry = { name: "bash", ok: true, durationMs: 3, callId: "same", args: { command: "pwd" } };
  // When: result details cross the extraction boundary.
  for (const details of [
    undefined,
    null,
    [],
    {},
    { toolCalls: null },
    { toolCalls: [null, {}, { ...entry, durationMs: -1 }] },
  ])
    assert.deepEqual(nestedToolParts(parent, details), []);
  const first = nestedToolParts(parent, { toolCalls: [entry] })[0];
  const second = nestedToolParts({ ...parent, callID: "other" }, { toolCalls: [entry] })[0];
  // Then: reused child IDs in separate cells never collide.
  assert.ok(first && second);
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.callID, second.callID);
});
