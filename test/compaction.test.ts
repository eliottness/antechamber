import assert from "node:assert/strict";
import test from "node:test";
import { compactSession } from "../src/session-commands.js";
import { getEntries } from "../src/session-tree.js";
import { toV2Message } from "../src/v2.js";
import { bugHarness } from "./bug-harness.js";

test("manual compaction shows progress and its summary live and after restart", { timeout: 15000 }, async (t) => {
  const h = bugHarness(t);
  const session = await h.manager.create(h.root);
  await h.manager.prompt(session.id, "normal");
  const from = h.events.length;

  assert.deepEqual(await compactSession(h.manager, session.id), { kind: "compacted" });

  const events = h.events.slice(from);
  const statuses = events.flatMap((e) =>
    e.type === "session.status" && e.properties.sessionID === session.id ? [e.properties.status.type] : [],
  );
  assert.deepEqual(statuses, ["busy", "idle"]);
  const compacting = events.flatMap((e) =>
    e.type === "session.updated" && e.properties.info.id === session.id ? [e.properties.info.time.compacting] : [],
  );
  assert.ok(typeof compacting[0] === "number");
  assert.equal(compacting.at(-1), undefined);

  const live = h.manager.messages(session.id) ?? [];
  const [user, summary] = live.slice(-2);
  assert.ok(user?.info.role === "user" && user.parts[0]?.type === "compaction");
  assert.ok(summary?.info.role === "assistant" && summary.info.summary === true);
  assert.equal(summary.info.parentID, user.info.id);
  assert.ok(summary.parts[0]?.type === "text" && summary.parts[0].text === "Summary of earlier work");
  assert.equal(toV2Message(user).text, "/compact");

  await h.restart();
  const restored = h.manager.messages(session.id) ?? [];
  assert.deepEqual(
    restored.map((message) => message.info.id),
    live.map((message) => message.info.id),
  );
});

function withEnv(t: { after: (fn: () => void) => void }, key: string, value: string): void {
  const saved = process.env[key];
  process.env[key] = value;
  t.after(() => {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  });
}

test("replies after compaction stay in chronological turns live and after restart", { timeout: 15000 }, async (t) => {
  const h = bugHarness(t);
  const info = await h.manager.create(h.root);
  await h.manager.prompt(info.id, "interrupted-work", undefined, false, "msg_original");
  const session = h.manager.get(info.id);
  assert.ok(session?.pi);
  for (let index = 0; index < 2; index++) await session.pi.command({ type: "compact" });
  const marker = h.manager
    .messages(info.id)
    ?.findLast((message) => message.parts.some((part) => part.type === "compaction"));
  assert.ok(marker);

  await session.pi.command({ type: "release" });
  const reply = h.manager.messages(info.id)?.at(-1);
  assert.ok(reply?.info.role === "assistant");
  assert.equal(reply.info.parentID, marker.info.id);
  assert.equal(session.activeUserMessageID, "msg_original");
  const liveParent = reply.info.parentID;

  await h.restart();
  const restored = h.manager.messages(info.id)?.at(-1);
  assert.ok(restored?.info.role === "assistant");
  assert.equal(restored.info.parentID, liveParent);
  await h.manager.prompt(info.id, "normal", undefined, false, "msg_next");
  const next = h.manager.messages(info.id)?.at(-1);
  assert.ok(next?.info.role === "assistant");
  assert.equal(next.info.parentID, "msg_next");
});

test("queued prompts delivered after compaction keep their own reply parent", { timeout: 15000 }, async (t) => {
  const h = bugHarness(t);
  const info = await h.manager.create(h.root);
  await h.manager.prompt(info.id, "interrupted-work", undefined, false, "msg_original");
  await h.manager.prompt(info.id, "normal", undefined, false, "msg_queued", "queue");
  const session = h.manager.get(info.id);
  assert.ok(session?.pi);
  await session.pi.command({ type: "compact" });
  await session.pi.command({ type: "release" });
  const reply = h.manager.messages(info.id)?.at(-1);
  assert.ok(reply?.info.role === "assistant");
  assert.equal(reply.info.parentID, "msg_queued");

  await h.restart();
  const restored = h.manager.messages(info.id)?.at(-1);
  assert.ok(restored?.info.role === "assistant");
  assert.equal(restored.info.parentID, reply.info.parentID);
});

