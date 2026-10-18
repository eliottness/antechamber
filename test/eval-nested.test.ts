import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parsePiSessionText } from "../src/session-history.js";
import type { ManagedSession } from "../src/sessions.js";
import { MONITOR_STATE_EVENT } from "../src/monitor-sessions.js";
import { ocIdFor } from "../src/session-store.js";
import { nestedToolParts } from "../src/tool-map.js";
import { evalAgentSession } from "../src/subagents.js";
import type { OCMessageWithParts, OCToolPart } from "../src/types.js";
import { bugHarness } from "./bug-harness.js";

// Sanitized shapes from raw RPC capture of installed omo-ai 5.1.33 / senpi runtime, 2026-10-17.
// The recorded cell calls agent() twice with the same prompt and label (once failing), plus bash,
// read, tool.task, monitor and a custom tool; only the subagents and a matched monitor become cards.
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
function writeTask(
  root: string,
  id: string,
  parentPiId: string,
  createdAt: string,
  prompt = "Reply NODE 1",
  status = "completed",
): void {
  const dir = join(root, "agent", "projects", "nested-project", "senpi-task", "tasks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.json`),
    JSON.stringify({
      task_id: id,
      status,
      parent_session_id: parentPiId,
      name: "node-1",
      agent_type: "explore",
      created_at: createdAt,
      spawn_spec: { prompt },
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
  assert.equal(card.state.metadata?.agentTitle, "Explore Agent");
  assert.equal(card.state.metadata?.agentSubtitle, "node-1");
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

test("a running subagent an eval cell started is announced busy under its parent without a session list", {
  timeout: 15_000,
}, async (t) => {
  const h = bugHarness(t);
  const info = await h.manager.create(h.root);
  const managed = h.manager.get(info.id);
  assert.ok(managed?.piSessionId);
  writeTask(h.root, "st_nested_a", managed.piSessionId, new Date().toISOString(), "Reply NODE 1", "running");
  const childID = ocIdFor("st_nested_a");
  const created = h.wait((event) => event.type === "session.created" && event.properties.info.id === childID);
  const busy = h.wait(
    (event) =>
      event.type === "session.status" &&
      event.properties.sessionID === childID &&
      event.properties.status.type === "busy",
  );
  // Nothing lists sessions: the card alone must announce the child.
  await h.manager.prompt(info.id, "nested-eval", undefined, false);
  const announced = await created;
  assert.ok(announced.type === "session.created" && announced.properties.info.parentID === info.id);
  await busy;
  assert.equal(managed.hasRunningChildren(), true);
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
        ["task", "completed", ocIdFor("st_nested_t")],
        ["agent", "error", undefined],
        ["task", "completed", ocIdFor("st_nested_b")],
      ],
    );
    // A tool.task call names its card from its type and summary, and opens the task its result names.
    assert.ok(cards[1]?.state.status === "completed");
    assert.equal(cards[1].state.metadata?.agentTitle, "Quick Agent");
    assert.equal(cards[1].state.metadata?.agentSubtitle, "QA ping subagent ALPHA");
    assert.ok(cards[2]?.state.status === "error");
    assert.equal(cards[2].state.error, "agent() requires successful task details with a valid task_id");
    assert.equal(cards[2].state.input.description, "node-2");
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
  // Then: the agent() and tool.task calls keep their cards and positions; nothing else is rebuilt.
  assert.deepEqual(
    cards.map((part) => part.id),
    [
      "prt_ses_nested_nested_eval-parent:id:js-agent-1",
      "prt_ses_nested_nested_eval-parent:id:js-nested-task",
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
  // No parent identity to search records with: the card cannot be linked, but nothing proves it failed.
  assert.ok(cards[0]?.state.status === "completed");
  assert.equal(cards[0].state.metadata?.sessionID, undefined);
  assert.equal(cards[0].state.time.end - cards[0].state.time.start, 284);
  managed.tree.messageParts.msg_saved = owner.parts.map((part) => part.id);
  assert.deepEqual(parsePiSessionText(managed, "omo", history), messages);
  assert.equal(managed.toolByCallId.size, 0);
});

test("agent() cards name the type from the agent, and describe from label, description or prompt", () => {
  const long = "Investigate the failing background shell and report what the finish notice carried";
  const [typed, described, prompted] = nestedToolParts(parent, {
    toolCalls: [
      {
        name: "__agent__",
        ok: true,
        durationMs: 5,
        callId: "a",
        args: { prompt: "Reply OK", label: "graph-node-1", agent: "explore" },
      },
      { name: "__agent__", ok: true, durationMs: 5, callId: "b", args: { prompt: "x", description: "Check docs" } },
      { name: "__agent__", ok: true, durationMs: 5, callId: "c", args: { prompt: `${long}\nsecond` } },
    ],
  });
  // The agent type heads the card; the label, description or first prompt line describes it.
  assert.ok(
    typed?.state.status === "completed" &&
      described?.state.status === "completed" &&
      prompted?.state.status === "completed",
  );
  assert.equal(typed.state.metadata?.agentTitle, "Explore Agent");
  assert.equal(typed.state.metadata?.agentSubtitle, "graph-node-1");
  assert.equal(typed.state.input.subagent_type, "explore");
  assert.equal(described.state.metadata?.agentTitle, "Subagent");
  assert.equal(described.state.metadata?.agentSubtitle, "Check docs");
  // A bare prompt is cut at a word boundary near 60 characters.
  assert.equal(prompted.state.metadata?.agentSubtitle, "Investigate the failing background shell and report what…");
  assert.equal(prompted.state.input.subagent_type, "subagent");
});

test("an unlabelled agent() card takes its name and type from the resolved task record", () => {
  const [card] = nestedToolParts(
    parent,
    { toolCalls: [{ name: "__agent__", ok: true, durationMs: 5, callId: "a", args: { prompt: "Do the thing" } }] },
    {
      agent: () => ({
        sessionID: "ses_child",
        name: "graph-node-2",
        summary: "Audit the config loader",
        agentType: "librarian",
      }),
    },
  );
  // The record's summary describes the card and its agent type heads it; the session opens.
  assert.ok(card?.state.status === "completed");
  assert.equal(card.state.metadata?.agentTitle, "Librarian Agent");
  assert.equal(card.state.metadata?.agentSubtitle, "Audit the config loader");
  assert.equal(card.state.input.subagent_type, "librarian");
  assert.equal(card.state.metadata?.sessionID, "ses_child");
});

test("a background tool.task call inside eval opens the task its start notice names", () => {
  // Shape from a preview session, 2026-10-17: run_in_background returns at once with the task id.
  const [card] = nestedToolParts(parent, {
    toolCalls: [
      {
        name: "task",
        ok: true,
        durationMs: 261,
        callId: "bg",
        args: { category: "quick", description: "qa-bg-alpha", prompt: "Reply ALPHA_BG_OK", run_in_background: true },
        resultPreview:
          "Started task QA background ping ALPHA (st_01a14c1d, running), the task host is still admitting it",
      },
    ],
  });
  assert.ok(card?.state.status === "completed");
  assert.equal(card.state.metadata?.agentTitle, "Quick Agent");
  assert.equal(card.state.metadata?.agentSubtitle, "qa-bg-alpha");
  assert.equal(card.state.metadata?.sessionID, ocIdFor("st_01a14c1d"));
});

test("an agent() call OmO recorded as ok but started no task for is a failed card", () => {
  // Shape from a preview session, 2026-10-17: agent() without an agent type is refused inside OmO's task
  // tool, yet codemode records the call as ok and no task record is written.
  const call = {
    name: "__agent__",
    ok: true,
    durationMs: 9,
    callId: "a",
    args: { prompt: "Reply ALPHA_OK", label: "qa-alpha" },
  };
  const [refused] = nestedToolParts(parent, { toolCalls: [call] }, { agent: () => null });
  assert.ok(refused?.state.status === "error");
  // Not a task card: OpenChamber would draw that like a success and hide the error.
  assert.equal(refused.tool, "agent");
  assert.match(refused.state.error, /OmO started no subagent/);
  assert.equal(refused.state.metadata?.agentSubtitle, "qa-alpha");
});

test("an agent() lookup that cannot run keeps a completed card instead of calling the spawn failed", () => {
  const call = { name: "__agent__", ok: true, durationMs: 9, callId: "a", args: { prompt: "Reply OK", label: "x" } };
  const [unknown] = nestedToolParts(parent, { toolCalls: [call] }, { agent: () => undefined });
  assert.equal(unknown?.tool, "task");
  assert.equal(unknown?.state.status, "completed");
});

test("task records match prompts codemode cut at 512 code points or extended with schema instructions", async (t) => {
  // senpi-codemode call-capture.ts caps recorded strings and appends "…"; agent-bridge.ts appends schema
  // instructions to the prompt it sends. Both records belong to calls that did start a subagent.
  const h = bugHarness(t);
  const info = await h.manager.create(h.root);
  const piId = h.manager.get(info.id)?.piSessionId;
  assert.ok(piId);
  const now = Date.now();
  const long = "x".repeat(600);
  writeTask(h.root, "st_long", piId, new Date(now).toISOString(), long);
  writeTask(
    h.root,
    "st_schema",
    piId,
    new Date(now).toISOString(),
    "Classify\n\nRespond ONLY with JSON matching this JSON-Schema:\n{}",
  );
  const claimed = new Set<string>();
  const cut = evalAgentSession(piId, { prompt: `${long.slice(0, 512)}…`, label: "node-1" }, claimed, now);
  assert.equal(cut?.sessionID, ocIdFor("st_long"));
  assert.equal(
    evalAgentSession(piId, { prompt: "Classify", label: "node-1" }, claimed, now)?.sessionID,
    ocIdFor("st_schema"),
  );
  assert.equal(
    evalAgentSession(piId, { prompt: "Classify", label: "node-1" }, claimed, now),
    null,
    "both records claimed",
  );
  assert.equal(evalAgentSession(undefined, { prompt: "Classify" }, new Set(), now), undefined);
});

test("a tool.task preview cut inside or before its task id links through the task record instead", () => {
  // OmO keeps 160 code points of the result, so a long reply can drop or split "[task_id: st_x - ".
  const entry = (preview: string) => ({
    name: "task",
    ok: true,
    durationMs: 9,
    callId: "t",
    args: { category: "quick", prompt: "Reply ALPHA_OK" },
    resultPreview: preview,
  });
  const lookups: Record<string, unknown>[] = [];
  const sessions = {
    agent: (args: Record<string, unknown>) => {
      lookups.push(args);
      return { sessionID: "ses_from_record" };
    },
  };
  const [split] = nestedToolParts(parent, { toolCalls: [entry(`${"y".repeat(140)} [task_id: st_01a1…`)] }, sessions);
  const [dropped] = nestedToolParts(parent, { toolCalls: [entry(`${"y".repeat(159)}…`)] }, sessions);
  const [whole] = nestedToolParts(parent, { toolCalls: [entry("OK [task_id: st_01a14c1a - continue")] }, sessions);
  assert.ok(
    split?.state.status === "completed" && dropped?.state.status === "completed" && whole?.state.status === "completed",
  );
  assert.equal(split.state.metadata?.sessionID, "ses_from_record");
  assert.equal(dropped.state.metadata?.sessionID, "ses_from_record");
  assert.equal(whole.state.metadata?.sessionID, ocIdFor("st_01a14c1a"));
  assert.deepEqual(lookups, [{ prompt: "Reply ALPHA_OK" }, { prompt: "Reply ALPHA_OK" }]);
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
  assert.equal(card.state.metadata?.agentTitle, "Monitor");
  assert.equal(card.state.metadata?.agentSubtitle, "qa monitor");
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
