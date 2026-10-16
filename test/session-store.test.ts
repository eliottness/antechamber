import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scanAllPiSessions, scanPiSessions, SessionPersistenceError, SessionStore } from "../src/session-store.js";

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
