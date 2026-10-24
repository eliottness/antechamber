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
    task: {
      id: "st_aaaa0001",
      parentPiId: "root-pi",
      terminalAt: 3,
      input: { description: "work", prompt: "use agent://st_bbbb0002", subagent_type: "deep-low" },
      details: {
        status: "completed",
        task_summary: "work",
        category: "deep-low",
        model: "openai/gpt-x",
        duration_ms: 2,
        final_response: "done",
        run_stats: { total_tokens: 5, cost_usd: 1, tool_calls: 2, turns: 1 },
      },
    },
  };
  const registry = normalizeRegistry(JSON.parse(JSON.stringify({ ses_root: root, ses_child: child })));
  assert.deepEqual(registry, {
    ses_root: { piSessionId: "root-pi", title: "Run", created: 1 },
    ses_child: {
      piSessionId: "st_aaaa0001",
      parentID: connectorOcIdFor("root-pi"),
      title: "Child",
      created: 1,
      task: {
        id: "st_aaaa0001",
        parentPiId: "root-pi",
        terminalAt: 3,
        input: { description: "work", prompt: "use agent://st_bbbb0002", subagent_type: "deep-low" },
        details: {
          status: "completed",
          task_summary: "work",
          category: "deep-low",
          model: "openai/gpt-x",
          duration_ms: 2,
          final_response: "done",
          run_stats: { total_tokens: 5, cost_usd: 1, tool_calls: 2, turns: 1 },
        },
      },
    },
  });
});
