/// <reference types="node" />
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { AdapterServer } from "../src/server.js";
import { ocIdFor, piSessionDir, SessionStore } from "../src/session-store.js";
import { type ManagedSession, SessionManager } from "../src/sessions.js";
import { evalAgentSession, findTask, findTaskBySession, JsonlTail, stripTaskSuffix } from "../src/subagents.js";
import type { OCEvent, OCMessageWithParts, OCToolPart } from "../src/types.js";
import { bugHarness } from "./bug-harness.js";

const fixture = JSON.parse(readFileSync("test/fixtures/omo-tools/task.json", "utf8"));
const rpc = readFileSync("test/fixtures/omo-rpc/run1.jsonl", "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as Record<string, unknown>);

function put(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}

function transcript(text: string, childId = "child-pi"): string {
  return `${[
    { type: "session", version: 3, id: childId, cwd: "/tmp/test", timestamp: "2026-10-12T00:00:00.000Z" },
    {
      type: "message",
      id: "u",
      parentId: null,
      timestamp: 1,
      message: { role: "user", content: [{ type: "text", text: "Do the child job" }] },
    },
    {
      type: "message",
      id: "a",
      parentId: "u",
      timestamp: 2,
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "haiku",
        content: [
          { type: "thinking", thinking: "Read the file first." },
          { type: "toolCall", id: "read-1", name: "read", arguments: { path: "child.txt" } },
        ],
      },
    },
    {
      type: "message",
      id: "r",
      parentId: "a",
      timestamp: 3,
      message: {
        role: "toolResult",
        toolCallId: "read-1",
        toolName: "read",
        content: [{ type: "text", text: "contents" }],
      },
    },
    {
      type: "message",
      id: "z",
      parentId: "r",
      timestamp: 4,
      message: { role: "assistant", provider: "anthropic", model: "haiku", content: [{ type: "text", text }] },
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n")}\n`;
}

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "antechamber-subagents-"));
  const agent = join(dir, "agent");
  const state = join(dir, "state");
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  const previousState = process.env.ANTECHAMBER_STATE_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  process.env.ANTECHAMBER_STATE_DIR = state;
  const directory = join(dir, "work");
  mkdirSync(directory);
  const parentPath = join(piSessionDir(directory), "parent.jsonl");
  put(
    parentPath,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "parent-pi",
      cwd: directory,
      timestamp: "2026-10-12T00:00:00.000Z",
    })}\n`,
  );
  const bus = new EventEmitter();
  const events: OCEvent[] = [];
  const manager = new SessionManager(
    (_directory, event) => {
      events.push(structuredClone(event) as OCEvent);
      bus.emit("event", event as OCEvent);
    },
    new SessionStore(state),
    directory,
  );
  const parent = manager.get(ocIdFor("parent-pi"));
  assert.ok(parent);
  manager.messages(parent.info.id);
  const store = join(agent, "projects", "work-hash", "senpi-task");
  mkdirSync(join(store, "tasks"), { recursive: true });
  put(join(agent, "rpc", "task-stores.json"), { version: 1, stores: { [store]: {} } });
  t.after(async () => {
    await manager.disposeAll();
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgent;
    if (previousState === undefined) delete process.env.ANTECHAMBER_STATE_DIR;
    else process.env.ANTECHAMBER_STATE_DIR = previousState;
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, agent, state, directory, parentPath, parent, manager, bus, events, store };
}

function start(manager: SessionManager, parent: ManagedSession, args: Record<string, unknown>, callID = "spawn"): void {
  manager["onPiEvent"](parent, { type: "message_start", message: { role: "assistant" } });
  manager["onPiEvent"](parent, {
    type: "message_update",
    assistantMessageEvent: {
      type: "toolcall_start",
      contentIndex: 0,
      id: callID,
      toolName: "task",
    },
  });
  manager["onPiEvent"](parent, {
    type: "message_update",
    assistantMessageEvent: {
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: { id: callID, name: "task", arguments: args },
    },
  });
  manager["onPiEvent"](parent, { type: "tool_execution_start", toolCallId: callID, toolName: "task", args });
}

function result(
  manager: SessionManager,
  parent: ManagedSession,
  details: Record<string, unknown>,
  text = "done",
  ended = true,
  callID = "spawn",
): void {
  const payload = { details, content: [{ type: "text", text }] };
  manager["onPiEvent"](
    parent,
    ended
      ? { type: "tool_execution_end", toolCallId: callID, toolName: "task", result: payload }
      : { type: "tool_execution_update", toolCallId: callID, toolName: "task", partialResult: payload },
  );
}

function parts(messages: OCMessageWithParts[] | undefined): OCToolPart[] {
  return (messages ?? [])
    .flatMap((message) => message.parts)
    .filter((part): part is OCToolPart => part.type === "tool");
}

function texts(messages: OCMessageWithParts[] | undefined): string {
  return (messages ?? [])
    .flatMap((message) => message.parts)
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function liveRecord(store: string, id = "st_child", status = "running", text = "child result") {
  const path = join(store, "children", id, "sessions", id, "child.jsonl");
  put(path, transcript(text));
  const data = {
    task_id: id,
    parent_session_id: "parent-pi",
    status,
    host_session: { session_path: path },
    final_response: text,
  };
  const recordPath = join(store, "tasks", `${id}.json`);
  put(recordPath, data);
  return { path, recordPath, data };
}

function eventWhen(bus: EventEmitter, predicate: (event: OCEvent) => boolean): Promise<OCEvent> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      bus.off("event", listener);
      clearTimeout(timer);
    };
    const timeout = () => {
      cleanup();
      reject(new Error("Expected bridge event was not emitted"));
    };
    const listener = (event: OCEvent) => {
      if (predicate(event)) {
        cleanup();
        resolve(event);
      }
    };
    bus.on("event", listener);
    // The bridge watchers are nonpersistent; this wait must keep its deadline alive.
    const timer = setTimeout(timeout, 5000);
  });
}

function collidingTasks(t: TestContext) {
  const context = setup(t);
  const { manager, agent, directory, store } = context;
  const first = liveRecord(store, "st_shared", "completed", "FIRST_TASK_TRANSCRIPT");
  put(first.recordPath, {
    ...first.data,
    child_session_id: "first-child",
    name: "first",
    created_at: "2026-10-12T00:00:00.000Z",
    spawn_spec: { prompt: "first prompt" },
  });
  put(first.path, transcript("FIRST_TASK_TRANSCRIPT", "first-child"));
  put(
    join(piSessionDir(directory), "other-parent.jsonl"),
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "other-parent-pi",
      cwd: directory,
      timestamp: "2026-10-12T00:00:00.000Z",
    })}\n`,
  );
  const other = manager.get(ocIdFor("other-parent-pi"));
  assert.ok(other);
  manager.messages(other.info.id);
  const otherStore = join(agent, "projects", "other-project", "senpi-task");
  const second = liveRecord(otherStore, "st_shared", "completed", "SECOND_TASK_TRANSCRIPT");
  put(second.path, transcript("SECOND_TASK_TRANSCRIPT", "second-child"));
  put(second.recordPath, {
    ...second.data,
    parent_session_id: "other-parent-pi",
    child_session_id: "second-child",
    name: "second",
    created_at: "2026-10-12T00:00:00.000Z",
    spawn_spec: { prompt: "second prompt" },
  });
  return { ...context, other, otherStore, first, second };
}

test("collision lookup rejects an ambiguous bare task session id", (t) => {
  collidingTasks(t);
  assert.equal(findTaskBySession(ocIdFor("st_shared")), undefined);
});

