import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PiRpcClient, PiRpcCommand } from "../src/pi-rpc.js";
import type { ManagedSession } from "../src/sessions.js";
import { type Entries, forkConversation, getEntries, readSessionTree, SessionTreeError } from "../src/session-tree.js";
import { bugHarness } from "./bug-harness.js";

const entry = { type: "message", id: "entry", parentId: null, message: { role: "user" } };

for (const suffix of ['{"type":"message","id":', '{"type":"message","id":\n', "null"]) {
  test("preserves the valid prefix when the final session line is malformed", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "antechamber-tree-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "session.jsonl");
    writeFileSync(path, `${JSON.stringify({ type: "session", id: "session" })}\n${JSON.stringify(entry)}\n${suffix}`);
    assert.deepEqual(readSessionTree(path), { entries: [entry], leafId: "entry" });
  });
}

test("rejects malformed non-final session lines with a typed error", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "antechamber-tree-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, `{"type":\n${JSON.stringify(entry)}\n`);
  assert.throws(() => readSessionTree(path), SessionTreeError);
});

test("large histories can accept prompts and retain the native cursor without overflowing RPC", {
  timeout: 60_000,
}, async (t) => {
  const h = bugHarness(t);
  const session = await h.manager.create(h.root);
  const managed = h.manager.get(session.id);
  assert.ok(managed?.pi && managed.piPath);
  const pi = managed.pi;
  const padding = "x".repeat(1024 * 1024);
  for (let index = 0; index < 65; index++) {
    const response = await pi.command({
      type: "append_session_entry",
      entry: { type: "custom", customType: "history-padding", data: padding },
    });
    assert.equal(response.success, true);
  }
  assert.ok(statSync(managed.piPath).size > 64 * 1024 * 1024);

  await h.manager.prompt(session.id, "continue", undefined, false, "msg_large_history");
  const tree = await getEntries(pi);
  const user = tree.entries.find((entry) => entry.message?.clientMessageId === "msg_large_history");
  assert.ok(user);
  assert.ok(managed.tree.messageEntries.msg_large_history);
  assert.equal(tree.entries.at(-1)?.message?.role, "assistant");
  assert.equal(
    h.events.some((event) => event.type === "session.error"),
    false,
  );

  const selected = await pi.command({
    type: "navigate_tree",
    targetId: user.id,
    intent: "resume",
  });
  assert.equal(selected.success, true);
  const external = { type: "custom", id: "external", parentId: tree.leafId, data: "another client" };
  appendFileSync(managed.piPath, `${JSON.stringify(external)}\n`);
  const native = await getEntries(pi);
  assert.equal(native.leafId, user.id, "the native cursor can precede the file tail");
  assert.deepEqual(native.entries, tree.entries, "external appends are not mistaken for native runtime entries");

  await pi.command({
    type: "append_session_entry",
    entry: { type: "custom", customType: "native-after-external", data: "native metadata" },
  });
  assert.equal((await pi.command({ type: "get_entries", since: external.id })).success, false);
  await h.manager.revert(session.id, "msg_large_history");
  assert.equal(
    (await pi.command({ type: "get_entries", since: external.id })).success,
    true,
    "tree operations must load interleaved disk-only entries into the native runtime",
  );
  await h.manager.unrevert(session.id);
  assert.equal(managed.tree.leafId, tree.leafId, "reloading preserves the saved selection");

  await h.restart();
  await h.manager.prompt(session.id, "after restart", undefined, false, "msg_large_restart");
  assert.ok(h.manager.get(session.id)?.tree.messageEntries.msg_large_restart);
});

test("a fork at an assistant reply keeps the results of its own tool calls", async () => {
  // OmO writes tool results after the reply, with extension entries in between; a later step starts a new reply.
  const tree: Entries = {
    entries: [
      { type: "message", id: "u", parentId: null, message: { role: "user", content: "go" } },
      {
        type: "message",
        id: "a",
        parentId: "u",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1" },
            { type: "toolCall", id: "call-2" },
          ],
        },
      },
      { type: "message", id: "r1", parentId: "a", message: { role: "toolResult", toolCallId: "call-1" } },
      { type: "custom_message", id: "c", parentId: "r1", customType: "omo-kibitzer:recall" },
      { type: "message", id: "r2", parentId: "c", message: { role: "toolResult", toolCallId: "call-2" } },
      { type: "message", id: "next", parentId: "r2", message: { role: "assistant", content: [{ type: "text" }] } },
    ],
    leafId: "next",
  };
  const commands: PiRpcCommand[] = [];
  const pi = {
    command: async (command: PiRpcCommand) => {
      commands.push(command);
      return {
        type: "response",
        command: command.type,
        success: true,
        data: { sessionId: "fork", sessionFile: "fork.jsonl" },
      };
    },
    dispose: async () => {},
  } as unknown as PiRpcClient;
  const s = {
    tree: { messageEntries: { msg_reply: "a" } },
    messages: [{ info: { id: "msg_reply", role: "assistant" }, parts: [] }],
  } as unknown as ManagedSession;
  await forkConversation(s, pi, tree, "msg_reply");
  assert.deepEqual(commands[0], { type: "fork", entryId: "r2", position: "at" });
});
