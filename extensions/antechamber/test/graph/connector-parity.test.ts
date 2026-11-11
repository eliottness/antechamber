import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type SessionRegistryEntry, SessionStore, ocIdFor as connectorOcIdFor } from "../../../../src/session-store.ts";
import { normalizeRegistry, ocIdFor } from "../../src/graph/graph.ts";
import { TaskStore } from "../../src/graph/store.ts";

test("session ids match the connector's ocIdFor", () => {
  for (const id of ["st_0000abcd", "00000000-0000-7000-8000-000000000001", ""]) {
    assert.equal(ocIdFor(id), connectorOcIdFor(id));
  }
});

test("the connector's registry entries keep the fields the graph reads", () => {
  const times = { created: 1, updated: 2 };
  const root: SessionRegistryEntry = {
    piSessionId: "root-pi",
    piPath: "/x/root.jsonl",
    directory: "/repo",
    title: "Run",
    ...times,
  };
  const child: SessionRegistryEntry = {
    ...times,
    piSessionId: "st_aaaa0001",
    piPath: "/x/child.jsonl",
    directory: "/repo",
    title: "Child",
    parentID: connectorOcIdFor("root-pi"),
    task: { id: "st_aaaa0001", parentPiId: "root-pi", input: {}, details: {} },
  };
  const registry = normalizeRegistry(JSON.parse(JSON.stringify({ ses_root: root, ses_child: child })));
  assert.deepEqual(registry, {
    ses_root: { piSessionId: "root-pi", title: "Run" },
    ses_child: {
      piSessionId: "st_aaaa0001",
      parentID: connectorOcIdFor("root-pi"),
      title: "Child",
      task: { id: "st_aaaa0001", parentPiId: "root-pi" },
    },
  });
});

test("the graph reads the connector's SQLite registry and sees later writes", (t) => {
  const state = mkdtempSync(join(tmpdir(), "omo-dag-sqlite-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const registry = new SessionStore(state);
  const times = { created: 1, updated: 2 };
  registry.set("ses_root", {
    piSessionId: "root-pi",
    piPath: "/x/root.jsonl",
    directory: "/repo",
    title: "Run",
    ...times,
  });
  const graph = new TaskStore({ agentDirs: [], stateDirs: [state] });
  assert.deepEqual(graph.loadRegistry(), { ses_root: { piSessionId: "root-pi", title: "Run" } });
  registry.set("ses_child", {
    ...times,
    piSessionId: "st_aaaa0001",
    piPath: "/x/child.jsonl",
    directory: "/repo",
    title: "Child",
    parentID: "ses_root",
    task: { id: "st_aaaa0001", parentPiId: "root-pi", input: {}, details: {} },
  });
  assert.deepEqual(graph.loadRegistry().ses_child, {
    piSessionId: "st_aaaa0001",
    parentID: "ses_root",
    title: "Child",
    task: { id: "st_aaaa0001", parentPiId: "root-pi" },
  });
});