test("collision discovery isolates task cards archives updates and deletion across parents", async (t) => {
  const { manager, parent, other, directory, state, first, second } = collidingTasks(t);
  start(manager, parent, { prompt: "first prompt" });
  result(manager, parent, { task_id: "st_shared", status: "completed" });
  start(manager, other, { prompt: "second prompt" });
  result(manager, other, { task_id: "st_shared", status: "completed" });
  const children = manager.list(directory).filter((session) => session.parentID !== undefined);
  assert.equal(children.length, 2, "both stores' st_shared tasks must be listed");
  const firstID = children.find((session) => session.parentID === parent.info.id)?.id;
  const secondID = children.find((session) => session.parentID === other.info.id)?.id;
  assert.ok(firstID && secondID);
  assert.notEqual(firstID, secondID);
  assert.match(texts(manager.messages(firstID)), /FIRST_TASK_TRANSCRIPT/);
  assert.match(texts(manager.messages(secondID)), /SECOND_TASK_TRANSCRIPT/);
  for (const [owner, childID] of [
    [parent, firstID],
    [other, secondID],
  ] as const) {
    const part = parts(owner.messages)[0];
    assert.ok(part && part.state.status !== "pending");
    assert.equal(part.state.metadata?.sessionID, childID);
  }
  const registry = new SessionStore(state);
  const firstArchive = registry.get(firstID)?.piPath;
  const secondArchive = registry.get(secondID)?.piPath;
  assert.ok(firstArchive && secondArchive);
  assert.notEqual(firstArchive, secondArchive);
  assert.equal(readFileSync(firstArchive, "utf8"), readFileSync(first.path, "utf8"));
  assert.equal(readFileSync(secondArchive, "utf8"), readFileSync(second.path, "utf8"));
  const terminalAt = manager.subagents["children"].get(secondID)?.task.terminalAt;
  assert.notEqual(terminalAt, undefined);
  manager.subagents.observe(other, {
    name: "omo.task.updated",
    data: {
      tasks: [{ task_id: "st_shared", status: "running", updated_at: new Date((terminalAt ?? 0) + 1).toISOString() }],
    },
  });
  assert.equal(manager.get(firstID)?.status.type, "idle");
  assert.equal(manager.get(secondID)?.status.type, "busy");
  manager.subagents.wake(parent, {
    customType: "omo-senpi:wake",
    details: [{ task_id: "st_shared", status: "error", error_message: "FIRST_ONLY_ERROR" }],
  });
  assert.equal(manager.subagents["children"].get(firstID)?.task.details.status, "error");
  assert.equal(manager.subagents["children"].get(secondID)?.task.details.status, "running");
  await manager.remove(firstID);
  manager.subagents.discover(parent, parent.messages ?? []);
  assert.equal(manager.get(firstID), undefined);
  assert.equal(manager.get(secondID)?.info.parentID, other.info.id);
  await manager.disposeAll();
  const restarted = new SessionManager(() => {}, new SessionStore(state), directory);
  t.after(() => restarted.disposeAll());
  assert.equal(restarted.get(firstID), undefined);
  assert.equal(restarted.get(secondID)?.info.parentID, other.info.id);
  assert.match(texts(restarted.messages(secondID)), /SECOND_TASK_TRANSCRIPT/);
});

test("collision eval links and record-only discovery resolve the same qualified children", (t) => {
  const { manager, parent, other, directory } = collidingTasks(t);
  const children = manager.list(directory).filter((session) => session.parentID !== undefined);
  assert.equal(children.length, 2);
  for (const [owner, prompt] of [
    [parent, "first prompt"],
    [other, "second prompt"],
  ] as const) {
    const child = children.find((session) => session.parentID === owner.info.id);
    assert.ok(child);
    assert.equal(
      evalAgentSession(owner.restored?.piSessionId, { prompt }, new Set(), Date.parse("2026-10-12"))?.sessionID,
      child.id,
    );
    assert.equal(findTaskBySession(child.id)?.data.parent_session_id, owner.restored?.piSessionId);
  }
});

test("foreign completed archive is repaired from the canonical host transcript under its legacy id", (t) => {
  const { manager, parent, store, state, directory } = setup(t);
  const child = liveRecord(store, "st_child", "completed", "CANONICAL_TASK_TRANSCRIPT");
  put(child.path, transcript("CANONICAL_TASK_TRANSCRIPT", "correct-child"));
  const archive = join(state, "children", "st_child.jsonl");
  put(archive, transcript("FOREIGN_TASK_TRANSCRIPT", "foreign-child"));
  const childID = ocIdFor("st_child");
  manager["store"].set(childID, {
    piSessionId: "foreign-child",
    piPath: archive,
    directory,
    title: "retained title",
    archived: 1234,
    parentID: parent.info.id,
    task: {
      id: "st_child",
      parentPiId: "parent-pi",
      input: {},
      details: { ...child.data, child_session_id: "foreign-child" },
    },
    created: 1,
    updated: 2,
  });
  const restored = manager.get(childID);
  assert.equal(restored?.info.id, childID);
  assert.equal(restored.info.title, "retained title");
  assert.equal(restored.info.time.archived, 1234);
  assert.match(texts(manager.messages(childID)), /CANONICAL_TASK_TRANSCRIPT/);
  assert.doesNotMatch(texts(manager.messages(childID)), /FOREIGN_TASK_TRANSCRIPT/);
  assert.equal(restored.piSessionId, "correct-child");
  assert.equal(new SessionStore(state).get(childID)?.piSessionId, "correct-child");
  assert.equal(readFileSync(archive, "utf8"), readFileSync(child.path, "utf8"));
});

for (const order of ["repair-first", "archive-first"] as const) {
  test(`foreign archive repair preserves archive-only colliding history: ${order}`, (t) => {
    const { manager, parent, state, directory, first, second } = collidingTasks(t);
    const withCost = (raw: string, cost: number) =>
      `${raw}${JSON.stringify({
        type: "message",
        id: "cost",
        parentId: "z",
        timestamp: 5,
        message: { role: "assistant", content: [], usage: { cost: { total: cost } } },
      })}\n`;
    put(first.path, withCost(readFileSync(first.path, "utf8"), 1));
    const retained = withCost(readFileSync(second.path, "utf8"), 2);
    rmSync(second.path);
    const archive = join(state, "children", "st_shared.jsonl");
    put(archive, retained);
    const firstID = ocIdFor("st_shared");
    const secondID = ocIdFor("other-parent-pi:st_shared");
    manager["store"].set(firstID, {
      piSessionId: "second-child",
      piPath: archive,
      directory,
      parentID: parent.info.id,
      task: { id: "st_shared", parentPiId: "parent-pi", input: {}, details: first.data },
      created: 1,
      updated: 2,
    });
    for (const id of order === "repair-first" ? [firstID, secondID] : [secondID, firstID]) {
      assert.ok(manager.get(id));
    }
    assert.match(texts(manager.messages(firstID)), /FIRST_TASK_TRANSCRIPT/);
    assert.match(texts(manager.messages(secondID)), /SECOND_TASK_TRANSCRIPT/);
    assert.equal(manager.get(firstID)?.info.cost, 1);
    assert.equal(manager.get(secondID)?.info.cost, 2);
    const secondArchive = manager["store"].get(secondID)?.piPath;
    assert.ok(secondArchive);
    assert.equal(readFileSync(secondArchive, "utf8"), retained);
  });
}

test("foreign completed archive is rejected using child_session_id when canonical history is missing", (t) => {
  const { manager, parent, state, store } = setup(t);
  put(join(state, "children", "st_child.jsonl"), transcript("FOREIGN_TASK_TRANSCRIPT", "foreign-child"));
  put(join(store, "tasks", "st_child.json"), {
    task_id: "st_child",
    parent_session_id: "parent-pi",
    child_session_id: "correct-child",
    status: "completed",
    final_response: "CORRECT_FALLBACK",
  });
  start(manager, parent, {});
  result(manager, parent, { task_id: "st_child", status: "completed" });
  const history = texts(manager.messages(ocIdFor("st_child")));
  assert.match(history, /CORRECT_FALLBACK/);
  assert.doesNotMatch(history, /FOREIGN_TASK_TRANSCRIPT/);
});

test("collision preserves an existing custom registry id and scopes legacy deletion tombstones", (t) => {
  const { manager, parent, other, state, directory, first } = collidingTasks(t);
  const customID = "ses_custom_bookmark";
  const archive = join(state, "children", "st_shared.jsonl");
  put(archive, readFileSync(first.path, "utf8"));
  manager["store"].set(customID, {
    piSessionId: "first-child",
    piPath: archive,
    directory,
    parentID: parent.info.id,
    task: { id: "st_shared", parentPiId: "parent-pi", input: {}, details: first.data },
    created: 1,
    updated: 2,
  });
  manager["store"].set(ocIdFor("st_shared"), {
    deleted: true,
    piSessionId: "first-child",
    piPath: archive,
    directory,
    parentID: parent.info.id,
    created: 1,
    updated: 2,
  });
  assert.equal(manager.get(customID)?.info.id, customID);
  const otherChild = manager.list(directory).find((session) => session.parentID === other.info.id);
  assert.ok(otherChild, "another parent's task must not inherit a legacy tombstone");
  assert.notEqual(otherChild.id, customID);
  assert.match(texts(manager.messages(otherChild.id)), /SECOND_TASK_TRANSCRIPT/);
  assert.equal(manager.list(directory).filter((session) => session.parentID === parent.info.id).length, 1);
});

