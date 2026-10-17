/// <reference types="node" />
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mapTool, toolMappers } from "../src/tool-map.js";
import { SessionManager, type ManagedSession } from "../src/sessions.js";
import { SessionStore } from "../src/session-store.js";
import { ocIdFor } from "../src/session-store.js";
import { stripTaskSuffix } from "../src/subagents.js";
import { bindMessageEntries } from "../src/session-tree.js";
import type { OCEvent, OCToolPart } from "../src/types.js";
import { toV2Message } from "../src/v2.js";

const fixtures = join(process.cwd(), "test/fixtures/omo-tools");
const keys: Record<string, string[]> = {
  read: ["filePath", "offset", "limit"],
  write: ["filePath", "content"],
  edit: ["filePath", "oldString", "newString"],
  multiedit: ["filePath", "edits"],
  bash: ["command", "description"],
  question: ["questions"],
  task: ["description", "prompt", "subagent_type"],
  todowrite: ["todos"],
};

for (const file of readdirSync(fixtures).filter((name) => name.endsWith(".json") && name !== "todo-state.json")) {
  const fixture = JSON.parse(readFileSync(join(fixtures, file), "utf8")) as {
    tool: string;
    samples: Array<{
      arguments: Record<string, unknown>;
      content: unknown;
      details: Record<string, unknown>;
      isError: boolean;
    }>;
  };
  test(`real ${fixture.tool} fixtures map renderer inputs and text output`, () => {
    for (const sample of fixture.samples) {
      const mapped = mapTool(fixture.tool, sample.arguments, sample);
      if (keys[mapped.tool] !== undefined) assert.deepEqual(Object.keys(mapped.input), keys[mapped.tool]);
      else assert.deepEqual(mapped.input, sample.arguments);
      const blocks = sample.content as Array<{ type: string; text?: string }>;
      const text = blocks
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("");
      assert.equal(mapped.output, fixture.tool === "task" ? stripTaskSuffix(text) : text);
      if (fixture.tool === "edit") {
        assert.deepEqual(mapped.metadata?.filediff, { file: sample.arguments.path });
        assert.equal(mapped.metadata?.patch, sample.details.patch);
        assert.equal(mapped.metadata?.diff, sample.details.diff);
      }
      if (fixture.tool === "read" || fixture.tool === "write")
        assert.equal(mapped.input.filePath, sample.arguments.path);
      if (fixture.tool === "eval") {
        assert.equal(mapped.tool, "bash");
        assert.equal(mapped.title, sample.arguments.summary);
        assert.equal(mapped.input.command, sample.arguments.code);
        assert.equal(mapped.metadata?.evalSubtitle, sample.arguments.summary);
      }
      if (fixture.tool === "task") {
        assert.equal(
          mapped.input.description,
          sample.arguments.task_summary ?? sample.arguments.name ?? sample.arguments.description,
        );
        assert.equal(mapped.input.subagent_type, sample.arguments.subagent_type ?? sample.arguments.category);
        assert.equal(
          mapped.metadata?.sessionID,
          sample.details.task_id ? ocIdFor(String(sample.details.task_id)) : undefined,
        );
      }
    }
  });
}

test("single and multiple edits carry renderer strings and file metadata", () => {
  const first = { oldText: "before", newText: "after" };
  assert.deepEqual(mapTool("edit", { path: "a.txt", edits: [first] }), {
    tool: "edit",
    input: { filePath: "a.txt", oldString: "before", newString: "after" },
    title: "a.txt",
    metadata: { filediff: { file: "a.txt" } },
  });
  assert.deepEqual(mapTool("edit", { path: "a.txt", edits: [first, first] }).input, {
    filePath: "a.txt",
    edits: Array(2).fill({ filePath: "a.txt", oldString: "before", newString: "after" }),
  });
});

test("write completion emits content-only metadata even when the result contains diffs", () => {
  const mapped = mapTool(
    "write",
    { path: "out.txt", content: "initial" },
    {
      content: [{ type: "text", text: "Successfully wrote to out.txt" }],
      details: {
        patch: "--- out.txt\n+++ out.txt\n@@ -1 +1 @@\n-updated\n+initial\n",
        diff: "-updated\n+initial",
        filediff: { file: "out.txt", before: "updated", after: "initial" },
      },
    },
  );
  assert.deepEqual(mapped.input, { filePath: "out.txt", content: "initial" });
  assert.equal(mapped.metadata, undefined);
  assert.equal(mapped.output, "Successfully wrote to out.txt");
});

