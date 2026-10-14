import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildGraph, nodeState, ocIdFor, type Registry, type TaskRecord } from "../src/graph.ts";
import { CARD_H, CARD_W, layoutGraph, reach } from "../src/layout.ts";

const ROOT = "01a1-root";
const at = (s: number) => new Date(Date.UTC(2026, 9, 13, 12, 0, s)).toISOString();

function task(id: string, created: number, ended: number | undefined, extra: Partial<TaskRecord> = {}): TaskRecord {
  return {
    task_id: id,
    status: ended === undefined ? "running" : "completed",
    parent_session_id: ROOT,
    root_session_id: ROOT,
    depth: 1,
    created_at: at(created),
    started_at: at(created),
    ...(ended !== undefined ? { terminal_at: at(ended) } : {}),
    task_summary: `task ${id}`,
    model: "openai/gpt-x",
    ...extra,
  };
}

const rootOc = "ses_root";
const registry: Registry = { [rootOc]: { piSessionId: ROOT, title: "Plan the migration" } };

// plan -> (scan, audit in parallel) -> report, which names scan's id in its prompt; deep is a nested child of audit.
const tasks: TaskRecord[] = [
  task("st_plan0001", 0, 5),
  task("st_scan0001", 10, 20),
  task("st_audt0001", 10, undefined, { child_session_id: "audit-child-session" }),
  task("st_deep0001", 12, undefined, { parent_session_id: "audit-child-session", depth: 2, status: "queued" }),
  task("st_rprt0001", 30, undefined, { spawn_spec: { prompt: "Summarise agent://st_scan0001 and st_nope0000" } }),
  task("st_other001", 1, 2, { root_session_id: "another-root", parent_session_id: "another-root" }),
];

describe("buildGraph", () => {
  const g = buildGraph(rootOc, tasks, registry);
  const node = (id: string) => g.nodes.find((n) => n.id === id);

  test("collects only tasks of the session's run", () => {
    assert.equal(g.status, "ok");
    assert.equal(g.rootId, rootOc);
    assert.equal(g.title, "Plan the migration");
    assert.deepEqual(
      g.nodes.map((n) => n.id).sort(),
      [rootOc, "st_audt0001", "st_deep0001", "st_plan0001", "st_rprt0001", "st_scan0001"].sort(),
    );
  });

  test("spawn edges follow parent sessions, including nested children", () => {
    const spawn = g.edges.filter((e) => e.kind === "spawn").map((e) => `${e.from}>${e.to}`);
    assert.ok(spawn.includes(`${rootOc}>st_plan0001`));
    assert.ok(spawn.includes("st_audt0001>st_deep0001"));
    assert.equal(node("st_deep0001")?.parentId, "st_audt0001");
  });

  test("uses edges only for referenced tasks that exist in the run", () => {
    assert.deepEqual(
      g.edges.filter((e) => e.kind === "uses").map((e) => `${e.from}>${e.to}`),
      ["st_scan0001>st_rprt0001"],
    );
  });

  test("waves: siblings started after an earlier sibling finished move right", () => {
    assert.equal(node("st_plan0001")?.column, 1);
    assert.equal(node("st_scan0001")?.column, 2);
    assert.equal(node("st_audt0001")?.column, 2);
    assert.equal(node("st_deep0001")?.column, 3);
    assert.equal(node("st_rprt0001")?.column, 3);
    assert.deepEqual(
      g.columns.find((c) => c.column === 2),
      { column: 2, total: 2, done: 1, running: 1 },
    );
  });

  test("states and child session ids", () => {
    assert.equal(node("st_audt0001")?.state, "running");
    assert.equal(node("st_deep0001")?.state, "queued");
    assert.notEqual(node("st_plan0001")?.endedAt, undefined);
    assert.equal(node("st_scan0001")?.sessionId, ocIdFor("st_scan0001"));
    assert.equal(node(rootOc)?.state, "running");
  });

  test("opening a child session shows its whole run with the child focused", () => {
    const fromChild = buildGraph(ocIdFor("st_scan0001"), tasks, registry);
    assert.equal(fromChild.rootId, rootOc);
    assert.equal(fromChild.focusId, "st_scan0001");
    assert.equal(fromChild.nodes.length, g.nodes.length);
  });

  test("a root missing from the registry resolves through its md5 id", () => {
    const g2 = buildGraph(ocIdFor(ROOT), tasks, {});
    assert.equal(g2.status, "ok");
    assert.equal(g2.nodes.length, g.nodes.length);
  });

  test("unknown sessions are reported, not guessed", () => {
    assert.equal(buildGraph("ses_unknown", tasks, registry).status, "unknown-session");
  });
});

describe("nodeState", () => {
  test("maps OmO statuses onto display states", () => {
    assert.deepEqual(["running", "starting", "pending", "completed", "lost", "killed", "weird"].map(nodeState), [
      "running",
      "running",
      "queued",
      "completed",
      "failed",
      "cancelled",
      "idle",
    ]);
  });
});

describe("layoutGraph", () => {
  const g = buildGraph(rootOc, tasks, registry);
  const l = layoutGraph(g);

  test("cards never overlap and stay inside the canvas", () => {
    const boxes = [...l.boxes.values()];
    for (const [i, a] of boxes.entries()) {
      assert.ok(a.x + CARD_W <= l.width);
      assert.ok(a.y + CARD_H <= l.height);
      for (const b of boxes.slice(i + 1)) {
        const apart = a.x + CARD_W <= b.x || b.x + CARD_W <= a.x || a.y + CARD_H <= b.y || b.y + CARD_H <= a.y;
        assert.equal(apart, true);
      }
    }
  });

  test("every edge is routed from the source's right side to the target's left side", () => {
    assert.equal(l.edges.length, g.edges.length);
    for (const e of l.edges) {
      assert.equal(e.sx, (l.boxes.get(e.from)?.x ?? NaN) + CARD_W);
      assert.equal(e.tx, l.boxes.get(e.to)?.x ?? NaN);
    }
  });

  test("edges sharing a side get distinct ports", () => {
    const out = l.edges.filter((e) => e.from === rootOc).map((e) => e.sy);
    assert.equal(new Set(out).size, out.length);
  });

  test("reach walks upstream and downstream transitively", () => {
    assert.deepEqual([...reach(g.edges, "st_deep0001", "up")].sort(), [rootOc, "st_audt0001"].sort());
    assert.deepEqual([...reach(g.edges, "st_scan0001", "down")], ["st_rprt0001"]);
  });
});