test("single real RPC task creates a linked nested session and strips the suffix", (t) => {
  const { manager, parent, events } = setup(t);
  for (const event of rpc) manager["onPiEvent"](parent, event);
  const task = parts(parent.messages).find((part) => part.tool === "task");
  assert.ok(task && task.state.status === "completed");
  assert.equal(task.state.output, "quick task done");
  const childID = ocIdFor("st_01a13227");
  assert.equal(task.state.metadata.sessionID, childID);
  assert.equal(manager.get(childID)?.info.parentID, parent.info.id);
  assert.ok(events.some((event) => event.type === "session.created" && event.properties.info.id === childID));
  assert.ok(texts(manager.messages(childID)).includes("quick task done"));
});

test("F2 B3 child registry save failure emits a visible session error", (t) => {
  const { manager, parent, events, state } = setup(t);
  mkdirSync(join(state, "sessions.json"), { recursive: true });
  start(manager, parent, { description: "save failure", prompt: "child job", category: "quick" });
  result(manager, parent, { task_id: "st_save_failure", status: "completed", final_response: "done" });
  assert.ok(
    events.some(
      (event) =>
        event.type === "session.error" &&
        event.properties.sessionID === ocIdFor("st_save_failure") &&
        event.properties.error?.name === "SessionPersistenceError",
    ),
  );
});

test("real tasks array yields stable parts and separately fetchable children", (t) => {
  const { manager, parent, directory } = setup(t);
  const batch = fixture.samples[1];
  start(manager, parent, batch.arguments, "batch");
  manager["onPiEvent"](parent, { type: "tool_execution_end", toolCallId: "batch", result: batch });
  const cards = parts(parent.messages);
  assert.equal(cards.length, 4);
  cards.forEach((card, index) => {
    assert.equal(card.id, `prt_task_batch_${index}`);
    assert.equal(card.state.input.description, batch.arguments.tasks[index].task_summary);
    assert.equal(card.state.input.subagent_type, "deep-low");
    assert.notEqual(card.state.status, "pending");
    if (card.state.status === "pending") return;
    const childID = ocIdFor(batch.details.items[index].task_id);
    assert.equal(card.state.metadata?.sessionID, childID);
    assert.equal(manager.get(childID)?.info.parentID, parent.info.id);
    assert.ok(manager.list(directory).some((session) => session.id === childID));
    assert.ok(manager.messages(childID));
  });
});

test("rediscovery replaces one logical task card while keeping batch cards distinct", (t) => {
  const { manager, parent, events } = setup(t);
  start(manager, parent, { task_summary: "Stable child", prompt: "work" });
  result(manager, parent, { task_id: "st_stable", status: "completed", final_response: "done" });
  const original = parts(parent.messages)[0];
  assert.ok(original);
  const child = manager.subagents["children"].get(ocIdFor("st_stable"));
  assert.ok(child);
  events.splice(0);
  for (let index = 0; index < 3; index++) {
    manager.subagents.discover(parent, [{ info: parent.messages![0]!.info, parts: [structuredClone(original)] }]);
  }
  assert.equal(child.parts.size, 1);
  assert.equal(events.filter((event) => event.type === "message.part.updated").length, 3);

  const batch = fixture.samples[1];
  start(manager, parent, batch.arguments, "distinct-batch");
  manager["onPiEvent"](parent, { type: "tool_execution_end", toolCallId: "distinct-batch", result: batch });
  const batchChildren = (batch.details.items as Array<{ task_id: string }>).map((item) =>
    manager.subagents["children"].get(ocIdFor(item.task_id)),
  );
  assert.equal(batchChildren.length, 4);
  assert.ok(
    batchChildren.every((batchChild: { parts: Map<string, OCToolPart> } | undefined) => batchChild?.parts.size === 1),
  );
});

test("terminal record atomically archives and emits idle after streaming shared tool cards", async (t) => {
  const { manager, parent, store, state, bus } = setup(t);
  const child = liveRecord(store);
  start(manager, parent, { category: "quick", task_summary: "Child", prompt: "work" });
  result(manager, parent, { task_id: "st_child", status: "running" }, "", false);
  assert.equal(parent.hasRunningChildren(), true);
  const childID = ocIdFor("st_child");
  assert.equal(manager.get(childID)?.status.type, "busy");
  const read = parts(manager.messages(childID)).find((part) => part.tool === "read");
  assert.deepEqual(read?.state.input, { filePath: "child.txt", offset: undefined, limit: undefined });
  assert.equal(read?.state.status, "completed");
  assert.ok(manager.messages(childID)?.some((message) => message.parts.some((part) => part.type === "reasoning")));
  const idle = eventWhen(bus, (event) => event.type === "session.idle" && event.properties.sessionID === childID);
  put(`${child.recordPath}.tmp`, { ...child.data, status: "completed" });
  renameSync(`${child.recordPath}.tmp`, child.recordPath);
  await idle;
  assert.equal(parent.hasRunningChildren(), false);
  assert.equal(readFileSync(join(state, "children", "st_child.jsonl"), "utf8"), readFileSync(child.path, "utf8"));
  assert.deepEqual(readdirSync(join(state, "children")), ["st_child.jsonl"]);
});

test("history prefers archive over a conflicting completed live transcript", (t) => {
  const { manager, parent, store, state } = setup(t);
  liveRecord(store, "st_child", "completed", "stale live transcript");
  put(join(state, "children", "st_child.jsonl"), transcript("authoritative archive"));
  start(manager, parent, { task_summary: "Archived child" });
  result(manager, parent, { task_id: "st_child", status: "completed" });
  assert.ok(texts(manager.messages(ocIdFor("st_child"))).includes("authoritative archive"));
  assert.ok(!texts(manager.messages(ocIdFor("st_child"))).includes("stale live transcript"));
});

test("in-process child_session_id streams tools and archives without host_session", async (t) => {
  const { manager, parent, store, state, bus, directory } = setup(t);
  const child = liveRecord(store);
  const path = join(dirname(child.path), "2026-10-13T00-00-00-000Z_child-pi.jsonl");
  renameSync(child.path, path);
  // A different retained run must never be mistaken for the current session.
  put(join(dirname(path), "2026-10-14T00-00-00-000Z_other-pi.jsonl"), transcript("other run", "other-pi"));
  const data = {
    task_id: "st_child",
    parent_session_id: "parent-pi",
    status: "running",
    execution_mode: "in-process",
    child_session_id: "child-pi",
  };
  put(child.recordPath, data);
  start(manager, parent, { subagent_type: "explore", task_summary: "In-process child" });
  result(manager, parent, { task_id: "st_child", status: "running" }, "", false);
  const childID = ocIdFor("st_child");
  assert.equal(parts(manager.messages(childID)).filter((part) => part.tool === "read").length, 1);
  assert.equal(manager.get(childID)?.status.type, "busy");
  const streamed = eventWhen(
    bus,
    (event) =>
      event.type === "message.part.updated" &&
      event.properties.part.sessionID === childID &&
      event.properties.part.type === "text" &&
      event.properties.part.text === "IN_PROCESS_STREAM",
  );
  appendFileSync(
    path,
    `${JSON.stringify({
      type: "message",
      id: "live",
      parentId: "z",
      timestamp: 5,
      message: { role: "assistant", content: [{ type: "text", text: "IN_PROCESS_STREAM" }] },
    })}\n`,
  );
  await streamed;
  const idle = eventWhen(bus, (event) => event.type === "session.idle" && event.properties.sessionID === childID);
  put(`${child.recordPath}.tmp`, { ...data, status: "completed" });
  renameSync(`${child.recordPath}.tmp`, child.recordPath);
  await idle;
  assert.equal(readFileSync(join(state, "children", "st_child.jsonl"), "utf8"), readFileSync(path, "utf8"));
  await manager.disposeAll();
  rmSync(store, { recursive: true });
  const restarted = new SessionManager(() => {}, new SessionStore(state), directory);
  t.after(() => restarted.disposeAll());
  assert.equal(parts(restarted.messages(childID)).filter((part) => part.tool === "read").length, 1);
  assert.match(texts(restarted.messages(childID)), /IN_PROCESS_STREAM/);
});