test("bash and questions use native renderer contracts", () => {
  assert.deepEqual(mapTool("bash", { command: "pwd", description: "Working directory" }).input, {
    command: "pwd",
    description: "Working directory",
  });
  const options = [{ label: "Yes", description: "Proceed" }];
  assert.deepEqual(
    mapTool("ask_user_question", {
      questions: [{ question: "Proceed?", header: "Choice", options, multiSelect: true }],
    }).input,
    { questions: [{ question: "Proceed?", header: "Choice", options, multiple: true }] },
  );
});

test("eval uses a bash renderer with its code and language summary", () => {
  assert.deepEqual(mapTool("eval", { code: 'print("hello")', language: "py", summary: "Print hello" }), {
    tool: "bash",
    input: { command: 'print("hello")', description: "Python Eval: Print hello" },
    title: "Print hello",
    metadata: { evalTitle: "Python Eval", evalSubtitle: "Print hello" },
  });
  assert.deepEqual(mapTool("eval", { code: "print(1)", summary: "One" }).input, {
    command: "print(1)",
    description: "JS Eval: One",
  });
  assert.deepEqual(mapTool("eval", {}), {
    tool: "bash",
    input: { command: "eval", description: "JS Eval: eval" },
    title: "eval",
    metadata: { evalTitle: "JS Eval", evalSubtitle: "eval" },
  });
  assert.equal(mapTool("eval", { action: "peek", cell_id: "cell_1" }).input.command, "eval peek cell_1");
});

test("terminal controls use readable bash commands and preserve their result text", () => {
  for (const [name, args, command] of [
    ["bash_output", { bash_id: "bash_2", view: "screen" }, "bash_output bash_2"],
    ["bash_input", { bash_id: "bash_2", input: "pwd", keys: ["enter"] }, 'bash_input bash_2 "pwd" enter'],
    ["bash_input", { bash_id: "bash_2", keys: ["ctrl+c"] }, "bash_input bash_2 ctrl+c"],
    ["kill_bash", { bash_id: "bash_2" }, "kill_bash bash_2"],
    ["kill_bash", { all: true }, "kill_bash all"],
    ["bash_resize", { bash_id: "bash_2", cols: 100, rows: 30 }, "bash_resize bash_2 100x30"],
  ] as const) {
    const mapped = mapTool(name, args, { content: [{ type: "text", text: "terminal result\n" }] });
    assert.equal(mapped.tool, "bash");
    assert.equal(mapped.input.command, command);
    assert.equal(mapped.output, "terminal result\n");
  }
});

test("unknown tools pass through and todo uses the bridge mapper", () => {
  const args = { summary: "s".repeat(70), description: "lower priority", other: 1 };
  assert.deepEqual(mapTool("unknown", args), { tool: "unknown", input: args, title: "s".repeat(60) });
  assert.deepEqual(mapTool("todo", { op: "view" }), { tool: "todowrite", input: { todos: [] }, title: "Todos" });
  assert.equal(mapTool("toString", {}).tool, "toString");
  assert.equal(mapTool("unknown", { url: "https://example.org" }).title, "https://example.org");
});

test("malformed and missing arguments never throw or invent an edit diff", () => {
  for (const name of ["read", "write", "edit", "bash", "eval", "ask_user_question", "task", "unknown"]) {
    for (const args of [undefined, null, [], 42, "bad"]) assert.doesNotThrow(() => mapTool(name, args));
  }
  for (const edits of [[], [null], [{}], "bad"]) {
    const args = { path: "a.txt", edits };
    const mapped = mapTool("edit", args);
    assert.deepEqual(mapped.input, args);
    assert.equal(mapped.metadata, undefined);
  }
  assert.equal(
    mapTool(
      "unknown",
      {},
      {
        content: [
          { type: "image", text: "not text" },
          { type: "text", text: "one" },
          { type: "text", text: "two" },
        ],
      },
    ).output,
    "onetwo",
  );
});

