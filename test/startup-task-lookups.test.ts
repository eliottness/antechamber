import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { ocIdFor, SessionStore } from "../src/session-store.js";
import type { ManagedSession } from "../src/sessions.js";
import { evalAgentSession, findTask, findTaskBySession, SubagentBridge, taskSessionId } from "../src/subagents.js";
import type { OCMessageWithParts, OCToolPart } from "../src/types.js";

function put(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}

function setup(t: TestContext, parse: (session: ManagedSession) => OCMessageWithParts[] = () => []) {
  const dir = mkdtempSync(join(tmpdir(), "antechamber-startup-lookups-"));
  const agent = join(dir, "agent");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  const store = new SessionStore(join(dir, "state"));
  const sessions = new Map<string, ManagedSession>();
  const bridge = new SubagentBridge(store, sessions, () => {}, parse);
  const parent = bridge["managedSession"]({
    id: ocIdFor("parent"),
    projectID: dir,
    directory: dir,
    title: "parent",
    version: "test",
    time: { created: 1, updated: 1 },
  });
  parent.piSessionId = "parent";
  sessions.set(parent.info.id, parent);
  const tasks = join(agent, "projects", "project", "senpi-task", "tasks");
  mkdirSync(tasks, { recursive: true });
  t.after(() => {
    bridge.dispose();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  function task(id: string, parentId = "parent", root = tasks) {
    const data = {
      task_id: id,
      parent_session_id: parentId,
      status: "completed",
      created_at: "2026-10-12T00:00:00.000Z",
      spawn_spec: { prompt: id },
    };
    put(join(root, `${id}.json`), data);
    return data;
  }
  return { agent, bridge, store, sessions, parent, tasks, task };
}

test("restoration shares task reads and identity enumeration across nested discovery and eval lookups", (t) => {
  const context = setup(t, (session) => {
    evalAgentSession("parent", { prompt: "st_0" }, new Set(), Date.parse("2026-10-12"));
    context.bridge.discover(session, []);
    return [];
  });
  for (let index = 0; index < 8; index++) context.task(`st_${index}`);
  const reads = t.mock.method(fs, "readFileSync");
  const scans = t.mock.method(fs, "readdirSync");
  const identities = t.mock.method(context.store, "childIds");
  syncBuiltinESMExports();

  context.store.batch(() => context.bridge.restoreAll());

  assert.equal(context.sessions.size, 9);
  const taskReads = reads.mock.calls.filter((call) => String(call.arguments[0]).startsWith(context.tasks));
  assert.equal(taskReads.length, 8, "each task record is read once in the synchronous restoration pass");
  assert.equal(
    scans.mock.calls.filter((call) => String(call.arguments[0]) === context.tasks).length,
    1,
    "the task directory is enumerated once",
  );
  assert.equal(identities.mock.callCount(), 1, "child identity enumeration is shared by nested discovery");
});

test("discovery shares task lookups and registers new identities within its pass", (t) => {
  const { bridge, store, parent, tasks, task } = setup(t);
  const data = task("st_card");
  const part: OCToolPart = {
    id: "prt_card",
    sessionID: parent.info.id,
    messageID: "msg_card",
    type: "tool",
    callID: "card",
    tool: "task",
    state: {
      status: "completed",
      input: {},
      title: "card",
      output: "",
      metadata: { taskID: "st_card", task: data },
      time: { start: 1, end: 2 },
    },
  };
  const reads = t.mock.method(fs, "readFileSync");
  const identities = t.mock.method(store, "childIds");
  syncBuiltinESMExports();

  bridge.discover(parent, [
    {
      info: {
        id: "msg_card",
        sessionID: parent.info.id,
        role: "user",
        time: { created: 1 },
        agent: "test",
        model: { providerID: "test", modelID: "test" },
      },
      parts: [part, { ...part, id: "prt_again" }],
    },
  ]);

  assert.equal(bridge["children"].size, 1);
  assert.equal(taskSessionId("st_card", "parent", store), ocIdFor("st_card"));
  assert.equal(reads.mock.calls.filter((call) => String(call.arguments[0]) === join(tasks, "st_card.json")).length, 1);
  assert.equal(identities.mock.callCount(), 2, "one pass scan plus the standalone identity lookup");
});

test("later passes and standalone helpers see late repaired and externally rewritten records", (t) => {
  const { bridge, store, tasks, task, sessions } = setup(t);
  put(join(tasks, "st_repaired.json"), "{");
  bridge.restoreAll();
  task("st_repaired");
  task("st_late");
  bridge.restoreAll();
  assert.equal(sessions.size, 3);
  put(join(tasks, "st_late.json"), { ...task("st_late"), final_response: "external" });
  assert.equal(findTask("st_late", "parent")?.data.final_response, "external");
  assert.equal(findTaskBySession(taskSessionId("st_late", "parent", store), store)?.data.final_response, "external");
  rmSync(join(tasks, "st_late.json"));
  assert.equal(findTask("st_late", "parent"), undefined);
});

test("a throwing nested restoration releases lookups before the next request", (t) => {
  const failure = new Error("parse failed");
  let fail = true;
  const { bridge, tasks, task } = setup(t, () => {
    if (fail) throw failure;
    return [];
  });
  task("st_first");
  assert.throws(() => bridge.restoreAll(), failure);
  fail = false;
  task("st_second");
  put(join(tasks, "st_first.json"), { ...task("st_first"), final_response: "rewritten" });
  bridge.restoreAll();
  assert.equal(findTask("st_first", "parent")?.data.final_response, "rewritten");
  assert.ok(bridge.owns(ocIdFor("st_second")));
});

test("nested restoration adds a newly registered bookmark to the active identity index", (t) => {
  let nested = false;
  const bookmark = ocIdFor("bookmark");
  const context = setup(t, () => {
    if (nested) return [];
    nested = true;
    context.store.set(bookmark, {
      piSessionId: "bookmarked-child",
      piPath: "",
      directory: context.parent.info.directory,
      parentID: context.parent.info.id,
      created: 1,
      updated: 1,
      task: { id: "st_bookmarked", parentPiId: "parent", input: {}, details: {} },
    });
    context.bridge.restore(bookmark);
    assert.equal(taskSessionId("st_bookmarked", "parent", context.store), bookmark);
    assert.equal(
      evalAgentSession("parent", { prompt: "st_bookmarked" }, new Set(), Date.parse("2026-10-12"))?.sessionID,
      bookmark,
    );
    return [];
  });
  context.task("st_0trigger");
  context.task("st_bookmarked");

  context.bridge.restore(ocIdFor("st_0trigger"));

  assert.ok(context.bridge.owns(bookmark));
  assert.equal(context.bridge.owns(ocIdFor("st_bookmarked")), false);
});

test("collisions retain legacy bookmarks and tombstones during restoration", (t) => {
  const { bridge, store, tasks, task, parent } = setup(t);
  const first = task("st_shared");
  task("st_shared", "other", join(dirname(dirname(dirname(tasks))), "other", "senpi-task", "tasks"));
  const legacy = ocIdFor("st_shared");
  store.set(legacy, {
    piSessionId: "first-child",
    piPath: "",
    directory: parent.info.directory,
    parentID: parent.info.id,
    created: 1,
    updated: 1,
    deleted: true,
    task: { id: "st_shared", parentPiId: "parent", input: {}, details: first },
  });

  bridge.restoreAll();

  assert.equal(taskSessionId("st_shared", "parent", store), legacy);
  assert.equal(taskSessionId("st_shared", "other", store), ocIdFor("other:st_shared"));
  assert.equal(bridge.owns(legacy), false);
  assert.equal(findTaskBySession(legacy, store)?.data.parent_session_id, "parent");
});
