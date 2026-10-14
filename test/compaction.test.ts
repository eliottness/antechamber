import assert from "node:assert/strict";
import test from "node:test";
import { compactSession } from "../src/session-commands.js";
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
