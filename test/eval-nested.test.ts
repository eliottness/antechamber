import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parsePiSessionText } from "../src/session-history.js";
import type { ManagedSession } from "../src/sessions.js";
import { MONITOR_STATE_EVENT } from "../src/monitor-sessions.js";
import { ocIdFor } from "../src/session-store.js";
import { nestedToolParts } from "../src/tool-map.js";
import type { OCMessageWithParts, OCToolPart } from "../src/types.js";
import { bugHarness } from "./bug-harness.js";

// Sanitized shapes from raw RPC capture of installed omo-ai 5.1.33 / senpi runtime, 2026-10-17.
// The recorded cell calls agent() twice with the same prompt and label (once failing), plus bash,
// read, task, monitor and a custom tool; only the subagents and a matched monitor become cards.
const history = readFileSync(new URL("./fixtures/eval-nested.jsonl", import.meta.url), "utf8");

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

/** A task record as OmO writes it for agent() inside eval (senpi-task/tasks/st_*.json, 2026-10-17). */
function writeTask(root: string, id: string, parentPiId: string, createdAt: string): void {
  const dir = join(root, "agent", "projects", "nested-project", "senpi-task", "tasks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.json`),
    JSON.stringify({
      task_id: id,
      status: "completed",
      parent_session_id: parentPiId,
      name: "node-1",
      agent_type: "explore",
      created_at: createdAt,
      spawn_spec: { prompt: "Reply NODE 1" },
    }),
  );
}

const parent: OCToolPart = {
  id: "prt_eval",
  messageID: "msg_eval",
  sessionID: "ses_nested",
  type: "tool",
  tool: "eval",
  callID: "parent",
  state: { status: "running", input: {}, time: { start: 10 } },
};

test("a subagent started inside eval becomes a subagent card live, and other inner calls get none", {
  timeout: 15_000,
}, async (t) => {
  // Given: the task record OmO wrote for the cell's first agent() call.
  const h = bugHarness(t);
  const info = await h.manager.create(h.root);
  const managed = h.manager.get(info.id);
  assert.ok(managed?.piSessionId);
  writeTask(h.root, "st_nested_a", managed.piSessionId, new Date().toISOString());
  const parentRunning = h.wait(
    (event) =>
      event.type === "message.part.updated" &&
      event.properties.part.type === "tool" &&
      event.properties.part.callID === "eval-parent" &&
      event.properties.part.state.status === "running",
  );
  // When: the captured partial result lists that agent() call and a bash call.
  await h.manager.prompt(info.id, "nested-eval", undefined, false);
  await parentRunning;
  const cards = nested(h.manager.messages(info.id) ?? []);
  // Then: one subagent card opens the child session; the bash call has no card.
  assert.equal(cards.length, 1);
  const card = cards[0];
  assert.ok(card?.state.status === "completed");
  assert.equal(card.tool, "task");
  assert.deepEqual(card.state.input, { description: "node-1", prompt: "Reply NODE 1", subagent_type: "explore" });
  assert.equal(card.state.metadata?.sessionID, ocIdFor("st_nested_a"));
  assert.equal(card.state.output, "");
  assert.equal(managed.toolByCallId.has(card.callID), false);
  const owner = managed.messages?.find((message) => message.info.id === card.messageID);
  assert.ok(owner?.info.role === "assistant");
  assert.equal(owner.info.time.completed, undefined);
  assert.deepEqual(
    owner.parts.map((part) => (part.type !== "tool" ? part.type : part.callID === "eval-parent" ? "eval" : part.tool)),
    ["text", "eval", "task", "read", "text"],
  );
});