test("later bridges can register todo and task handlers", () => {
  const previous = toolMappers.todo;
  try {
    toolMappers.todo = (args) => ({ tool: "todowrite", input: { todos: args.items }, title: "Todos" });
    assert.equal(mapTool("todo", { items: [] }).tool, "todowrite");
  } finally {
    if (previous === undefined) delete toolMappers.todo;
    else toolMappers.todo = previous;
  }
});

function session(piPath: string): ManagedSession {
  return {
    info: {
      id: "ses_test",
      projectID: "/tmp/test",
      directory: "/tmp/test",
      title: "Tools",
      version: "test",
      time: { created: 0, updated: 0 },
    },
    pi: undefined,
    messages: [],
    status: { type: "idle" },
    model: undefined,
    streaming: undefined,
    toolByCallId: new Map(),
    tree: { messageEntries: {} },
    piPath,
    hasPendingInteraction: () => false,
    hasRunningChildren: () => false,
  };
}

function comparable(part: OCToolPart): unknown {
  const { id, messageID, ...rest } = part;
  return JSON.parse(JSON.stringify(rest));
}

function runningTool(name: string, args: Record<string, unknown> = {}) {
  const s = session("/nonexistent");
  const events: OCEvent[] = [];
  const manager = new SessionManager((_directory, event) => {
    if (event.type !== "todo.updated") events.push(structuredClone(event));
  });
  const call = { id: "live-call", name, arguments: args };
  manager["onPiEvent"](s, { type: "message_start", message: { role: "assistant" } });
  manager["onPiEvent"](s, {
    type: "message_update",
    assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: call },
  });
  manager["onPiEvent"](s, { type: "tool_execution_start", toolCallId: call.id, toolName: name, args });
  const part = s.toolByCallId.get(call.id);
  assert.ok(part?.state.status === "running");
  return { s, manager, part, events, call };
}

// raw RPC capture of installed omo-ai 5.1.33 / senpi runtime, 2026-10-17:
// updates carry cumulative content; eval adds status lines but final results do not.
for (const [name, updates] of [
  [
    "bash",
    [
      ["first\n", "first\n"],
      ["first\nsecond\n", "first\nsecond\n"],
      ["", "first\nsecond\n"],
      [" \n", "first\nsecond\n"],
      ["replacement\n", "replacement\n"],
      ["1/1 cells running\n[1] js User output running\n", "1/1 cells running\n[1] js User output running\n"],
    ],
  ],
  [
    "eval",
    [
      ["waiting for the js kernel to be ready", undefined],
      ["waiting for the py kernel to be ready", undefined],
      ["1/1 cells running\n[1] js Print lines running", undefined],
      ["1/1 cells running\n[1] js Print lines running\nfirst\n", "first\n"],
      ["1/1 cells running\n[1] js Print lines running\nfirst\nsecond\n", "first\nsecond\n"],
      ["1/1 cells complete\n[1] js Print lines complete\nfirst\nsecond\n", "first\nsecond\n"],
      ["1/1 cells running\n[1] js Print lines running\n", "first\nsecond\n"],
      ["1/1 cells running\n[1] js Print lines running\n\n", "first\nsecond\n"],
      ["waiting for the js kernel to be ready\n", "first\nsecond\n"],
      ["", "first\nsecond\n"],
    ],
  ],
] as const) {
  test(`running ${name} publishes cumulative output without clearing earlier text`, () => {
    const { s, manager, part, events, call } = runningTool(name);
    assert.ok(part.state.status === "running");
    part.state.metadata = { retained: true };
    for (const [text, expected] of updates) {
      manager["onPiEvent"](s, {
        type: "tool_execution_update",
        toolCallId: call.id,
        toolName: name,
        partialResult: { content: [{ type: "text", text }] },
      });
      const emitted = events.at(-1);
      assert.ok(emitted?.type === "message.part.updated" && emitted.properties.part.type === "tool");
      assert.ok(emitted.properties.part.state.status === "running");
      assert.equal(emitted.properties.part.state.metadata?.output, expected, `live output for ${JSON.stringify(text)}`);
      assert.equal(emitted.properties.part.state.metadata?.retained, true);
      assert.equal(emitted.properties.part.id, part.id);
    }
  });
}