test("in-process transcript discovery follows late child session publication", async (t) => {
  const { manager, parent, store, bus } = setup(t);
  const recordPath = join(store, "tasks", "st_child.json");
  const data = { task_id: "st_child", parent_session_id: "parent-pi", status: "running", execution_mode: "in-process" };
  put(recordPath, data);
  start(manager, parent, { subagent_type: "explore", task_summary: "Starting child" });
  result(manager, parent, { task_id: "st_child", status: "running" }, "", false);
  const childID = ocIdFor("st_child");
  const arrived = eventWhen(
    bus,
    (event) =>
      event.type === "message.part.updated" &&
      event.properties.part.sessionID === childID &&
      event.properties.part.type === "tool" &&
      event.properties.part.tool === "read",
  );
  put(
    join(store, "children", "st_child", "sessions", "st_child", "2026-10-13T00-00-00-000Z_child-pi.jsonl"),
    transcript("late session"),
  );
  put(`${recordPath}.tmp`, { ...data, child_session_id: "child-pi" });
  renameSync(`${recordPath}.tmp`, recordPath);
  await arrived;
  assert.equal(parts(manager.messages(childID)).filter((part) => part.tool === "read").length, 1);
});

test("live store history is archived even when no prior archive exists", (t) => {
  const { manager, parent, store, state } = setup(t);
  liveRecord(store, "st_child", "completed", "retained live history");
  start(manager, parent, { task_summary: "Stored child" });
  result(manager, parent, { task_id: "st_child", status: "completed" });
  assert.ok(texts(manager.messages(ocIdFor("st_child"))).includes("retained live history"));
  assert.ok(existsSync(join(state, "children", "st_child.jsonl")));
});

for (const status of ["error", "failed"]) {
  test(`missing transcript preserves ${status} details alongside a final response`, (t) => {
    const { manager, parent } = setup(t);
    const error = "open_failed: startup-sentinel";
    const response = status === "error" ? "" : "partial-result-sentinel";
    start(manager, parent, { task_summary: "Failed child", prompt: "child-request-sentinel" });
    result(manager, parent, { task_id: "st_failed", status, model: "anthropic/haiku", error_message: error }, response);

    const messages = manager.messages(ocIdFor("st_failed"));
    const request = messages?.find((message) => message.info.role === "user");
    const reply = messages?.find((message) => message.info.role === "assistant");
    assert.ok(reply?.info.role === "assistant");
    assert.equal(reply.info.parentID, request?.info.id);
    assert.equal(reply.info.finish, "error");
    assert.equal(reply.info.error?.data.message, error);
    assert.ok(texts(messages).includes(error));
    if (response) assert.ok(texts(messages).includes(response));
  });
}

test("failed fallback does not repeat an error already in its final response", (t) => {
  const { manager, parent } = setup(t);
  const error = "open_failed: duplicate-sentinel";
  start(manager, parent, { task_summary: "Failed child" });
  result(manager, parent, { task_id: "st_failed", status: "error", error_message: error }, error);
  assert.equal(texts(manager.messages(ocIdFor("st_failed"))).split(error).length - 1, 1);
});

test("saved startup failure survives restart through the message route without a transcript", async (t) => {
  const { manager, parent, store, directory } = setup(t);
  const error = "open_failed: persisted-sentinel";
  // DAG startup failures can have no task tool result, host_session, transcript or run_stats.
  // Observed in OmO's task_start_failed event for a failed open_session.
  put(join(store, "tasks", "st_failed.json"), {
    task_id: "st_failed",
    parent_session_id: "parent-pi",
    status: "error",
    error_message: error,
    failure_kind: "session_unavailable",
    failure_reason: "open_failed",
    model: "anthropic/haiku",
  });
  assert.equal(manager.get(ocIdFor("st_failed"))?.info.parentID, parent.info.id);
  await manager.disposeAll();
  const server = new AdapterServer({ port: 0, host: "127.0.0.1", defaultDirectory: directory });
  await server.start();
  t.after(() => server.stop());

  const response = await fetch(`${server.url}/session/${ocIdFor("st_failed")}/message`);
  assert.equal(response.status, 200);
  const messages = (await response.json()) as OCMessageWithParts[];
  const reply = messages.find((message) => message.info.role === "assistant");
  assert.ok(reply?.info.role === "assistant");
  assert.equal(reply.info.error?.data.message, error);
  assert.ok(texts(messages).includes(error));
});

test("missing transcript renders final response and recorded usage", (t) => {
  const { manager, parent } = setup(t);
  start(manager, parent, { task_summary: "Evicted child" });
  result(
    manager,
    parent,
    {
      task_id: "st_missing",
      status: "completed",
      model: "anthropic/haiku",
      run_stats: {
        runtime_ms: 123,
        total_tokens: 50,
        input_tokens: 30,
        output_tokens: 20,
        cost_usd: 0.01,
      },
    },
    "preserved result\n\n[task_id: st_missing - continue with task_send(...)]",
  );
  const messages = manager.messages(ocIdFor("st_missing"));
  assert.equal(messages?.filter((message) => message.info.role === "assistant").length, 1);
  assert.match(texts(messages), /preserved result/);
  const info = messages?.find((message) => message.info.role === "assistant")?.info;
  assert.ok(info?.role === "assistant");
  assert.equal(info.parentID, messages?.find((message) => message.info.role === "user")?.info.id);
  assert.equal(info.cost, 0.01);
  // The child carries its own spend; the parent's stays separate so OpenChamber's subtree sum counts it once.
  const child = manager.get(ocIdFor("st_missing"))?.info;
  assert.equal(child?.cost, 0.01);
  assert.equal(child?.parentID, parent.info.id);
  assert.equal(parent.info.cost, undefined);
  // Run totals are summed over every model call, not one context window, so
  // they must not drive OpenChamber's context fill (it showed 999%).
  assert.deepEqual(info.tokens, { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });
  assert.match(texts(messages), /Tokens: 50/);
  assert.equal(info.modelID, "haiku");
  assert.ok(!texts(messages).includes("[task_id:"));
});

test("nested background completion wake updates the parent card and archives the child", (t) => {
  const { manager, parent, store, state } = setup(t);
  liveRecord(store);
  start(manager, parent, { run_in_background: true, task_summary: "Background child" });
  result(manager, parent, { task_id: "st_child", status: "running" }, "Started");
  manager["onPiEvent"](parent, {
    type: "message_end",
    message: {
      role: "custom",
      customType: "omo-senpi:wake",
      details: [
        {
          customType: "senpi-task.completion",
          details: [{ task_id: "st_child", status: "completed", final_response: "wake result" }],
        },
      ],
    },
  });
  assert.equal(manager.get(ocIdFor("st_child"))?.status.type, "idle");
  assert.equal(parent.hasRunningChildren(), false);
  const card = parts(parent.messages)[0];
  assert.ok(card?.state.status === "completed");
  assert.equal(card.state.output, "wake result");
  assert.ok(existsSync(join(state, "children", "st_child.jsonl")));
});

test("partial lines and split UTF8 stream only after the terminating newline", async (t) => {
  const { manager, parent, store, bus } = setup(t);
  const child = liveRecord(store);
  start(manager, parent, { task_summary: "Tailed child" });
  result(manager, parent, { task_id: "st_child", status: "running" }, "", false);
  const entry = Buffer.from(
    `${JSON.stringify({
      type: "message",
      id: "new",
      parentId: "z",
      timestamp: 5,
      message: { role: "assistant", content: [{ type: "text", text: "new café result" }] },
    })}\n`,
  );
  const cut = entry.indexOf(Buffer.from("é")) + 1;
  appendFileSync(child.path, entry.subarray(0, cut));
  // The pure tail reader establishes the exact partial-byte state without timing luck.
  const tail = new JsonlTail();
  tail.read(child.path);
  assert.ok(!tail.text.includes('"id":"new"'));
  const arrived = eventWhen(
    bus,
    (event) =>
      event.type === "message.part.updated" &&
      event.properties.part.type === "text" &&
      event.properties.part.text === "new café result",
  );
  appendFileSync(child.path, entry.subarray(cut));
  await arrived;
  tail.read(child.path);
  assert.ok(tail.text.includes("new café result"));
  assert.ok(texts(manager.messages(ocIdFor("st_child"))).includes("new café result"));
});

