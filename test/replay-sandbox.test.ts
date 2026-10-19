import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { copyReplayState } from "../contrib/replay/sandbox.js";
import { ocIdFor, type SessionRegistryEntry, SessionStore } from "../src/session-store.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "replay-registry-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const stateDir = join(source, "state");
  const state = join(root, "sandbox", "state");
  const agent = join(root, "sandbox", "agent");
  const directory = join(source, "project");
  mkdirSync(directory, { recursive: true });
  const put = (path: string, value: unknown) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value)}\n`);
  };
  const entry = (id: string, parentID?: string): SessionRegistryEntry => ({
    piSessionId: id,
    piPath: parentID ? join(stateDir, "children", `${id}.jsonl`) : join(source, "native", `${id}.jsonl`),
    directory,
    created: 1,
    updated: 2,
    ...(parentID
      ? {
          parentID,
          archived: 3,
          task: {
            id,
            parentPiId: parentID === ocIdFor("root") ? "root" : "st_child",
            input: { prompt: "fixture" },
            details: {
              status: "completed",
              host_session: { session_path: join(source, "removed-native", `${id}.jsonl`) },
              stats: { cost_usd: id === "st_child" ? 2 : 3 },
            },
          },
        }
      : {}),
  });
  const rootID = ocIdFor("root");
  const childID = ocIdFor("st_child");
  const nestedID = ocIdFor("st_nested");
  const registry = {
    [nestedID]: entry("st_nested", childID),
    [childID]: entry("st_child", rootID),
    [rootID]: entry("root"),
    [ocIdFor("unrelated")]: entry("unrelated"),
    [ocIdFor("st_other")]: entry("st_other", ocIdFor("unrelated")),
  };
  for (const record of Object.values(registry))
    put(record.piPath, { type: "session", id: record.piSessionId, cwd: directory });
  const reference = join(source, "references", "original.jsonl");
  put(reference, { type: "session", id: "original", cwd: directory });
  put(registry[rootID]!.piPath, {
    type: "session",
    id: "root",
    cwd: directory,
    parentSession: reference,
    task: { host_session: { session_path: registry[childID]!.piPath } },
  });
  put(join(stateDir, "sessions.json"), registry);
  const selected: [string, SessionRegistryEntry][] = [[rootID, registry[rootID]!]];
  return { root, source, stateDir, state, agent, registry, selected, rootID, childID, nestedID, reference };
}

test("replay retains archived task descendants without native originals and excludes unrelated registries", (t) => {
  const f = fixture(t);
  const copiedIDs = copyReplayState(f.stateDir, f.state, f.agent, f.registry, f.selected);
  assert.deepEqual(copiedIDs.sort(), [f.rootID, f.childID, f.nestedID].sort());
  const copied = new SessionStore(f.state);
  assert.deepEqual(copied.childIds().sort(), [f.childID, f.nestedID].sort());
  assert.equal(copied.get(f.nestedID)?.parentID, f.childID);
  assert.deepEqual(copied.get(f.childID)?.task?.details.stats, { cost_usd: 2 });
  for (const id of [f.childID, f.nestedID]) {
    const child = copied.get(id);
    assert.ok(child);
    assert.equal(child.piPath, join(f.state, "children", `${child.task?.id}.jsonl`));
    assert.equal(existsSync(child.piPath), true);
  }
  assert.equal(copied.get(ocIdFor("unrelated")), undefined);
  assert.equal(copied.get(ocIdFor("st_other")), undefined);
  assert.deepEqual(
    f.selected.map(([id]) => id),
    [f.rootID],
  );
});

test("replay rewrites transcript references and task paths into its sandbox", (t) => {
  const f = fixture(t);
  copyReplayState(f.stateDir, f.state, f.agent, f.registry, f.selected);
  const copied = new SessionStore(f.state);
  const root = copied.get(f.rootID);
  assert.ok(root);
  const header = JSON.parse(readFileSync(root.piPath, "utf8"));
  assert.equal(header.parentSession.startsWith(join(f.root, "sandbox")), true);
  assert.equal(readFileSync(header.parentSession, "utf8"), readFileSync(f.reference, "utf8"));
  assert.equal(header.task.host_session.session_path, join(f.state, "children", "st_child.jsonl"));
  const child = copied.get(f.childID);
  assert.ok(child);
  const host = child.task?.details.host_session;
  assert.ok(host && typeof host === "object" && "session_path" in host);
  assert.equal(String(host.session_path).startsWith(join(f.root, "sandbox")), true);
  assert.equal(existsSync(String(host.session_path)), false);
});

test("replay copying leaves the source registry, files and selected test set unchanged", (t) => {
  const f = fixture(t);
  const snapshot = () =>
    readdirSync(f.source, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const path = join(entry.parentPath, entry.name);
        return [path, readFileSync(path, "utf8")];
      });
  const before = snapshot();
  const selected = JSON.stringify(f.selected);
  const registry = JSON.stringify(f.registry);
  copyReplayState(f.stateDir, f.state, f.agent, f.registry, f.selected);
  assert.deepEqual(snapshot(), before);
  assert.equal(JSON.stringify(f.registry), registry);
  assert.equal(JSON.stringify(f.selected), selected);
});