test("live output uses text blocks only and ignores missing or late partial results", () => {
  const { s, manager, part, events, call } = runningTool("bash", { command: "echo one; echo two" });
  for (const partialResult of [
    {
      content: [
        { type: "text", text: "one\n" },
        { type: "image", text: "hidden" },
        { type: "text", text: "two\n" },
      ],
    },
    undefined,
    null,
    { content: "not blocks" },
  ]) {
    manager["onPiEvent"](s, { type: "tool_execution_update", toolCallId: call.id, toolName: "bash", partialResult });
    assert.ok(part.state.status === "running");
    assert.equal(part.state.metadata?.output, "one\ntwo\n");
  }
  manager["onPiEvent"](s, {
    type: "tool_execution_end",
    toolCallId: call.id,
    result: { content: [{ type: "text", text: "final\n" }] },
    isError: false,
  });
  const count = events.length;
  for (const toolCallId of [call.id, "unknown"]) {
    manager["onPiEvent"](s, { type: "tool_execution_update", toolCallId, partialResult: {} });
  }
  assert.equal(events.length, count);
  assert.ok(part.state.status === "completed");
  assert.equal(part.state.output, "final\n");
});

test("eval removes only its leading status header and preserves multi-cell labels", () => {
  for (const [text, expected] of [
    ["1/1 cell running\n[1] py Print lines running\nhello\n", "hello\n"],
    [
      "2/2 cells complete\n[1] js First complete\none\n[2] py Second complete\ntwo\n",
      "[1] js First complete\none\n[2] py Second complete\ntwo\n",
    ],
    [
      "hello\n1/1 cells running\n[1] js Printed header running\n",
      "hello\n1/1 cells running\n[1] js Printed header running\n",
    ],
    ["waiting for the js kernel to be ready\nhello\n", "waiting for the js kernel to be ready\nhello\n"],
  ]) {
    const { s, manager, part, call } = runningTool("eval");
    manager["onPiEvent"](s, {
      type: "tool_execution_update",
      toolCallId: call.id,
      toolName: "eval",
      partialResult: { content: [{ type: "text", text }] },
    });
    assert.ok(part.state.status === "running");
    assert.equal(part.state.metadata?.output, expected);
  }
});

for (const [name, args] of [
  ["bash", { command: "echo hello" }],
  ["eval", { code: 'print("hello")', language: "js", summary: "Print hello" }],
  ["bash_output", { bash_id: "bash_2" }],
  ["bash_input", { bash_id: "bash_2", input: "pwd" }],
  ["kill_bash", { bash_id: "bash_2" }],
  ["bash_resize", { bash_id: "bash_2", cols: 100, rows: 30 }],
] as const) {
  test(`${name} keeps its completed renderer shape, result and identity after history reload`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), "antechamber-live-output-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { s, manager, part, call } = runningTool(name, args);
    s.piPath = join(dir, "session.jsonl");
    const message = {
      role: "assistant",
      content: [{ type: "toolCall", ...call }],
      stopReason: "toolUse",
      timestamp: 1000,
    };
    manager["onPiEvent"](s, { type: "message_end", message });
    const result = {
      role: "toolResult",
      toolCallId: call.id,
      toolName: name,
      content: [{ type: "text", text: "hello\n" }],
      timestamp: 1001,
      isError: false,
    };
    writeFileSync(
      s.piPath,
      [
        { type: "message", id: "call-entry", parentId: null, timestamp: 1000, message },
        { type: "message", id: "result-entry", parentId: "call-entry", timestamp: 1001, message: result },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
    );
    manager["onPiEvent"](s, {
      type: "tool_execution_update",
      toolCallId: call.id,
      toolName: name,
      partialResult: { content: [{ type: "text", text: "partial\n" }] },
    });
    manager["onPiEvent"](s, {
      type: "tool_execution_end",
      toolCallId: call.id,
      toolName: name,
      result,
      isError: false,
    });
    manager["onPiEvent"](s, { type: "agent_end" });
    assert.equal(part.tool, "bash");
    assert.ok(part.state.status === "completed");
    assert.equal(part.state.output, "hello\n");
    const restored = session(s.piPath);
    restored.tree = structuredClone(s.tree);
    restored.messages = undefined;
    const history = manager["ensureMessages"](restored);
    const reloaded = history[0]?.parts[0];
    assert.ok(reloaded?.type === "tool" && reloaded.state.status === "completed");
    assert.equal(reloaded.id, part.id);
    assert.equal(reloaded.messageID, part.messageID);
    assert.equal(reloaded.callID, part.callID);
    assert.equal(reloaded.tool, part.tool);
    assert.deepEqual(reloaded.state.input, part.state.input);
    assert.equal(reloaded.state.title, part.state.title);
    assert.equal(reloaded.state.output, part.state.output);
    if (name === "eval") {
      // The OmO Graph extension heads eval cards from these fields, live and after reload.
      for (const state of [part.state, reloaded.state]) {
        assert.equal(state.metadata?.evalTitle, "JS Eval");
        assert.equal(state.metadata?.evalSubtitle, "Print hello");
      }
    }
    restored.messages = undefined;
    assert.deepEqual(manager["ensureMessages"](restored), history);
  });
}

