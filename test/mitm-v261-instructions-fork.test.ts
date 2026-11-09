import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { branchEntries, getEntries } from "../src/session-tree.js";
import { bugHarness } from "./bug-harness.js";

type Harness = ReturnType<typeof bugHarness>;

async function turn(h: Harness, sessionID: string, text: string): Promise<void> {
  const idle = h.wait((event) => event.type === "session.idle" && event.properties.sessionID === sessionID);
  await h.manager.prompt(sessionID, text);
  await idle;
}

async function snapshots(h: Harness, sessionID: string): Promise<unknown[]> {
  const pi = h.manager.get(sessionID)?.pi;
  assert.ok(pi);
  return branchEntries(await getEntries(pi))
    .filter((entry) => entry.type === "custom_message" && entry.customType === "antechamber.instructions")
    .map((entry) => {
      const details = entry.details;
      assert.ok(typeof details === "object" && details !== null && "instructions" in details);
      return details.instructions;
    });
}

test("fork inherits pending instruction values and removals as an independent deep copy", async (t) => {
  const h = bugHarness(t);
  process.env.ANTECHAMBER_PI_BINARY = resolve("test/fixtures/fake-omo.mjs");
  const parent = await h.manager.create(h.root);
  await turn(h, parent.id, "one");
  const value = { rules: ["pending"] };
  h.manager.putInstruction(parent.id, "notes", value);
  h.manager.putInstruction(parent.id, "removed", "obsolete");
  h.manager.removeInstruction(parent.id, "removed");
  const child = await h.manager.fork(parent.id);
  assert.notEqual(child.id, parent.id);
  assert.deepEqual(h.manager.get(child.id)?.instructions, {
    notes: { value: { rules: ["pending"] } },
    removed: { value: null, removed: true },
  });
  value.rules.push("parent only");
  assert.deepEqual(h.manager.get(child.id)?.instructions?.notes?.value, { rules: ["pending"] });
  h.manager.putInstruction(child.id, "removed", "child only");
  assert.deepEqual(h.manager.get(parent.id)?.instructions?.removed, { value: null, removed: true });
  await turn(h, child.id, "two");
  assert.deepEqual(await snapshots(h, child.id), [{ notes: { rules: ["pending"] }, removed: "child only" }]);
  await h.restart();
  assert.deepEqual(h.manager.get(child.id)?.instructions?.notes?.value, { rules: ["pending"] });
});

for (const removed of [false, true]) {
  test(`fork keeps the native delivery baseline with removal=${removed}`, async (t) => {
    const h = bugHarness(t);
    process.env.ANTECHAMBER_PI_BINARY = resolve("test/fixtures/fake-omo.mjs");
    const parent = await h.manager.create(h.root);
    h.manager.putInstruction(parent.id, "notes", "delivered");
    await turn(h, parent.id, "one");
    if (removed) {
      h.manager.removeInstruction(parent.id, "notes");
      await turn(h, parent.id, "two");
    }
    const before = await snapshots(h, parent.id);
    assert.deepEqual(before, removed ? [{ notes: "delivered" }, {}] : [{ notes: "delivered" }]);
    const child = await h.manager.fork(parent.id);
    assert.notEqual(child.id, parent.id);
    assert.deepEqual(h.manager.get(child.id)?.instructions, h.manager.get(parent.id)?.instructions);
    if (!removed) h.manager.putInstruction(child.id, "notes", "delivered");
    await turn(h, child.id, "child next");
    assert.deepEqual(await snapshots(h, child.id), before);
    h.manager.putInstruction(child.id, "notes", "child update");
    await turn(h, child.id, "child changed");
    assert.deepEqual((await snapshots(h, child.id)).at(-1), { notes: "child update" });
    assert.deepEqual(h.manager.get(parent.id)?.instructions?.notes, {
      value: removed ? null : "delivered",
      ...(removed ? { removed: true } : {}),
    });
  });
}