for (const via of ["end", "turn", "late"]) {
  test(`final subagent cards via ${via} survive a history reload with identical ids`, {
    timeout: 15_000,
  }, async (t) => {
    // Given: two task records for the cell's two successful agent() calls with the same prompt and label.
    const h = bugHarness(t);
    const info = await h.manager.create(h.root);
    const managed = h.manager.get(info.id);
    assert.ok(managed?.pi && managed.piSessionId);
    const now = Date.now();
    writeTask(h.root, "st_nested_b", managed.piSessionId, new Date(now + 1_000).toISOString());
    writeTask(h.root, "st_nested_a", managed.piSessionId, new Date(now).toISOString());
    await h.manager.prompt(info.id, via === "end" ? "nested-eval" : "nested-final", undefined, false);
    const idle = h.wait((event) => event.type === "session.idle" && event.properties.sessionID === info.id);
    // When: the fixture releases the final results, then the adapter restarts.
    await managed.pi.command({ type: "nested_finish", via });
    await idle;
    const cards = nested(h.manager.messages(info.id) ?? []);
    // Then: each call gets its own child in call order, and the failed spawn keeps its error.
    assert.deepEqual(
      cards.map((part) => [
        part.tool,
        part.state.status,
        part.state.status === "pending" ? undefined : part.state.metadata?.sessionID,
      ]),
      [
        ["task", "completed", ocIdFor("st_nested_a")],
        ["task", "error", undefined],
        ["task", "completed", ocIdFor("st_nested_b")],
      ],
    );
    assert.ok(cards[1]?.state.status === "error");
    assert.equal(cards[1].state.error, "agent() requires successful task details with a valid task_id");
    assert.equal(cards[1].state.input.description, "node-2");
    assert.equal(managed.toolByCallId.size, 0);
    await h.restart();
    const comparable = (part: OCToolPart) => {
      const { time, ...state } = part.state.status === "pending" ? { ...part.state, time: undefined } : part.state;
      return { ...part, state };
    };
    assert.deepEqual(nested(h.manager.messages(info.id) ?? []).map(comparable), cards.map(comparable));
  });
}

test("run finalization preserves finished subagent cards when eval never returns", { timeout: 15_000 }, async (t) => {
  const h = bugHarness(t);
  const info = await h.manager.create(h.root);
  await h.manager.prompt(info.id, "nested-eval", undefined, false);
  const managed = h.manager.get(info.id);
  assert.ok(managed?.pi);
  const before = structuredClone(nested(h.manager.messages(info.id) ?? []));
  assert.equal(before.length, 1);
  const interrupted = h.wait(
    (event) =>
      event.type === "message.part.updated" &&
      event.properties.part.type === "tool" &&
      event.properties.part.callID === "eval-parent" &&
      event.properties.part.state.status === "error",
  );
  await managed.pi.command({ type: "emit", frame: { type: "agent_end" } });
  await interrupted;
  assert.deepEqual(nested(h.manager.messages(info.id) ?? []), before);
  assert.equal(managed.toolByCallId.size, 0);
});

test("JSONL history rebuilds subagent cards without shifting previously saved native part identities", () => {
  // Given: saved identities from before nested cards existed, and no task records to link.
  const managed = session();
  managed.tree.messageEntries.msg_saved = "nested-assistant";
  managed.tree.messageParts = { msg_saved: ["prt_before", "prt_eval", "prt_sibling", "prt_after"] };
  const messages = parsePiSessionText(managed, "omo", history);
  const cards = nested(messages);
  // Then: the three agent() calls keep their cards and positions; nothing else is rebuilt.
  assert.deepEqual(
    cards.map((part) => part.id),
    [
      "prt_ses_nested_nested_eval-parent:id:js-agent-1",
      "prt_ses_nested_nested_eval-parent:id:js-agent-fail",
      "prt_ses_nested_nested_eval-parent:index:6",
    ],
  );
  const owner = messages.find((message) => message.info.id === "msg_saved");
  assert.ok(owner);
  assert.deepEqual(
    owner.parts.map((part) => part.id),
    ["prt_before", "prt_eval", ...cards.map((part) => part.id), "prt_sibling", "prt_after"],
  );
  assert.ok(cards[0]?.state.status === "completed");
  assert.equal(cards[0].state.metadata?.sessionID, undefined, "no task record, so nothing to open");
  assert.equal(cards[0].state.time.end - cards[0].state.time.start, 284);
  managed.tree.messageParts.msg_saved = owner.parts.map((part) => part.id);
  assert.deepEqual(parsePiSessionText(managed, "omo", history), messages);
  assert.equal(managed.toolByCallId.size, 0);
});