async function compactCommands(h: ReturnType<typeof bugHarness>, id: string): Promise<number> {
  const pi = h.manager.get(id)?.pi;
  assert.ok(pi);
  const inspected = await pi.command<{ commands: Array<{ type: string }> }>({ type: "inspect" });
  return inspected.data?.commands.filter((command) => command.type === "compact").length ?? 0;
}

test("a compaction OmO cancels on its own is retried", { timeout: 15000 }, async (t) => {
  withEnv(t, "ANTECHAMBER_TEST_CANCELLED_COMPACTS", "3");
  const h = bugHarness(t);
  const session = await h.manager.create(h.root);
  await h.manager.prompt(session.id, "normal");
  const from = h.events.length;

  assert.deepEqual(await compactSession(h.manager, session.id), { kind: "compacted" });
  assert.equal(await compactCommands(h, session.id), 4);
  // The retried attempt is one compaction to the user, not a failure followed by another.
  const compactionEvents = h.events
    .slice(from)
    .flatMap((e) => (e.type.startsWith("session.compaction.") ? [e.type] : []));
  assert.deepEqual(compactionEvents, ["session.compaction.started", "session.compaction.ended"]);
  const summary = h.manager.messages(session.id)?.at(-1);
  assert.ok(summary?.info.role === "assistant" && summary.info.summary === true);
});

test("a compaction waits for MCP servers still connecting instead of being cancelled", {
  timeout: 15000,
}, async (t) => {
  withEnv(t, "ANTECHAMBER_TEST_CONNECTING_MCP", "2");
  const h = bugHarness(t);
  const session = await h.manager.create(h.root);
  const from = h.events.length;

  assert.deepEqual(await compactSession(h.manager, session.id), { kind: "compacted" });
  assert.equal(await compactCommands(h, session.id), 1);
  const compactionEvents = h.events
    .slice(from)
    .flatMap((e) => (e.type.startsWith("session.compaction.") ? [e.type] : []));
  assert.deepEqual(compactionEvents, ["session.compaction.started", "session.compaction.ended"]);
});

test("a compaction the user aborts is not retried", { timeout: 15000 }, async (t) => {
  withEnv(t, "ANTECHAMBER_TEST_HOLD_COMPACT", "1");
  const h = bugHarness(t);
  const session = await h.manager.create(h.root);
  await h.manager.prompt(session.id, "normal");

  const started = h.wait(
    (e) => e.type === "session.updated" && e.properties.info.id === session.id && !!e.properties.info.time.compacting,
  );
  const from = h.events.length;
  const result = compactSession(h.manager, session.id);
  await started;
  await h.manager.abort(session.id);

  assert.deepEqual(await result, { kind: "error", message: "Compaction cancelled" });
  assert.equal(await compactCommands(h, session.id), 1);
  const compactionEvents = h.events
    .slice(from)
    .flatMap((e) => (e.type.startsWith("session.compaction.") ? [e.type] : []));
  assert.deepEqual(compactionEvents, ["session.compaction.started", "session.compaction.failed"]);
  assert.equal(h.manager.get(session.id)?.info.time.compacting, undefined);
});

test("background compaction after agent_end remains selected through revival", { timeout: 15000 }, async (t) => {
  const h = bugHarness(t);
  const info = await h.manager.create(h.root);
  await h.manager.prompt(info.id, "normal");
  const session = h.manager.get(info.id);
  assert.ok(session?.pi);
  const previousLeaf = session.tree.leafId;

  // Use the native event path, without sessionRpc's manual-compaction history refresh.
  await session.pi.command({ type: "compact" });
  const native = await getEntries(session.pi);
  assert.notEqual(native.leafId, previousLeaf);
  assert.equal(native.entries.at(-1)?.type, "compaction");
  const liveIds = h.manager.messages(info.id)?.map((message) => message.info.id);
  await h.restart();
  await h.manager.reloadMessages(info.id);

  const revived = h.manager.get(info.id);
  assert.ok(revived?.pi);
  assert.equal((await getEntries(revived.pi)).leafId, native.leafId);
  assert.equal(revived.tree.leafId, native.leafId);
  assert.deepEqual(
    h.manager.messages(info.id)?.map((message) => message.info.id),
    liveIds,
  );
});