test("eval shell cards cannot bind to a user bashExecution with identical command and output", () => {
  const { s, manager, part, call } = runningTool("eval", { code: "echo same" });
  manager["onPiEvent"](s, {
    type: "tool_execution_end",
    toolCallId: call.id,
    result: { content: [{ type: "text", text: "same\n" }] },
    isError: false,
  });
  assert.equal(part.tool, "bash");
  bindMessageEntries(s, {
    leafId: "shell-entry",
    entries: [
      {
        type: "message",
        id: "shell-entry",
        parentId: null,
        message: { role: "bashExecution", command: "echo same", output: "same\n" },
      },
    ],
  });
  assert.equal(s.tree.messageEntries[part.messageID], undefined);
});

test("bashExecution history restores ordered terminal cards with stable ids and stored output", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "antechamber-bash-history-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const piPath = join(dir, "session.jsonl");
  const messages = [
    { role: "user", content: [{ type: "text", text: "hello" }] },
    { role: "assistant", content: [{ type: "text", text: "reply" }], provider: "fake", model: "fake-model" },
    { role: "bashExecution", command: "echo hi", output: "hi\n", exitCode: 0, cancelled: false, truncated: false },
    { role: "bashExecution", command: "sleep 600", output: "", cancelled: true, truncated: false },
    {
      role: "bashExecution",
      command: "exit 3",
      output: "stored output\n",
      exitCode: 3,
      cancelled: false,
      truncated: true,
      fullOutputPath: "/tmp/full-output",
    },
  ];
  writeFileSync(
    piPath,
    messages
      .map((message, idx) =>
        JSON.stringify({
          type: "message",
          id: `e${idx}`,
          parentId: idx === 0 ? null : `e${idx - 1}`,
          message: { ...message, timestamp: 1000 + idx },
        }),
      )
      .join("\n"),
  );
  const manager = new SessionManager(() => {}, new SessionStore(join(dir, "state")));
  t.after(() => manager.disposeAll());
  const restored = session(piPath);
  restored.messages = undefined;
  const history = manager["ensureMessages"](restored);
  assert.equal(history.length, 8);
  const users = history.slice(2).filter((message) => message.info.role === "user");
  const cards = history.slice(2).filter((message) => message.info.role === "assistant");
  assert.deepEqual(
    users.map((message) => message.info.id),
    [2, 3, 4].map((idx) => `msg_ses_test_r${idx}u`),
  );
  assert.deepEqual(
    cards.map((message) => message.info.id),
    [2, 3, 4].map((idx) => `msg_ses_test_r${idx}z`),
  );
  for (const [offset, card] of cards.entries()) {
    const idx = offset + 2;
    assert.ok(card.info.role === "assistant");
    assert.equal(card.info.parentID, users[offset]?.info.id);
    assert.ok(card.info.parentID < card.info.id, "client ID ordering must place the shell user before its assistant");
    const userPart = users[offset]?.parts[0];
    assert.ok(userPart?.type === "text" && userPart.synthetic === true);
    assert.deepEqual(card.info.time, { created: 1000 + idx, completed: 1000 + idx });
    assert.equal(card.parts.length, 1);
    const part = card.parts[0];
    assert.ok(part?.type === "tool");
    assert.equal(part.id, `prt_ses_test_r${idx}_0`);
    assert.equal(part.tool, "bash");
    assert.deepEqual(part.state.input, { command: messages[idx]?.command, description: messages[idx]?.command });
    assert.notEqual(part.state.status, "pending");
    assert.ok(part.state.status !== "pending");
    assert.deepEqual(part.state.time, { start: 1000 + idx, end: 1000 + idx });
    assert.equal(restored.tree.messageEntries[card.info.id], `e${idx}`);
    assert.equal(restored.tree.messageEntries[card.info.parentID], `e${idx}`);
  }
  const [success, cancelled, failed] = cards.map((card) => card.parts[0]);
  assert.ok(success?.type === "tool" && success.state.status === "completed");
  assert.equal(success.state.title, "bash: echo hi");
  assert.equal(success.state.output, "hi\n");
  assert.deepEqual(success.state.metadata, { exitCode: 0, cancelled: false, truncated: false });
  assert.ok(cancelled?.type === "tool" && cancelled.state.status === "error");
  assert.equal(cancelled.state.error, "Command cancelled");
  assert.equal(cancelled.state.metadata?.cancelled, true);
  assert.equal(cancelled.state.metadata?.truncated, false);
  assert.ok(failed?.type === "tool" && failed.state.status === "completed");
  assert.equal(failed.state.output, "stored output\n");
  assert.deepEqual(failed.state.metadata, {
    exitCode: 3,
    cancelled: false,
    truncated: true,
    fullOutputPath: "/tmp/full-output",
  });
  assert.deepEqual(
    cards.map((card) => toV2Message(card).type),
    ["assistant", "assistant", "assistant"],
  );
  restored.messages = undefined;
  assert.deepEqual(manager["ensureMessages"](restored), history);
});

