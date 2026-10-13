import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readSessionTree, SessionTreeError } from "../src/session-tree.js";

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
