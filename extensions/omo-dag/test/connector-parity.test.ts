import assert from "node:assert/strict";
import { test } from "node:test";
import { type SessionRegistryEntry, ocIdFor as connectorOcIdFor } from "../../../src/session-store.ts";
import { normalizeRegistry, ocIdFor } from "../src/graph.ts";

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
