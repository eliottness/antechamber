import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  readSessionFileMeta,
  scanAllPiSessions,
  scanPiSessions,
  SessionPersistenceError,
  SessionStore,
} from "../src/session-store.js";

test("F2 B3 failed registry writes reject essential metadata instead of acknowledging success", () => {
  const state = "/dev/null/F2-state";
  const store = new SessionStore(state);
  const entry = {
    piSessionId: "F2",
    piPath: "/nonexistent/F2.jsonl",
    directory: "/nonexistent/F2",
    created: 1,
    updated: 2,
    parentID: "ses_parent",
    tree: { messageEntries: {}, leafId: "reverted-leaf" },
  };
  assert.throws(
    () => store.set("ses_F2", entry),
    (error: unknown) =>
      error instanceof SessionPersistenceError &&
      error.cause instanceof Error &&
      "code" in error.cause &&
      error.cause.code === "ENOTDIR",
  );
  assert.equal(store.get("ses_F2"), undefined, "failed save must not leave a falsely persisted cache entry");
  assert.equal(new SessionStore(state).get("ses_F2"), undefined);
});

test("F2 B3 failed registry updates and removals preserve the last committed cache", (t) => {
  const root = mkdtempSync(join(tmpdir(), "antechamber-store-f2-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, "state");
  const store = new SessionStore(state);
  const entry = { piSessionId: "F2", piPath: "/nonexistent/F2.jsonl", directory: root, created: 1, updated: 2 };
  store.set("ses_F2", entry);
  rmSync(state, { recursive: true });
  writeFileSync(state, "not a directory");
  assert.throws(() => store.update("ses_F2", { updated: 3 }), SessionPersistenceError);
  assert.deepEqual(store.get("ses_F2"), entry);
  assert.throws(() => store.remove("ses_F2"), SessionPersistenceError);
  assert.deepEqual(store.get("ses_F2"), entry);
});

test("nested registry batches publish ordered changes with one atomic write", (t) => {
  const state = mkdtempSync(join(tmpdir(), "antechamber-store-batch-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const store = new SessionStore(state);
  const entry = {
    piSessionId: "batched",
    piPath: "/nonexistent/batched.jsonl",
    directory: state,
    created: 1,
    updated: 2,
  };
  const persist = t.mock.fn(store["persist"].bind(store));
  store["persist"] = persist;

  const value = store.batch(() => {
    store.set("ses_kept", entry);
    store.batch(() => {
      store.update("ses_kept", { title: "renamed" });
      store.set("ses_removed", entry);
    });
    store.remove("ses_removed");
    assert.equal(store.get("ses_kept")?.title, "renamed");
    assert.equal(store.get("ses_removed"), undefined);
    assert.equal(new SessionStore(state).get("ses_kept"), undefined);
    assert.equal(existsSync(join(state, "sessions.json.lock")), false);
    return "listed";
  });

  assert.equal(value, "listed");
  assert.equal(persist.mock.callCount(), 1);
  const restored = new SessionStore(state);
  assert.deepEqual(restored.get("ses_kept"), { ...entry, title: "renamed" });
  assert.equal(restored.get("ses_removed"), undefined);
});

test("registry batches merge against independent writers at commit", (t) => {
  const state = mkdtempSync(join(tmpdir(), "antechamber-store-batch-race-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const first = new SessionStore(state);
  const second = new SessionStore(state);
  const entry = {
    piSessionId: "shared",
    piPath: "/nonexistent/shared.jsonl",
    directory: state,
    created: 1,
    updated: 2,
  };
  first.set("ses_shared", entry);

  first.batch(() => {
    first.update("ses_shared", { updated: 3 });
    second.update("ses_shared", { title: "independent rename" });
    second.set("ses_other", { ...entry, piSessionId: "other" });
    first.update("ses_other", { archived: 4 });
  });

  const restored = new SessionStore(state);
  assert.deepEqual(restored.get("ses_shared"), { ...entry, updated: 3, title: "independent rename" });
  assert.equal(restored.get("ses_other")?.archived, 4);
  assert.deepEqual(first.get("ses_other"), restored.get("ses_other"));
});

test("a cached registry picks up a same-size write from another process before its next write", (t) => {
  const state = mkdtempSync(join(tmpdir(), "antechamber-store-cache-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const first = new SessionStore(state);
  const second = new SessionStore(state);
  const entry = {
    piSessionId: "shared",
    piPath: "/nonexistent/shared.jsonl",
    directory: state,
    created: 1,
    updated: 2,
  };
  first.set("ses_shared", { ...entry, title: "aaaa" });
  second.update("ses_shared", { title: "bbbb" });
  first.update("ses_shared", { updated: 3 });

  assert.deepEqual(new SessionStore(state).get("ses_shared"), { ...entry, title: "bbbb", updated: 3 });
});

test("child task spawn specs stay in memory but are not written to the registry", (t) => {
  const state = mkdtempSync(join(tmpdir(), "antechamber-store-spawn-spec-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const store = new SessionStore(state);
  const details = { task_id: "st_spec0001", status: "running", spawn_spec: { prompt: "large prompt" } };
  store.set("ses_child", {
    piSessionId: "st_spec0001",
    piPath: "/nonexistent/child.jsonl",
    directory: state,
    parentID: "ses_parent",
    task: { id: "st_spec0001", parentPiId: "root-pi", input: { prompt: "large prompt" }, details },
    created: 1,
    updated: 2,
  });

  assert.deepEqual(store.get("ses_child")?.task?.details, details);
  assert.deepEqual(new SessionStore(state).get("ses_child")?.task, {
    id: "st_spec0001",
    parentPiId: "root-pi",
    input: { prompt: "large prompt" },
    details: { task_id: "st_spec0001", status: "running" },
  });
});

for (const failure of ["callback", "commit"] as const) {
  test(`failed batch ${failure} preserves the committed registry cache`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "antechamber-store-batch-failure-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const state = join(root, "state");
    const store = new SessionStore(state);
    const entry = {
      piSessionId: "kept",
      piPath: "/nonexistent/kept.jsonl",
      directory: root,
      created: 1,
      updated: 2,
      tree: { messageEntries: { msg: "original" }, leafId: "original" },
    };
    store.set("ses_kept", entry);
    const interrupted = new Error("interrupted listing");

    assert.throws(
      () =>
        store.batch(() => {
          const current = store.get("ses_kept");
          assert.ok(current?.tree);
          current.tree.leafId = "staged";
          current.tree.messageEntries.msg = "staged";
          store.update("ses_kept", { updated: 3 });
          store.remove("ses_kept");
          store.set("ses_new", entry);
          if (failure === "callback") throw interrupted;
          rmSync(state, { recursive: true });
          writeFileSync(state, "not a directory");
        }),
      failure === "callback" ? (error: unknown) => error === interrupted : SessionPersistenceError,
    );
    assert.deepEqual(store.get("ses_kept"), entry);
    assert.equal(store.get("ses_new"), undefined);
    if (failure === "callback") assert.deepEqual(new SessionStore(state).get("ses_kept"), entry);
  });
}

test("queued registry writes snapshot mutable inputs and staged reads", (t) => {
  const state = mkdtempSync(join(tmpdir(), "antechamber-store-batch-snapshot-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const store = new SessionStore(state);
  const entry = {
    piSessionId: "snapshot",
    piPath: "/nonexistent/snapshot.jsonl",
    directory: state,
    created: 1,
    updated: 2,
    tree: { messageEntries: {}, leafId: "saved" },
  };
  const patch = { tree: { messageEntries: {}, leafId: "patched" } };
  store.batch(() => {
    store.set("ses_set", entry);
    store.set("ses_patch", entry);
    store.update("ses_patch", patch);
    entry.tree.leafId = "changed input";
    patch.tree.leafId = "changed patch";
    for (const id of ["ses_set", "ses_patch"]) {
      const staged = store.get(id);
      assert.ok(staged?.tree);
      staged.tree.leafId = "changed staged read";
    }
  });
  const restored = new SessionStore(state);
  assert.equal(restored.get("ses_set")?.tree?.leafId, "saved");
  assert.equal(restored.get("ses_patch")?.tree?.leafId, "patched");
});

test("a read-only registry batch does not acquire a write lock", (t) => {
  const root = mkdtempSync(join(tmpdir(), "antechamber-store-batch-read-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, "missing");
  const store = new SessionStore(state);
  assert.deepEqual(
    store.batch(() => store.directories()),
    [],
  );
  assert.equal(existsSync(state), false);
});

function withAgentDir(agentDir: string, run: () => void): void {
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    run();
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
}

function sessionHeader(id: string, cwd: string): string {
  return `${JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp: "2026-10-12T00:00:00.000Z",
    cwd,
  })}\n`;
}

function sessionDir(agentDir: string, cwd: string): string {
  const sanitized = cwd.replace(/^[/\\]+/, "").replace(/[\\/:\u0000]/g, "-");
  return join(agentDir, "sessions", `--${sanitized}--`);
}

test("native names beyond scanner head limits and appended renames agree in both scans", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "antechamber-title-scan-"));
  try {
    withAgentDir(agentDir, () => {
      const cwd = "/tmp/native-title";
      const dir = sessionDir(agentDir, cwd);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "title.jsonl");
      writeFileSync(
        file,
        sessionHeader("title", cwd) +
          JSON.stringify({
            type: "message",
            message: { role: "user", content: [{ type: "text", text: "provisional" }] },
          }) +
          "\n" +
          `${JSON.stringify({ type: "custom", data: "x".repeat(2000) })}\n`.repeat(220) +
          JSON.stringify({ type: "session_info", name: "First native" }) +
          "\n" +
          JSON.stringify({ type: "session_info", name: "Latest native" }) +
          "\n" +
          JSON.stringify({ type: "session_info", name: "  " }) +
          "\n",
      );
      assert.equal(scanPiSessions(cwd)[0]?.title, "Latest native");
      assert.equal(scanAllPiSessions()[0]?.title, "Latest native");
      appendFileSync(file, `${JSON.stringify({ type: "session_info", name: "Appended native" })}\n`);
      assert.equal(scanPiSessions(cwd)[0]?.title, "Appended native");
      assert.equal(scanAllPiSessions()[0]?.title, "Appended native");
    });
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("scanAllPiSessions finds OmO sessions across cwd folders", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "antechamber-agent-"));
  const firstCwd = "/tmp/openchamber-first";
  const secondCwd = "/tmp/openchamber-second";
  try {
    withAgentDir(agentDir, () => {
      for (const [cwd, id] of [
        [firstCwd, "first-session"],
        [secondCwd, "second-session"],
      ] as const) {
        const dir = sessionDir(agentDir, cwd);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${id}.jsonl`), sessionHeader(id, cwd));
      }

      const scanned = scanAllPiSessions();
      assert.deepEqual(
        new Map(scanned.map((session) => [session.piSessionId, session.directory])),
        new Map([
          ["first-session", firstCwd],
          ["second-session", secondCwd],
        ]),
      );
    });
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("scanPiSessions skips a header whose cwd mismatches its folder", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "antechamber-agent-"));
  const expectedCwd = "/tmp/openchamber-expected";
  try {
    withAgentDir(agentDir, () => {
      const dir = sessionDir(agentDir, expectedCwd);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "mismatch.jsonl"), sessionHeader("mismatch-session", "/tmp/other-cwd"));

      assert.deepEqual(scanPiSessions(expectedCwd), []);
    });
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

// Entry shapes follow OmO session JSONL; the expected values follow senpi's getSessionContextSettings.
const modelChange = (id: string, parentId: string | null, provider: string, modelId: string, extra = {}) => ({
  type: "model_change",
  id,
  parentId,
  provider,
  modelId,
  ...extra,
});
const level = (id: string, parentId: string, thinkingLevel: unknown) => ({
  type: "thinking_level_change",
  id,
  parentId,
  thinkingLevel,
});
const reply = (id: string, parentId: string, provider: string, model: string, extra = {}) => ({
  type: "message",
  id,
  parentId,
  message: { role: "assistant", content: [], provider, model, ...extra },
});

for (const [name, entries, expected] of [
  [
    "follows the resume path, not file order",
    [
      modelChange("m", null, "a", "one"),
      level("t1", "m", "high"),
      level("abandoned", "t1", "low"),
      reply("tail", "t1", "a", "one"),
    ],
    { model: { providerID: "a", modelID: "one" }, thinkingLevel: "high" },
  ],
  [
    "restores the pre-fallback model and level inside an open fallback window",
    [
      modelChange("m", null, "a", "one"),
      level("t1", "m", "high"),
      modelChange("f", "t1", "b", "two", { reason: "fallback", originalProvider: "a", originalModelId: "one" }),
      level("t2", "f", "low"),
      reply("r", "t2", "b", "two"),
    ],
    { model: { providerID: "a", modelID: "one" }, thinkingLevel: "high" },
  ],
  [
    "drops a level set inside a reverted fallback window",
    [
      modelChange("m", null, "a", "one"),
      level("t1", "m", "high"),
      modelChange("f", "t1", "b", "two", { reason: "fallback", originalProvider: "a", originalModelId: "one" }),
      level("t2", "f", "low"),
      modelChange("back", "t2", "a", "one", { reason: "fallback-revert" }),
    ],
    { model: { providerID: "a", modelID: "one" }, thinkingLevel: "high" },
  ],
  [
    "keeps an explicit pick over a same-provider wire id, but follows another provider and skips virtual replies",
    [
      modelChange("m", null, "a", "one"),
      reply("wire", "m", "a", "one-20990101"),
      reply("routed", "wire", "virtual", "router", { api: "pi-virtual" }),
      reply("other", "routed", "b", "two"),
    ],
    { model: { providerID: "b", modelID: "two" } },
  ],
  [
    "clears the level on a malformed thinking entry",
    [modelChange("m", null, "a", "one"), level("t1", "m", "high"), level("t2", "t1", null)],
    { model: { providerID: "a", modelID: "one" } },
  ],
] as const) {
  test(`session file resume selection ${name}`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), "antechamber-resume-selection-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "session.jsonl");
    writeFileSync(file, sessionHeader("resume", dir) + entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
    const { model, thinkingLevel } = readSessionFileMeta(file, "resume");
    assert.deepEqual(
      { ...(model !== undefined ? { model } : {}), ...(thinkingLevel !== undefined ? { thinkingLevel } : {}) },
      expected,
    );
  });
}