test("corrupt registry and records are tolerated with project directory fallback", (t) => {
  const { agent, store } = setup(t);
  const child = liveRecord(store);
  put(join(agent, "rpc", "task-stores.json"), "{truncated");
  assert.equal(findTask("st_child", "parent-pi")?.path, child.recordPath);
  assert.equal(findTask("st_child", "different-parent"), undefined);
  put(child.recordPath, "{truncated");
  assert.equal(findTask("st_child", "parent-pi"), undefined);
  assert.equal(findTask("../../escape", "parent-pi"), undefined);
});

test("resumed running child supersedes stale archive and replaces it at terminal status", async (t) => {
  const { manager, parent, store, state, bus } = setup(t);
  put(join(state, "children", "st_child.jsonl"), transcript("old run"));
  const child = liveRecord(store, "st_child", "running", "resumed run");
  start(manager, parent, { task_summary: "Resumed child" });
  result(manager, parent, { task_id: "st_child", status: "running", run_epoch: 1 }, "", false);
  assert.ok(texts(manager.messages(ocIdFor("st_child"))).includes("resumed run"));
  const idle = eventWhen(bus, (event) => event.type === "session.idle");
  put(child.recordPath, { ...child.data, status: "completed", run_epoch: 1 });
  await idle;
  assert.ok(readFileSync(join(state, "children", "st_child.jsonl"), "utf8").includes("resumed run"));
});

test("a resident task OmO resumes after its turn settled shows busy again and archives the resumed run", async (t) => {
  const { manager, parent, store, state, bus } = setup(t);
  const child = liveRecord(store, "st_child", "running", "waiting on sleep");
  const resident = { ...child.data, residency_state: "resident" };
  put(child.recordPath, resident);
  start(manager, parent, { task_summary: "Resuming child" });
  result(manager, parent, { task_id: "st_child", status: "running" }, "", false);
  const childID = ocIdFor("st_child");
  const status = (type: string) =>
    eventWhen(
      bus,
      (event) =>
        event.type === "session.status" &&
        event.properties.sessionID === childID &&
        event.properties.status.type === type,
    );
  const settle = (data: Record<string, unknown>) => {
    put(`${child.recordPath}.tmp`, data);
    renameSync(`${child.recordPath}.tmp`, child.recordPath);
  };

  let idle = status("idle");
  settle({ ...resident, status: "completed", updated_at: new Date(Date.now() - 60_000).toISOString() });
  await idle;
  assert.equal(parent.hasRunningChildren(), false);

  const busy = status("busy");
  put(child.path, transcript("EVAL_BG_DONE"));
  settle({
    ...resident,
    status: "running",
    resumed_run_epoch: 1,
    updated_at: new Date(Date.now() + 1_000).toISOString(),
  });
  await busy;
  assert.equal(parent.hasRunningChildren(), true);

  idle = status("idle");
  settle({
    ...resident,
    status: "completed",
    resumed_run_epoch: 1,
    updated_at: new Date(Date.now() + 2_000).toISOString(),
  });
  await idle;
  assert.ok(texts(manager.messages(childID)).includes("EVAL_BG_DONE"));
  assert.ok(readFileSync(join(state, "children", "st_child.jsonl"), "utf8").includes("EVAL_BG_DONE"));

  const watched = manager.subagents["children"].get(childID);
  assert.equal(watched?.watchers.size, 1, "a resident finished task keeps its record watched");
  const closed = eventWhen(bus, () => watched?.watchers.size === 0);
  settle({ ...resident, status: "completed", residency_state: "rpc_detached" });
  await closed;
  assert.equal(watched?.watchers.size, 0, "leaving residency ends the watch");
});

// OmO's abort only cancels a task the turn is still waiting on; a background task keeps running
// (omo-task.js: a `run_in_background` spawn returns before the foreground wait that calls
// `cancelTask(..., "parent turn aborted")`).
test("aborting a parent leaves a background child running until OmO reports its end", async (t) => {
  const { manager, parent, store, bus } = setup(t);
  const child = liveRecord(store);
  put(child.recordPath, { ...child.data, updated_at: new Date(Date.now() - 60_000).toISOString() });
  start(manager, parent, { task_summary: "Background child", run_in_background: true });
  result(manager, parent, { task_id: "st_child", status: "running" }, "Started", true);
  await manager.abort(parent.info.id);
  const childID = ocIdFor("st_child");
  assert.equal(manager.get(childID)?.status.type, "busy");
  assert.equal(parent.hasRunningChildren(), true);
  assert.equal(parts(parent.messages)[0]?.state.status, "running");
  const idle = eventWhen(bus, (event) => event.type === "session.idle" && event.properties.sessionID === childID);
  put(child.recordPath, { ...child.data, status: "completed", updated_at: new Date().toISOString() });
  await idle;
  assert.equal(parts(parent.messages)[0]?.state.status, "completed");
});

test("a child an older adapter marked cancelled recovers from its running record after a restart", async (t) => {
  const { manager, parent, store, state, directory } = setup(t);
  const child = liveRecord(store);
  put(child.recordPath, { ...child.data, updated_at: new Date(Date.now() - 60_000).toISOString() });
  start(manager, parent, { task_summary: "Long child", run_in_background: true });
  result(manager, parent, { task_id: "st_child", status: "running" }, "Started", true);
  const childID = ocIdFor("st_child");
  // What antechamber <= 0.2.33 persisted after an abort: a synthesized cancel and no terminal time.
  const tracked = manager.subagents["children"].get(childID);
  assert.ok(tracked);
  tracked.task.details = { ...tracked.task.details, status: "cancelled" };
  manager.subagents.save(childID);
  // It also archived the transcript at that moment, newer than the record's spawn-time update.
  put(join(state, "children", "st_child.jsonl"), transcript("child result"));
  await manager.disposeAll();
  const restarted = new SessionManager(() => {}, new SessionStore(state), directory);
  t.after(() => restarted.disposeAll());
  assert.equal(restarted.get(childID)?.status.type, "busy");
});

test("omo.task.updated snapshots drive child status and ignore older updates", async (t) => {
  const { manager, parent, store } = setup(t);
  const child = liveRecord(store);
  const spawned = new Date(Date.now() - 60_000).toISOString();
  put(child.recordPath, { ...child.data, updated_at: spawned });
  start(manager, parent, { task_summary: "Snapshot child", run_in_background: true });
  result(manager, parent, { task_id: "st_child", status: "running" }, "Started", true);
  const childID = ocIdFor("st_child");
  const snapshot = (row: Record<string, unknown>) =>
    manager["onPiEvent"](parent, {
      type: "extension_event",
      name: "omo.task.updated",
      data: { parent_session_id: "parent-pi", tasks: [{ task_id: "st_child", ...row }] },
    });
  snapshot({ status: "completed", updated_at: new Date().toISOString(), final_response: "snapshot result" });
  assert.equal(manager.get(childID)?.status.type, "idle");
  assert.equal(parent.hasRunningChildren(), false);
  assert.equal(parts(parent.messages)[0]?.state.status, "completed");
  snapshot({ status: "running", updated_at: spawned });
  assert.equal(manager.get(childID)?.status.type, "idle", "an older snapshot cannot reopen the child");
  snapshot({ status: "running", updated_at: new Date(Date.now() + 1_000).toISOString() });
  assert.equal(manager.get(childID)?.status.type, "busy", "a newer run reopens it");
});