test("a shell-only persisted session restores a synthetic user and linked assistant bash card", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "antechamber-bash-only-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const piPath = join(dir, "session.jsonl");
  writeFileSync(
    piPath,
    JSON.stringify({
      type: "message",
      id: "bash-only",
      parentId: null,
      timestamp: 1234,
      message: {
        role: "bashExecution",
        command: "echo hi",
        output: "hi\n",
        exitCode: 0,
        cancelled: false,
        truncated: false,
      },
    }),
  );
  const manager = new SessionManager(() => {}, new SessionStore(join(dir, "state")));
  t.after(() => manager.disposeAll());
  const restored = session(piPath);
  restored.messages = undefined;
  const history = manager["ensureMessages"](restored);
  assert.equal(history.length, 2);
  assert.equal(history[0]?.info.role, "user");
  const card = history[1];
  assert.ok(card?.info.role === "assistant");
  assert.equal(card.info.parentID, history[0]?.info.id);
  const v2 = toV2Message(card);
  assert.equal(v2.type, "assistant");
  assert.equal(v2.content?.[0]?.name, "bash");
});

for (const executionEvents of [true, false]) {
  test(`real RPC ${executionEvents ? "execution" : "turn_end-only"} events and JSONL history produce identical tool parts`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), "antechamber-tool-map-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    t.mock.method(Date, "now", () => 1000);
    const piPath = join(dir, "session.jsonl");
    const live = session(piPath);
    const manager = new SessionManager(() => {}, new SessionStore(join(dir, "registry.json")));
    const events = readFileSync(join(process.cwd(), "test/fixtures/omo-rpc/run1.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const entries: Record<string, unknown>[] = [];
    for (const event of events) {
      if (!executionEvents && String(event.type).startsWith("tool_execution_")) continue;
      manager["onPiEvent"](live, event);
      if (event.type === "entry_appended") {
        const entry = event.entry as Record<string, unknown>;
        if (entry.customType === "senpi.todo-state") {
          entries.push({ ...entry, id: `e${entries.length}`, parentId: entries.at(-1)?.id ?? null, timestamp: 1000 });
        }
      }
      if (event.type !== "message_end") continue;
      const message = event.message as Record<string, unknown>;
      if (!["user", "assistant", "toolResult"].includes(String(message.role))) continue;
      const parentId = entries.length > 0 ? String(entries[entries.length - 1]?.id) : null;
      entries.push({ type: "message", id: `e${entries.length}`, parentId, timestamp: 1000, message });
    }
    writeFileSync(piPath, entries.map((entry) => JSON.stringify(entry)).join("\n"));
    const restored = session(piPath);
    restored.messages = undefined;
    const history = manager["ensureMessages"](restored);
    const liveParts =
      live.messages?.flatMap((message) => message.parts).filter((part): part is OCToolPart => part.type === "tool") ??
      [];
    const historyParts = history
      .flatMap((message) => message.parts)
      .filter((part): part is OCToolPart => part.type === "tool");
    assert.ok(liveParts.length >= 5);
    assert.deepEqual(liveParts.map(comparable), historyParts.map(comparable));
    assert.ok(liveParts.some((part) => part.tool === "read"));
    assert.ok(liveParts.some((part) => part.tool === "write"));
    assert.ok(liveParts.some((part) => part.tool === "edit"));
    for (const part of [...liveParts, ...historyParts].filter((part) => part.tool === "write")) {
      assert.ok(part.state.status === "completed");
      assert.deepEqual(part.state.metadata, {});
    }
  });
}

