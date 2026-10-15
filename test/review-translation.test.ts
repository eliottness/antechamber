import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { SessionManager, type ManagedSession } from "../src/sessions.js";
import { SessionStore } from "../src/session-store.js";
import { AdapterServer } from "../src/server.js";
import { flattenTodos, type TodoUpdated } from "../src/todo-bridge.js";
import type { OCEvent } from "../src/types.js";
import { V2EventTranslator } from "../src/v2.js";
import { bugHarness, openEvents } from "./bug-harness.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

test("R-006: provider errors produce failed v2 terminal frames", () => {
  const translator = new V2EventTranslator();
  const directory = "/tmp/antechamber-review-v2";
  const message = {
    id: "msg_provider_error",
    sessionID: "ses_provider_error",
    role: "assistant",
    time: { created: 1, completed: 2 },
    modelID: "model",
    providerID: "provider",
    mode: "build",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "error",
  };

  const frames = [
    ...translator.translate(directory, {
      type: "message.updated",
      properties: { info: message },
    } as unknown as OCEvent),
    ...translator.translate(directory, {
      type: "session.idle",
      properties: { sessionID: "ses_provider_error" },
    } as unknown as OCEvent),
  ];

  assert.ok(frames.some((frame) => frame.type === "session.step.failed"));
  assert.ok(frames.some((frame) => frame.type === "session.execution.failed"));
  assert.ok(!frames.some((frame) => frame.type === "session.execution.succeeded"));
});

test("R-007: restored parts preserve live identities after restart", { timeout: 20_000 }, async (t: TestContext) => {
  const harness = bugHarness(t);
  const session = await harness.manager.create(harness.root);

  await harness.manager.prompt(session.id, "restart identity", undefined, false, "msg_r007_optimistic");
  const live = harness.manager.messages(session.id);
  if (live === undefined) throw new TypeError("live session returned no messages");
  const livePartIDs = new Map(live.map((message) => [message.info.id, message.parts.map((part) => part.id)]));

  await harness.restart();

  const restored = harness.manager.messages(session.id);
  if (restored === undefined) throw new TypeError("restored session returned no messages");
  const restoredPartIDs = new Map(restored.map((message) => [message.info.id, message.parts.map((part) => part.id)]));
  assert.deepEqual(restoredPartIDs, livePartIDs);
});

test("R-011: first optimistic prompt reconciles to one visible user message", {
  timeout: 20_000,
}, async (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), "antechamber-r011-"));
  const previousBinary = process.env.ANTECHAMBER_PI_BINARY;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousState = process.env.ANTECHAMBER_STATE_DIR;
  process.env.ANTECHAMBER_PI_BINARY = resolve("test/fixtures/turn-omo.mjs");
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.ANTECHAMBER_STATE_DIR = join(root, "state");
  const server = new AdapterServer({ host: "127.0.0.1", port: 0, defaultDirectory: root });
  t.after(async () => {
    await server.stop();
    if (previousBinary === undefined) delete process.env.ANTECHAMBER_PI_BINARY;
    else process.env.ANTECHAMBER_PI_BINARY = previousBinary;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousState === undefined) delete process.env.ANTECHAMBER_STATE_DIR;
    else process.env.ANTECHAMBER_STATE_DIR = previousState;
    rmSync(root, { recursive: true, force: true });
  });
  await server.start();
  const sessionEvents = await openEvents(`${server.url}/event`);
  const globalEvents = await openEvents(`${server.url}/global/event`);
  t.after(async () => {
    await sessionEvents.close();
    await globalEvents.close();
  });

  const create = await fetch(`${server.url}/session`, { method: "POST", body: "{}" });
  assert.equal(create.status, 200);
  const created: unknown = await create.json();
  if (!isRecord(created) || typeof created.id !== "string") throw new TypeError("create response omitted session id");
  const sessionID = created.id;
  const messageID = "msg_r011_optimistic";
  const text = "first visible prompt";

  const sessionUser = sessionEvents.wait(
    (event) =>
      event.type === "message.updated" &&
      isRecord(event.properties) &&
      isRecord(event.properties.info) &&
      event.properties.info.role === "user" &&
      event.properties.info.id === messageID,
  );
  const globalUser = globalEvents.wait(
    (frame) =>
      isRecord(frame.payload) &&
      frame.payload.type === "message.updated" &&
      isRecord(frame.payload.properties) &&
      isRecord(frame.payload.properties.info) &&
      frame.payload.properties.info.role === "user" &&
      frame.payload.properties.info.id === messageID,
  );
  const echoedPart = sessionEvents.wait(
    (event) =>
      event.type === "message.part.updated" &&
      isRecord(event.properties) &&
      isRecord(event.properties.part) &&
      event.properties.part.messageID === messageID &&
      event.properties.part.type === "text",
  );
  const idle = sessionEvents.wait(
    (event) => event.type === "session.idle" && isRecord(event.properties) && event.properties.sessionID === sessionID,
  );

  const prompt = await fetch(`${server.url}/session/${sessionID}/prompt_async`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messageID, parts: [{ type: "text", text }] }),
  });
  assert.equal(prompt.status, 204);
  const [, , partEvent] = await Promise.all([sessionUser, globalUser, echoedPart, idle]);
  const eventProperties = partEvent.properties;
  if (!isRecord(eventProperties) || !isRecord(eventProperties.part)) {
    throw new TypeError("server did not publish an identifiable text part");
  }
  const echoed = eventProperties.part;
  if (typeof echoed.id !== "string" || typeof echoed.sessionID !== "string") {
    throw new TypeError("server did not publish an identifiable text part");
  }

  const history = await fetch(`${server.url}/session/${sessionID}/message`);
  assert.equal(history.status, 200);
  const messages: unknown = await history.json();
  if (!Array.isArray(messages)) throw new TypeError("history response was not an array");
  const userIDs = messages.flatMap((message) => {
    if (
      !isRecord(message) ||
      !isRecord(message.info) ||
      message.info.role !== "user" ||
      typeof message.info.id !== "string"
    )
      return [];
    return [message.info.id];
  });
  assert.deepEqual(userIDs, [messageID]);

  const optimisticParts: Array<{ id: string; messageID: string; type: string; text: string; sessionID?: string }> = [
    { id: "prt_r011_optimistic", messageID, type: "text", text },
  ];
  const optimisticIndex = optimisticParts.findIndex(
    (part) => part.type === echoed.type && part.sessionID === undefined,
  );
  assert.notEqual(optimisticIndex, -1);
  optimisticParts[optimisticIndex] = { id: echoed.id, messageID, type: "text", text, sessionID: echoed.sessionID };
  assert.deepEqual(
    optimisticParts.map((part) => part.id),
    [echoed.id],
  );
});