for (const global of [false, true]) {
  test(`cold ${global ? "global" : "project"} listing restores children without per-child registry rewrites`, async (t) => {
    const { manager, parent, store, directory, state } = setup(t);
    for (let index = 0; index < 4; index++) {
      const taskID = `st_cold_${index}`;
      liveRecord(store, taskID, "completed", `retained result ${index}`);
      start(manager, parent, { task_summary: `Child ${index}` }, `spawn-${index}`);
      result(manager, parent, { task_id: taskID, status: "completed" }, "done", true, `spawn-${index}`);
    }
    await manager.disposeAll();
    rmSync(store, { recursive: true });
    const registry = new SessionStore(state);
    const persist = t.mock.fn(registry["persist"].bind(registry));
    registry["persist"] = persist;
    const restarted = new SessionManager(() => {}, registry, directory);
    t.after(() => restarted.disposeAll());

    const listed = global ? restarted.listAll() : restarted.list(directory);
    const children = listed.filter((session) => session.parentID === parent.info.id);
    assert.equal(children.length, 4);
    assert.ok(persist.mock.callCount() <= 1, `listing rewrote the whole registry ${persist.mock.callCount()} times`);
    for (const child of children) {
      assert.match(texts(restarted.messages(child.id)), /retained result/);
      assert.equal(new SessionStore(state).get(child.id)?.parentID, parent.info.id);
    }
    assert.equal(restarted.liveSessions().length, 0);
  });
}

test("a failed restoration batch returns a persistence error instead of a successful list", async (t) => {
  const { manager, store, directory, state } = setup(t);
  liveRecord(store, "st_restore_failure", "completed");
  await manager.disposeAll();
  rmSync(state, { recursive: true, force: true });
  writeFileSync(state, "not a directory");
  const server = new AdapterServer({ port: 0, host: "127.0.0.1", defaultDirectory: directory });
  await server.start();
  t.after(() => server.stop());

  const response = await fetch(`${server.url}/experimental/session`);
  assert.equal(response.status, 500);
  const error = (await response.json()) as { name: string; data: { message: string } };
  assert.equal(error.name, "UnknownError");
  assert.match(error.data.message, /ENOTDIR/);
});