test("agent() cards are labelled by their label, then description, then the prompt's first line", () => {
  const [labelled, described, prompted] = nestedToolParts(parent, {
    toolCalls: [
      { name: "__agent__", ok: true, durationMs: 5, callId: "a", args: { prompt: "Reply OK", label: "graph-node-1" } },
      { name: "__agent__", ok: true, durationMs: 5, callId: "b", args: { prompt: "x", description: "Check docs" } },
      { name: "__agent__", ok: true, durationMs: 5, callId: "c", args: { prompt: "First line\nsecond" } },
    ],
  });
  assert.equal(labelled?.state.status === "completed" && labelled.state.title, "graph-node-1");
  assert.equal(described?.state.status === "completed" && described.state.title, "Check docs");
  assert.equal(prompted?.state.status === "completed" && prompted.state.title, "First line");
  assert.equal(labelled?.state.input.subagent_type, "subagent");
});

// Shapes from a raw RPC capture of installed omo-ai 5.1.33 / senpi runtime, 2026-10-17: the recorded
// monitor call keeps only its arguments; its watch arrives separately in terminal_monitor_state.
const monitorCall = {
  name: "monitor",
  ok: true,
  durationMs: 50,
  callId: "js-monitor",
  args: { description: "qa monitor", command: "for i in 1 2 3; do echo MONHIT $i; sleep 2; done", filter: "MONHIT" },
  resultPreview: "Monitor started with ID: mon_ZFZ2W1Q5CP8H1GNQ",
};
const watch = {
  id: "bash_3",
  description: "qa monitor",
  command: monitorCall.args.command,
  filter: "MONHIT",
  paused: false,
  persistent: false,
  startedAtMs: 1_760_000_000_000,
  deadlineMs: null,
  fireCount: 0,
  lastFiredAtMs: null,
};

test("a monitor started inside eval becomes a subagent card that opens its monitor session", async (t) => {
  const h = bugHarness(t);
  const info = await h.manager.create(h.root);
  const s = h.manager.get(info.id);
  const pi = s?.pi;
  assert.ok(s && pi);
  const emit = async (frame: Record<string, unknown>): Promise<void> => {
    const reply: { success: boolean } = await pi.command({ type: "emit", frame });
    assert.equal(reply.success, true);
  };
  await emit({ type: "extension_event", name: MONITOR_STATE_EVENT, data: { activeCount: 1, monitors: [watch] } });
  const childID = ocIdFor(`${info.id}/monitor/bash_3`);
  assert.ok(h.manager.get(childID));
  const call = {
    type: "toolCall",
    id: "eval-monitor",
    name: "eval",
    arguments: { language: "js", code: "await tool.monitor(...)" },
  };
  const message = {
    role: "assistant",
    content: [call],
    provider: "fake",
    model: "served",
    timestamp: 1100,
    stopReason: "toolUse",
  };
  await emit({ type: "message_start", message });
  await emit({
    type: "message_update",
    assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: call },
  });
  await emit({ type: "message_end", message });
  await emit({ type: "tool_execution_start", toolCallId: call.id, toolName: "eval", args: call.arguments });
  await emit({
    type: "tool_execution_update",
    toolCallId: call.id,
    toolName: "eval",
    args: call.arguments,
    partialResult: { content: [{ type: "text", text: "1/1 cells running" }], details: { toolCalls: [monitorCall] } },
  });
  const card = nested(h.manager.messages(info.id) ?? [])[0];
  assert.ok(card?.state.status === "completed");
  assert.equal(card.tool, "task");
  assert.equal(card.state.input.description, "Monitor: qa monitor");
  assert.equal(card.state.metadata?.sessionID, childID);
  assert.equal(card.state.output, "");
});

test("a monitor with no session to open gets no card", () => {
  assert.deepEqual(nestedToolParts(parent, { toolCalls: [monitorCall] }, { monitor: () => undefined }), []);
  assert.deepEqual(nestedToolParts(parent, { toolCalls: [monitorCall] }), []);
});

test("nested extraction ignores unrelated and malformed details and namespaces call identities", () => {
  const entry = { name: "__agent__", ok: true, durationMs: 3, callId: "same", args: { prompt: "p", label: "x" } };
  for (const details of [
    undefined,
    null,
    [],
    {},
    { toolCalls: null },
    { toolCalls: [null, {}, { ...entry, durationMs: -1 }, { name: "bash", ok: true, durationMs: 1, args: {} }] },
  ])
    assert.deepEqual(nestedToolParts(parent, details), []);
  const first = nestedToolParts(parent, { toolCalls: [entry] })[0];
  const second = nestedToolParts({ ...parent, callID: "other" }, { toolCalls: [entry] })[0];
  assert.ok(first && second);
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.callID, second.callID);
});