test("R-021: selected history hydrates todos only from its ancestor chain", {
  timeout: 20_000,
}, async (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), "antechamber-r021-"));
  const piPath = join(root, "branched-todos.jsonl");
  const selectedState = {
    phases: [{ name: "Selected", tasks: [{ content: "keep branch A", status: "in_progress" }] }],
  };
  const siblingState = {
    phases: [{ name: "Sibling", tasks: [{ content: "hide branch B", status: "completed" }] }],
  };
  writeFileSync(
    piPath,
    [
      { type: "session", id: "pi_r021", cwd: root, timestamp: 0 },
      {
        type: "message",
        id: "entry_user",
        parentId: null,
        timestamp: 1,
        message: { role: "user", content: [{ type: "text", text: "start" }] },
      },
      {
        type: "message",
        id: "entry_assistant_a",
        parentId: "entry_user",
        timestamp: 2,
        message: { role: "assistant", content: [{ type: "text", text: "branch A" }] },
      },
      {
        type: "custom",
        id: "entry_todo_a",
        parentId: "entry_assistant_a",
        timestamp: 3,
        customType: "senpi.todo-state",
        data: selectedState,
      },
      {
        type: "message",
        id: "entry_assistant_b",
        parentId: "entry_user",
        timestamp: 4,
        message: { role: "assistant", content: [{ type: "text", text: "branch B" }] },
      },
      {
        type: "custom",
        id: "entry_todo_b",
        parentId: "entry_assistant_b",
        timestamp: 5,
        customType: "senpi.todo-state",
        data: siblingState,
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n"),
  );
  const session: ManagedSession = {
    info: {
      id: "ses_r021",
      projectID: root,
      directory: root,
      title: "Branching todos",
      version: "test",
      time: { created: 0, updated: 0 },
    },
    pi: undefined,
    messages: undefined,
    status: { type: "idle" },
    model: undefined,
    streaming: undefined,
    toolByCallId: new Map(),
    tree: { messageEntries: {}, leafId: "entry_todo_a" },
    piPath,
    hasPendingInteraction: () => false,
    hasRunningChildren: () => false,
  };
  const events: Array<OCEvent | TodoUpdated> = [];
  const manager = new SessionManager(
    (_directory, event) => events.push(event),
    new SessionStore(join(root, "state", "sessions.json")),
  );
  t.after(async () => {
    await manager.disposeAll();
    rmSync(root, { recursive: true, force: true });
  });
  t.mock.method(manager, "get", (sessionID: string) => (sessionID === session.info.id ? session : undefined));

  const visible = manager.messages(session.info.id);
  assert.deepEqual(
    visible?.map((message) =>
      message.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(""),
    ),
    ["start", "branch A"],
  );
  const update = events.findLast((event): event is TodoUpdated => event.type === "todo.updated");
  if (update === undefined) throw new TypeError("history hydration did not publish todo.updated");
  const expected = flattenTodos(session.info.id, selectedState);
  assert.deepEqual(
    { route: manager.todos(session.info.id), event: update.properties.todos },
    { route: expected, event: expected },
  );
});