for (const resultEvent of ["tool_execution_end", "turn_end"]) {
  test(`${resultEvent} errors preserve mapped input metadata and error text`, () => {
    const s = session("/nonexistent");
    const manager = new SessionManager(() => {});
    manager["onPiEvent"](s, { type: "message_start", message: { role: "assistant" } });
    manager["onPiEvent"](s, {
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: { id: "failed", name: "edit", arguments: { path: "x", edits: [{ oldText: "a", newText: "b" }] } },
      },
    });
    const result = { toolCallId: "failed", isError: true, content: [{ type: "text", text: "edit failed" }] };
    manager["onPiEvent"](
      s,
      resultEvent === "turn_end"
        ? { type: resultEvent, toolResults: [result] }
        : { type: resultEvent, ...result, result },
    );
    const part = s.messages?.[0]?.parts[0];
    assert.ok(part?.type === "tool" && part.state.status === "error");
    assert.equal(part.state.error, "edit failed");
    assert.deepEqual(part.state.input, { filePath: "x", oldString: "a", newString: "b" });
    assert.deepEqual(part.state.metadata, { filediff: { file: "x" } });
  });
}

test("a failed eval cell, flagged only in details.isError, is an error card live and after reload", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "antechamber-eval-failed-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const args = {
    code: 'print("BEFORE"); throw new Error("CELL_FAILED_ON_PURPOSE")',
    language: "js",
    summary: "fail check",
  };
  const { s, manager, part, call } = runningTool("eval", args);
  s.piPath = join(dir, "session.jsonl");
  const message = {
    role: "assistant",
    content: [{ type: "toolCall", ...call }],
    stopReason: "toolUse",
    timestamp: 1000,
  };
  manager["onPiEvent"](s, { type: "message_end", message });
  // Captured from a live OmO session, 2026-10-17: top-level isError stays false.
  const result = {
    role: "toolResult",
    toolCallId: call.id,
    toolName: "eval",
    content: [{ type: "text", text: "BEFORE\nCELL_FAILED_ON_PURPOSE" }],
    details: { language: "js", summary: "fail check", isError: true },
    isError: false,
    timestamp: 1001,
  };
  writeFileSync(
    s.piPath,
    [
      { type: "message", id: "call-entry", parentId: null, timestamp: 1000, message },
      { type: "message", id: "result-entry", parentId: "call-entry", timestamp: 1001, message: result },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n"),
  );
  manager["onPiEvent"](s, {
    type: "tool_execution_end",
    toolCallId: call.id,
    toolName: "eval",
    result,
    isError: false,
  });
  assert.ok(part.state.status === "error");
  assert.equal(part.state.error, "BEFORE\nCELL_FAILED_ON_PURPOSE");
  const restored = session(s.piPath);
  restored.tree = structuredClone(s.tree);
  restored.messages = undefined;
  const reloaded = manager["ensureMessages"](restored)[0]?.parts[0];
  assert.ok(reloaded?.type === "tool" && reloaded.state.status === "error");
  assert.equal(reloaded.state.error, "BEFORE\nCELL_FAILED_ON_PURPOSE");
});
