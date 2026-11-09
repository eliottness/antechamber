import assert from "node:assert/strict";
import test from "node:test";
import { branchEntries, getEntries } from "../src/session-tree.js";
import { bugHarness } from "./bug-harness.js";

type Harness = ReturnType<typeof bugHarness>;

async function turn(h: Harness, sessionID: string, text: string, messageID: string): Promise<void> {
  const idle = h.wait((event) => event.type === "session.idle");
  await h.manager.prompt(sessionID, text, undefined, false, messageID);
  await idle;
}

/** Instruction context the model holds on the active branch, oldest first. */
async function branchInstructions(h: Harness, sessionID: string): Promise<string[]> {
  const pi = h.manager.get(sessionID)?.pi;
  assert.ok(pi);
  return branchEntries(await getEntries(pi))
    .filter((entry) => entry.type === "custom_message" && entry.customType === "antechamber.instructions")
    .map((entry) => JSON.stringify(entry.content));
}

test("a revert that drops an instruction update sends the current value again", async (t) => {
  const h = bugHarness(t);
  const session = await h.manager.create(h.root);
  h.manager.putInstruction(session.id, "notes", "A");
  await turn(h, session.id, "one", "msg_one");
  h.manager.putInstruction(session.id, "notes", "B");
  await turn(h, session.id, "two", "msg_two");
  await h.manager.revert(session.id, "msg_one");
  // OpenChamber writes the current value again right before every send.
  h.manager.putInstruction(session.id, "notes", "B");
  await turn(h, session.id, "three", "msg_three");
  const context = await branchInstructions(h, session.id);
  assert.equal(context.length, 2);
  assert.match(context[1] ?? "", /changed and supersedes the previous value:\\n<context key=\\"notes\\">\\nB/);
});

test("a revert that drops an instruction removal sends the removal again", async (t) => {
  const h = bugHarness(t);
  const session = await h.manager.create(h.root);
  h.manager.putInstruction(session.id, "notes", "A");
  await turn(h, session.id, "one", "msg_one");
  h.manager.removeInstruction(session.id, "notes");
  await turn(h, session.id, "two", "msg_two");
  await h.manager.revert(session.id, "msg_one");
  await turn(h, session.id, "three", "msg_three");
  const context = await branchInstructions(h, session.id);
  assert.equal(context.length, 2);
  assert.match(context[1] ?? "", /no longer applies/);
});
