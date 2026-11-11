import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { SessionPersistenceError, SessionStore } from "../src/session-store.js";

function setup(t: TestContext) {
  const state = mkdtempSync(join(tmpdir(), "antechamber-sqlite-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const entry = { piSessionId: "pi", piPath: "/synthetic/pi.jsonl", directory: state, created: 1, updated: 2 };
  return { state, entry };
}

test("legacy registry migrates once and retains the original bytes in a private backup", (t) => {
  const { state, entry } = setup(t);
  const legacy = join(state, "sessions.json");
  const raw = JSON.stringify({ ses_original: entry, ses_invalid: { piPath: "incomplete" } });
  writeFileSync(legacy, raw, { mode: 0o644 });
  const store = new SessionStore(state);

  assert.deepEqual(store.get("ses_original"), entry);
  assert.equal(store.get("ses_invalid"), undefined);
  assert.equal(existsSync(legacy), false);
  const backups = readdirSync(state).filter((name) => name.startsWith("sessions.json.migrated-"));
  assert.equal(backups.length, 1);
  const backup = join(state, backups[0]!);
  assert.equal(readFileSync(backup, "utf8"), raw);
  assert.equal(statSync(backup).mode & 0o777, 0o600);
  store.remove("ses_original");
  // Reappearing legacy data must not resurrect deleted sessions, even in an empty DB.
  writeFileSync(legacy, raw);
  assert.equal(new SessionStore(state).get("ses_original"), undefined);
  assert.equal(readFileSync(backup, "utf8"), raw);
});

test("single entry writes only touch the changed SQLite row", (t) => {
  const { state, entry } = setup(t);
  const store = new SessionStore(state);
  store.batch(() => {
    store.set("ses_changed", entry);
    store.set("ses_untouched", { ...entry, piSessionId: "untouched" });
  });
  const db = new DatabaseSync(join(state, "sessions.sqlite"));
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE audit (id TEXT);
    CREATE TRIGGER audit_update AFTER UPDATE ON sessions BEGIN INSERT INTO audit VALUES (NEW.id); END;
    CREATE TRIGGER audit_insert AFTER INSERT ON sessions BEGIN INSERT INTO audit VALUES (NEW.id); END;
    CREATE TRIGGER audit_delete AFTER DELETE ON sessions BEGIN INSERT INTO audit VALUES (OLD.id); END;
  `);

  store.update("ses_changed", { title: "updated" });

  assert.deepEqual(
    db
      .prepare("SELECT id FROM audit")
      .all()
      .map((row) => row.id),
    ["ses_changed"],
  );
  assert.equal(new SessionStore(state).get("ses_untouched")?.piSessionId, "untouched");
});

test("a restart completes a pending migration rename without overwriting committed rows", (t) => {
  const { state, entry } = setup(t);
  const legacy = join(state, "sessions.json");
  const raw = JSON.stringify({ ses_original: entry });
  writeFileSync(legacy, raw);
  const store = new SessionStore(state);
  store.update("ses_original", { title: "committed" });
  const backup = readdirSync(state).find((name) => name.startsWith("sessions.json.migrated-"));
  assert.ok(backup);
  // Recreate the durable state of a crash between the import COMMIT and rename.
  renameSync(join(state, backup), legacy);

  const restarted = new SessionStore(state);

  assert.equal(restarted.get("ses_original")?.title, "committed");
  assert.equal(existsSync(legacy), false);
  assert.equal(readFileSync(join(state, backup), "utf8"), raw);
});

test("sessions an older antechamber wrote to sessions.json after the migration are merged, newest wins", (t) => {
  const { state, entry } = setup(t);
  const legacy = join(state, "sessions.json");
  writeFileSync(legacy, JSON.stringify({ ses_kept: entry, ses_changed: entry, ses_deleted: entry }));
  const store = new SessionStore(state);
  store.remove("ses_deleted");
  const later = Date.now() + 60_000;
  t.mock.method(console, "warn", () => {});
  // A rollback: v1.x rewrites sessions.json from its own view, then v2 starts again.
  writeFileSync(
    legacy,
    JSON.stringify({
      ses_kept: entry,
      ses_deleted: entry,
      ses_changed: { ...entry, title: "renamed in 1.x", updated: later },
      ses_new: { ...entry, piSessionId: "new", updated: later },
    }),
  );

  const reopened = new SessionStore(state);

  assert.equal(reopened.get("ses_new")?.piSessionId, "new");
  assert.equal(reopened.get("ses_changed")?.title, "renamed in 1.x");
  assert.deepEqual(reopened.get("ses_kept"), entry);
  assert.equal(reopened.get("ses_deleted"), undefined);
  assert.equal(existsSync(legacy), false);
  assert.equal(readdirSync(state).filter((name) => name.startsWith("sessions.json.merged-")).length, 1);
});

test("malformed legacy JSON stays untouched and can be repaired before migration", (t) => {
  const { state, entry } = setup(t);
  const legacy = join(state, "sessions.json");
  writeFileSync(legacy, "{broken");
  assert.equal(new SessionStore(state).get("ses_repaired"), undefined);
  assert.equal(readFileSync(legacy, "utf8"), "{broken");
  writeFileSync(legacy, JSON.stringify({ ses_repaired: entry }));

  assert.deepEqual(new SessionStore(state).get("ses_repaired"), entry);
  assert.equal(existsSync(legacy), false);
});

test("a populated SQLite registry preserves a legacy file without importing it", (t) => {
  const { state, entry } = setup(t);
  new SessionStore(state).set("ses_existing", entry);
  const raw = JSON.stringify({ ses_old: entry });
  const legacy = join(state, "sessions.json");
  writeFileSync(legacy, raw);

  const reopened = new SessionStore(state);

  assert.equal(reopened.get("ses_existing")?.piSessionId, "pi");
  assert.equal(reopened.get("ses_old"), undefined);
  assert.equal(readFileSync(legacy, "utf8"), raw);
});

test("already open stores see external writes and deletes before their next read", (t) => {
  const { state, entry } = setup(t);
  const first = new SessionStore(state);
  const second = new SessionStore(state);
  first.set("ses_shared", entry);
  assert.equal(second.get("ses_shared")?.title, undefined);

  first.update("ses_shared", { title: "external" });

  assert.equal(second.get("ses_shared")?.title, "external");
  assert.equal(second.idFor("pi"), "ses_shared");
  first.remove("ses_shared");
  assert.equal(second.get("ses_shared"), undefined);
  assert.equal(second.idFor("pi"), undefined);
  assert.deepEqual(second.directories(), []);
});

test("SQLite batch failure rolls back every row and leaves committed reads intact", (t) => {
  const { state, entry } = setup(t);
  const store = new SessionStore(state);
  store.set("ses_kept", entry);
  const db = new DatabaseSync(join(state, "sessions.sqlite"));
  t.after(() => db.close());
  db.exec(`CREATE TRIGGER reject_insert BEFORE INSERT ON sessions
    WHEN NEW.id = 'ses_rejected' BEGIN SELECT RAISE(ABORT, 'test storage failure'); END;`);

  assert.throws(
    () =>
      store.batch(() => {
        store.update("ses_kept", { title: "uncommitted" });
        store.set("ses_rejected", entry);
      }),
    SessionPersistenceError,
  );

  assert.deepEqual(store.get("ses_kept"), entry);
  assert.equal(new SessionStore(state).get("ses_rejected"), undefined);
});

test("SQLite WAL and shared memory files remain private under umask 000", (t) => {
  const { state, entry } = setup(t);
  const previous = process.umask(0);
  try {
    new SessionStore(state).set("ses_private", entry);
  } finally {
    process.umask(previous);
  }
  assert.equal(statSync(state).mode & 0o777, 0o700);
  for (const name of ["sessions.sqlite", "sessions.sqlite-wal", "sessions.sqlite-shm"])
    assert.equal(statSync(join(state, name)).mode & 0o777, 0o600, name);
});

test("two processes opening the legacy registry import it exactly once", async (t) => {
  const { state, entry } = setup(t);
  writeFileSync(join(state, "sessions.json"), JSON.stringify({ ses_shared: entry }));
  const source = `import { SessionStore } from ${JSON.stringify(resolve("src/session-store.ts"))};
    const store = new SessionStore(process.argv[1]);
    if (store.get("ses_shared")?.piSessionId !== "pi") process.exitCode = 1;
    store.update("ses_shared", { title: "process" });`;
  const children = [0, 1].map(() =>
    spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source, state], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  t.after(() => {
    for (const child of children) if (child.exitCode === null) child.kill();
  });
  const results = await Promise.all(
    children.map(async (child) => {
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const [code] = await once(child, "exit", { signal: AbortSignal.timeout(10_000) });
      assert.equal(code, 0, stderr);
    }),
  );
  assert.equal(results.length, 2);
  assert.equal(readdirSync(state).filter((name) => name.startsWith("sessions.json.migrated-")).length, 1);
  assert.equal(new SessionStore(state).get("ses_shared")?.title, "process");
});