test("restart resolves archived children by id through real session and message routes", async (t) => {
  const { manager, parent, store, directory } = setup(t);
  const { path } = liveRecord(store, "st_child", "completed", "survives eviction");
  const rows = transcript("survives eviction")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  rows.at(-1).message.usage = { input: 11, output: 7, cost: { total: 2.5 } };
  put(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  start(manager, parent, { task_summary: "Archived child" });
  result(manager, parent, { task_id: "st_child", status: "completed" });
  await manager.disposeAll();
  rmSync(store, { recursive: true });
  const server = new AdapterServer({ port: 0, host: "127.0.0.1", defaultDirectory: directory });
  await server.start();
  t.after(() => server.stop());
  const childID = ocIdFor("st_child");
  const listed = (await fetch(`${server.url}/session?directory=${encodeURIComponent(directory)}`).then((response) =>
    response.json(),
  )) as Array<{ id: string; cost?: number; tokens?: { input: number; output: number } }>;
  const child = listed.find((session) => session.id === childID);
  assert.equal(child?.cost, 2.5, "the first list includes archived spend without opening child history");
  assert.equal(child.tokens?.input, 11);
  assert.equal(child.tokens?.output, 7);
  assert.equal(parent.info.cost ?? 0, 0, "child spend is not folded into its parent");
  const info = (await fetch(`${server.url}/session/${childID}`).then((response) => response.json())) as {
    parentID?: string;
    cost?: number;
  };
  assert.equal(info.parentID, parent.info.id);
  assert.equal(info.cost, 2.5);
  const history = (await fetch(`${server.url}/session/${childID}/message`).then((response) =>
    response.json(),
  )) as OCMessageWithParts[];
  assert.match(texts(history), /survives eviction/);
  const roots = (await fetch(`${server.url}/experimental/session?roots=true`).then((response) =>
    response.json(),
  )) as Array<{ id: string }>;
  const all = (await fetch(`${server.url}/experimental/session?roots=false`).then((response) =>
    response.json(),
  )) as Array<{ id: string; parentID?: string }>;
  assert.ok(!roots.some((session: { id: string }) => session.id === childID));
  assert.ok(
    all.some(
      (session: { id: string; parentID?: string }) => session.id === childID && session.parentID === parent.info.id,
    ),
  );
  const refreshed = (await fetch(`${server.url}/session/${childID}`).then((response) => response.json())) as {
    cost?: number;
  };
  assert.equal(refreshed.cost, 2.5, "history reads do not add the same spend again");
});

test("a child archived through the session route stays archived after a restart", async (t) => {
  const { manager, parent, store, directory } = setup(t);
  liveRecord(store, "st_child", "completed", "archived later");
  start(manager, parent, { task_summary: "Archived child" });
  result(manager, parent, { task_id: "st_child", status: "completed" });
  await manager.disposeAll();
  const childID = ocIdFor("st_child");
  const query = `directory=${encodeURIComponent(directory)}`;
  const first = new AdapterServer({ port: 0, host: "127.0.0.1", defaultDirectory: directory });
  await first.start();
  const patched = await fetch(`${first.url}/session/${childID}?${query}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ time: { archived: 1234 } }),
  });
  assert.equal(patched.status, 200);
  await first.stop();
  const second = new AdapterServer({ port: 0, host: "127.0.0.1", defaultDirectory: directory });
  await second.start();
  t.after(() => second.stop());
  const listed = (await fetch(`${second.url}/session?${query}`).then((response) => response.json())) as Array<{
    id: string;
    time: { archived?: number };
  }>;
  assert.equal(listed.find((session) => session.id === childID)?.time.archived, 1234);
  const active = (await fetch(`${second.url}/session?${query}&archived=false`).then((response) =>
    response.json(),
  )) as Array<{ id: string }>;
  assert.ok(!active.some((session) => session.id === childID));
});

test("task spawned without a task tool call resolves from its record under the parent", (t) => {
  const { manager, parent, store, state } = setup(t);
  liveRecord(store, "st_eval", "completed", "spawned from eval");
  put(join(store, "tasks", "st_orphan.json"), { task_id: "st_orphan", parent_session_id: "unknown-pi" });
  const childID = ocIdFor("st_eval");
  assert.equal(manager.get(childID)?.info.parentID, parent.info.id);
  assert.match(texts(manager.messages(childID)), /spawned from eval/);
  assert.equal(manager.get(ocIdFor("st_orphan")), undefined);
  assert.equal(new SessionStore(state).get(childID)?.task?.id, "st_eval");
});

test("task spawned without a task tool call is listed and announced before any direct lookup", (t) => {
  const { manager, parent, store, directory, events } = setup(t);
  liveRecord(store, "st_listed", "completed", "listed child");
  const listedID = ocIdFor("st_listed");
  assert.equal(manager.list(directory).find((session) => session.id === listedID)?.parentID, parent.info.id);
  liveRecord(store, "st_woken", "completed", "woken child");
  const wokenID = ocIdFor("st_woken");
  manager["onPiEvent"](parent, {
    type: "message_end",
    message: {
      role: "custom",
      customType: "omo-senpi:wake",
      details: [{ customType: "senpi-task.completion", details: [{ task_id: "st_woken", status: "completed" }] }],
    },
  });
  assert.ok(events.some((event) => event.type === "session.created" && event.properties.info.id === wokenID));
});

test("a running task spawned without a task tool call announces busy when the list adopts it", (t) => {
  const { manager, store, directory, events } = setup(t);
  liveRecord(store, "st_running", "running", "still working");
  const childID = ocIdFor("st_running");
  assert.ok(manager.list(directory).some((session) => session.id === childID));
  assert.deepEqual(manager.statuses()[childID], { type: "busy" });
  assert.ok(
    events.some(
      (event) =>
        event.type === "session.status" &&
        event.properties.sessionID === childID &&
        event.properties.status.type === "busy",
    ),
  );
});

test("after a restart a wake reaches a registry-only child and nested eval tasks find their parent", async (t) => {
  const { manager, store, state, directory } = setup(t);
  liveRecord(store, "st_outer", "running", "outer child");
  const outerID = ocIdFor("st_outer");
  assert.ok(manager.get(outerID));
  await manager.disposeAll();
  const events: OCEvent[] = [];
  const restarted = new SessionManager(
    (_directory, event) => events.push(structuredClone(event) as OCEvent),
    new SessionStore(state),
    directory,
  );
  t.after(() => restarted.disposeAll());
  const parent = restarted.get(ocIdFor("parent-pi"));
  assert.ok(parent);
  restarted["onPiEvent"](parent, {
    type: "message_end",
    message: {
      role: "custom",
      customType: "omo-senpi:wake",
      details: [{ customType: "senpi-task.completion", details: [{ task_id: "st_outer", status: "completed" }] }],
    },
  });
  assert.equal(restarted.subagents["children"].get(outerID)?.task.details.status, "completed");
  // The outer child's transcript header carries pi session id "child-pi".
  put(join(store, "tasks", "st_inner.json"), {
    task_id: "st_inner",
    parent_session_id: "child-pi",
    status: "completed",
  });
  assert.equal(restarted.list(directory).find((session) => session.id === ocIdFor("st_inner"))?.parentID, outerID);
});

test("a deleted child stays deleted after a parent history read and a restart", async (t) => {
  const { manager, parentPath, store, directory, parent } = setup(t);
  const batch = fixture.samples[1];
  appendFileSync(
    parentPath,
    `${[
      {
        type: "message",
        id: "a",
        parentId: null,
        timestamp: 1,
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "batch", name: "task", arguments: batch.arguments }],
        },
      },
      {
        type: "message",
        id: "r",
        parentId: "a",
        timestamp: 2,
        message: { role: "toolResult", toolName: "task", toolCallId: "batch", ...batch },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
  );
  liveRecord(store, "st_01a12ba2", "completed", "deleted child");
  await manager.disposeAll();
  const childID = ocIdFor("st_01a12ba2");
  const query = `directory=${encodeURIComponent(directory)}`;
  const ids = async (url: string) =>
    ((await fetch(`${url}/session?${query}`).then((response) => response.json())) as Array<{ id: string }>).map(
      (session) => session.id,
    );
  const first = new AdapterServer({ port: 0, host: "127.0.0.1", defaultDirectory: directory });
  await first.start();
  await fetch(`${first.url}/session/${parent.info.id}/message?${query}`).then((response) => response.json());
  assert.ok((await ids(first.url)).includes(childID));
  const deleted = await fetch(`${first.url}/session/${childID}?${query}`, { method: "DELETE" });
  assert.equal(deleted.status, 200);
  await fetch(`${first.url}/session/${parent.info.id}/message?${query}`).then((response) => response.json());
  assert.ok(!(await ids(first.url)).includes(childID));
  await first.stop();
  const second = new AdapterServer({ port: 0, host: "127.0.0.1", defaultDirectory: directory });
  await second.start();
  t.after(() => second.stop());
  await fetch(`${second.url}/session/${parent.info.id}/message?${query}`).then((response) => response.json());
  assert.ok(!(await ids(second.url)).includes(childID));
  assert.equal((await fetch(`${second.url}/session/${childID}?${query}`)).status, 404);
});

test("dormant parent rebuilds batch children and applies trailing wake results", (t) => {
  const { manager, parent, parentPath } = setup(t);
  const batch = fixture.samples[1];
  appendFileSync(
    parentPath,
    `${[
      {
        type: "message",
        id: "a",
        parentId: null,
        timestamp: 1,
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "batch", name: "task", arguments: batch.arguments }],
        },
      },
      {
        type: "message",
        id: "r",
        parentId: "a",
        timestamp: 2,
        message: { role: "toolResult", toolName: "task", toolCallId: "batch", ...batch },
      },
      {
        type: "custom_message",
        id: "wake",
        parentId: "r",
        timestamp: 3,
        customType: "omo-senpi:wake",
        details: [
          {
            customType: "senpi-task.completion",
            details: [
              {
                task_id: "st_01a12ba2",
                status: "completed",
                final_response: "historical final response",
                run_stats: { runtime_ms: 17 },
              },
            ],
          },
        ],
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
  );
  parent.messages = undefined;
  const cards = parts(manager.messages(parent.info.id));
  assert.equal(cards.length, 4);
  assert.equal(cards[0]?.state.status, "completed");
  assert.ok(texts(manager.messages(ocIdFor("st_01a12ba2"))).includes("historical final response"));
});

test("task suffix removal preserves ordinary output and strips each batch continuation", () => {
  assert.equal(stripTaskSuffix("answer\n\n[task_id: st_one - continue with task_send(...)]"), "answer");
  assert.equal(stripTaskSuffix("first [task_id: st_one]\nsecond [task_id: st_two]"), "first\nsecond");
  assert.equal(stripTaskSuffix("task_id: inside ordinary prose"), "task_id: inside ordinary prose");
});

test("restored child message and part identifiers cannot collide across sessions", (t) => {
  const { manager, parent, store } = setup(t);
  for (const id of ["st_first", "st_second"]) {
    liveRecord(store, id, "completed", id);
    start(manager, parent, { task_summary: id }, id);
    result(manager, parent, { task_id: id, status: "completed" }, id, true, id);
  }
  const ids = (task: string) =>
    manager.messages(ocIdFor(task))?.flatMap((message) => [message.info.id, ...message.parts.map((part) => part.id)]) ??
    [];
  const first = new Set(ids("st_first"));
  assert.ok(ids("st_second").every((id) => !first.has(id)));
});

test("an older running record cannot resurrect an archived terminal child", (t) => {
  const { manager, parent, store, state } = setup(t);
  const child = liveRecord(store, "st_child", "running", "stale running result");
  put(child.recordPath, { ...child.data, updated_at: "2020-01-01T00:00:00.000Z" });
  put(join(state, "children", "st_child.jsonl"), transcript("archived terminal result"));
  start(manager, parent, { task_summary: "Archived child" });
  result(manager, parent, { task_id: "st_child", status: "completed" });
  assert.equal(manager.get(ocIdFor("st_child"))?.status.type, "idle");
  assert.equal(parent.hasRunningChildren(), false);
  assert.ok(texts(manager.messages(ocIdFor("st_child"))).includes("archived terminal result"));
});

test("abort before the task id arrives ends the card and allows a fresh run", async (t) => {
  const { manager, parent, store } = setup(t);
  start(manager, parent, { task_summary: "Not yet spawned" });
  await manager.abort(parent.info.id);
  assert.equal(parts(parent.messages)[0]?.state.status, "error");
  const child = liveRecord(store);
  start(manager, parent, { task_summary: "Resumed parent task" }, "resumed");
  result(manager, parent, { task_id: "st_child", status: "running" }, "", false, "resumed");
  assert.equal(parent.hasRunningChildren(), true);
  await manager.abort(parent.info.id);
  // The foreground wait is OmO's to cancel; the card follows its report.
  assert.equal(parent.hasRunningChildren(), true);
  put(child.recordPath, { ...child.data, status: "cancelled" });
  result(manager, parent, { task_id: "st_child", status: "cancelled" }, "parent turn aborted", true, "resumed");
  assert.equal(parent.hasRunningChildren(), false);
  assert.ok(parts(parent.messages).every((part) => part.state.status === "error"));
});

test("cancellation ends every unlinked batch card after partial progress", async (t) => {
  const { manager, parent } = setup(t);
  start(manager, parent, { category: "quick", tasks: [{ task_summary: "First" }, { task_summary: "Second" }] });
  result(manager, parent, { items: [{ status: "running" }, { status: "running" }] }, "", false);
  await manager.abort(parent.info.id);
  assert.deepEqual(
    parts(parent.messages).map((part) => part.state.status),
    ["error", "error"],
  );
});

test("agent end finalizes resultless task calls but leaves running background children protected", (t) => {
  const { manager, parent, store } = setup(t);
  start(manager, parent, { task_summary: "Resultless" });
  manager["onPiEvent"](parent, { type: "agent_end" });
  assert.equal(parts(parent.messages)[0]?.state.status, "error");
  liveRecord(store);
  start(manager, parent, { task_summary: "Background", run_in_background: true }, "background");
  result(manager, parent, { task_id: "st_child", status: "running" }, "Started", true, "background");
  manager["onPiEvent"](parent, { type: "agent_end" });
  assert.equal(parent.hasRunningChildren(), true);
  assert.equal(manager.get(ocIdFor("st_child"))?.status.type, "busy");
});

test("persisted completion without an archive survives an older running record after restart", async (t) => {
  const { manager, parent, store, state, directory } = setup(t);
  put(join(store, "tasks", "st_child.json"), {
    task_id: "st_child",
    parent_session_id: "parent-pi",
    status: "running",
    updated_at: "2020-01-01T00:00:00.000Z",
  });
  start(manager, parent, { task_summary: "Evicted background" });
  result(manager, parent, { task_id: "st_child", status: "running" });
  manager["onPiEvent"](parent, {
    type: "custom_message",
    customType: "omo-senpi:wake",
    details: [{ task_id: "st_child", status: "completed", final_response: "retained completion" }],
  });
  await manager.disposeAll();
  const restarted = new SessionManager(() => {}, new SessionStore(state), directory);
  t.after(() => restarted.disposeAll());
  assert.match(texts(restarted.messages(ocIdFor("st_child"))), /retained completion/);
  assert.equal(restarted.get(ocIdFor("st_child"))?.status.type, "idle");
  assert.ok(!existsSync(join(state, "children", "st_child.jsonl")));
});

test("removing a child closes its own watchers and cannot restore the deleted view", async (t) => {
  const { manager, parent, store } = setup(t);
  liveRecord(store);
  start(manager, parent, { task_summary: "Removed child" });
  result(manager, parent, { task_id: "st_child", status: "running" }, "", false);
  const childID = ocIdFor("st_child");
  const tracked = manager.subagents["children"].get(childID);
  assert.ok(tracked && tracked.watchers.size > 0);
  assert.equal(await manager.remove(childID), true);
  assert.equal(tracked.watchers.size, 0);
  assert.equal(manager.get(childID), undefined);
});

test("a task OmO reports over RPC stays running through a real abort of its parent", async (t) => {
  const h = bugHarness(t);
  const info = await h.manager.create(h.root);
  const parent = h.manager.get(info.id);
  assert.ok(parent?.pi && parent.piSessionId);
  const store = join(h.root, "agent", "projects", "work-hash", "senpi-task");
  const path = join(store, "children", "st_live", "sessions", "st_live", "child.jsonl");
  put(path, transcript("live child"));
  const spawned = new Date(Date.now() - 60_000).toISOString();
  const row = { task_id: "st_live", status: "running", residency_state: "resident", updated_at: spawned };
  put(join(store, "tasks", "st_live.json"), {
    ...row,
    parent_session_id: parent.piSessionId,
    task_summary: "Live child",
    host_session: { session_path: path },
  });
  const snapshot = async (tasks: Record<string, unknown>[]) => {
    assert.ok(parent.pi);
    // The fake agent writes the frame before its reply, so the event is handled once this resolves.
    const frame = {
      type: "extension_event",
      name: "omo.task.updated",
      data: { parent_session_id: parent.piSessionId, tasks },
    };
    assert.equal((await parent.pi.command({ type: "emit", frame })).success, true);
  };
  await snapshot([row]);
  const childID = ocIdFor("st_live");
  assert.equal(h.manager.get(childID)?.info.parentID, info.id);
  assert.equal(h.manager.statuses()[childID]?.type, "busy");
  await h.manager.abort(info.id);
  assert.equal(h.manager.statuses()[childID]?.type, "busy", "an abort does not end a background task");
  await snapshot([{ ...row, status: "completed", updated_at: new Date().toISOString(), final_response: "done" }]);
  assert.equal(h.manager.statuses()[childID]?.type, "idle");
});

function taskHarness(t: TestContext) {
  const h = bugHarness(t);
  const store = join(h.root, "agent", "projects", "work-hash", "senpi-task");
  const task = (parentPi: string, id: string, extra: Record<string, unknown> = {}) => {
    const path = join(store, "children", id, "sessions", id, "child.jsonl");
    put(path, transcript(`${id} transcript`));
    const data = {
      task_id: id,
      status: "running",
      residency_state: "resident",
      updated_at: new Date(Date.now() - 60_000).toISOString(),
      parent_session_id: parentPi,
      task_summary: id,
      host_session: { session_path: path },
      ...extra,
    };
    put(join(store, "tasks", `${id}.json`), data);
    return { recordPath: join(store, "tasks", `${id}.json`), data };
  };
  const snapshot = async (parent: ManagedSession, tasks: Record<string, unknown>[]) => {
    assert.ok(parent.pi);
    const frame = {
      type: "extension_event",
      name: "omo.task.updated",
      data: { parent_session_id: parent.piSessionId, tasks },
    };
    // The fake agent writes the frame before its reply, so the event is handled once this resolves.
    assert.equal((await parent.pi.command({ type: "emit", frame })).success, true);
  };
  return { h, task, snapshot };
}

test("a repeated omo.task.updated row only changing live progress emits and saves nothing", async (t) => {
  const { h, task, snapshot } = taskHarness(t);
  const info = await h.manager.create(h.root);
  const parent = h.manager.get(info.id);
  assert.ok(parent?.piSessionId);
  const { data } = task(parent.piSessionId, "st_quiet");
  const row = { task_id: "st_quiet", status: "running", residency_state: "resident", updated_at: data.updated_at };
  await snapshot(parent, [{ ...row, live_progress: { tool_calls: 1 } }]);
  assert.equal(h.manager.statuses()[ocIdFor("st_quiet")]?.type, "busy");
  const store = h.manager.subagents["store"];
  const set = store.set.bind(store);
  let saves = 0;
  store.set = (...args: Parameters<typeof set>) => {
    saves++;
    return set(...args);
  };
  const before = h.events.length;
  await snapshot(parent, [{ ...row, live_progress: { tool_calls: 2 } }]);
  assert.equal(h.events.length, before, "an unchanged task publishes nothing");
  assert.equal(saves, 0, "an unchanged task does not rewrite the registry");
  assert.equal(h.manager.subagents["children"].get(ocIdFor("st_quiet"))?.task.details.live_progress, undefined);
});

test("a final response OmO truncated in a snapshot does not replace the full one", async (t) => {
  const { h, task, snapshot } = taskHarness(t);
  const info = await h.manager.create(h.root);
  const parent = h.manager.get(info.id);
  assert.ok(parent?.piSessionId);
  const full = "x".repeat(40_000);
  const ended = new Date().toISOString();
  task(parent.piSessionId, "st_long", { status: "completed", updated_at: ended, final_response: full });
  await snapshot(parent, [
    {
      task_id: "st_long",
      status: "completed",
      updated_at: ended,
      final_response: full.slice(0, 32_000),
      final_response_truncated: true,
    },
  ]);
  const child = h.manager.subagents["children"].get(ocIdFor("st_long"));
  assert.equal(child?.task.details.final_response, full);
});

// On parent shutdown OmO detaches shared-host workers, which keep running, and stops in-process
// ones, whose record stays `running` but `persisted_only` (omo-task.js `DK`/`jK`).
test("after the parent agent exits, shared-host children stay running and stopped in-process ones go idle", async (t) => {
  const { h, task, snapshot } = taskHarness(t);
  const info = await h.manager.create(h.root);
  const parent = h.manager.get(info.id);
  assert.ok(parent?.pi && parent.piSessionId);
  task(parent.piSessionId, "st_hosted");
  const local = task(parent.piSessionId, "st_local");
  const row = (id: string) => ({
    task_id: id,
    status: "running",
    residency_state: "resident",
    updated_at: local.data.updated_at,
  });
  await snapshot(parent, [row("st_hosted"), row("st_local")]);
  const pid = parent.pi.pid;
  assert.ok(pid);
  const exited = new Promise<void>((resolveExit) => parent.pi?.onExit(() => resolveExit()));
  process.kill(-pid, "SIGKILL");
  await exited;
  assert.equal(h.manager.statuses()[ocIdFor("st_hosted")]?.type, "busy");
  assert.equal(h.manager.statuses()[ocIdFor("st_local")]?.type, "busy");
  const idle = h.wait((e) => e.type === "session.idle" && e.properties.sessionID === ocIdFor("st_local"));
  put(`${local.recordPath}.tmp`, {
    ...local.data,
    residency_state: "persisted_only",
    updated_at: new Date().toISOString(),
  });
  renameSync(`${local.recordPath}.tmp`, local.recordPath);
  await idle;
  assert.equal(h.manager.statuses()[ocIdFor("st_hosted")]?.type, "busy");
  assert.equal(parent.hasRunningChildren(), true);
});
