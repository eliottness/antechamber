import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { TaskGraph } from "../src/graph.ts";
import { GraphPoller, POLL_ERROR_MS, POLL_IDLE_MS, type PollView } from "../src/poller.ts";

type Reply = { status: number; body: string };

function graphBody(rootId: string, state: "running" | "completed" = "completed"): string {
  const graph: TaskGraph = {
    status: "ok",
    rootId,
    focusId: rootId,
    title: rootId,
    models: 1,
    columns: [],
    nodes: [
      {
        id: rootId,
        kind: "root",
        sessionId: rootId,
        title: rootId,
        state: "idle",
        rawStatus: "orchestrator",
        column: 0,
        wave: 0,
      },
      {
        id: "st_a",
        kind: "task",
        sessionId: "ses_a",
        title: "a",
        state,
        rawStatus: state,
        column: 1,
        wave: 0,
        parentId: rootId,
      },
    ],
    edges: [{ id: "e", from: rootId, to: "st_a", kind: "spawn" }],
  };
  return JSON.stringify(graph);
}

function harness() {
  const requests: { sessionId: string; resolve: (r: Reply) => void; reject: (e: unknown) => void }[] = [];
  const views: PollView[] = [];
  let scheduled: { ms: number; run: () => void } | undefined;
  const poller = new GraphPoller({
    fetch: (sessionId) =>
      new Promise<Reply>((resolve, reject) => {
        requests.push({ sessionId, resolve, reject });
      }),
    show: (view) => {
      views.push(view);
    },
    schedule: (ms, run) => {
      scheduled = { ms, run };
    },
    isHidden: () => false,
  });
  const settle = () => new Promise<void>((done) => setImmediate(done));
  const shown = () => views.map((v) => (v.kind === "graph" ? `graph:${v.graph.rootId}` : v.kind));
  return { poller, requests, views, shown, settle, scheduled: () => scheduled };
}

describe("GraphPoller", () => {
  test("a session switch during an in-flight request drops the stale answer and fetches the new session", async () => {
    const h = harness();
    h.poller.setSession("ses_one");
    h.poller.setSession("ses_two");
    assert.deepEqual(
      h.requests.map((r) => r.sessionId),
      ["ses_one"],
    );

    h.requests[0]?.resolve({ status: 200, body: graphBody("ses_one") });
    await h.settle();
    assert.deepEqual(
      h.requests.map((r) => r.sessionId),
      ["ses_one", "ses_two"],
    );
    assert.deepEqual(h.shown(), []);

    h.requests[1]?.resolve({ status: 200, body: graphBody("ses_two") });
    await h.settle();
    assert.deepEqual(h.shown(), ["graph:ses_two"]);
  });

  test("a stale failure does not replace the new session's view", async () => {
    const h = harness();
    h.poller.setSession("ses_one");
    h.poller.setSession("ses_two");
    h.requests[0]?.reject(new Error("boom"));
    await h.settle();
    assert.deepEqual(h.shown(), []);
    assert.equal(h.requests[1]?.sessionId, "ses_two");
  });

  test("success, error, then the same success renders the graph again", async () => {
    const h = harness();
    const body = graphBody("ses_one");
    h.poller.setSession("ses_one");
    h.requests[0]?.resolve({ status: 200, body });
    await h.settle();
    assert.equal(h.scheduled()?.ms, POLL_IDLE_MS);

    h.scheduled()?.run();
    h.requests[1]?.resolve({ status: 502, body: "down" });
    await h.settle();
    assert.equal(h.scheduled()?.ms, POLL_ERROR_MS);

    h.scheduled()?.run();
    h.requests[2]?.resolve({ status: 200, body });
    await h.settle();
    assert.deepEqual(h.shown(), ["graph:ses_one", "error", "graph:ses_one"]);
  });

  test("a 200 answer with the wrong shape shows the error view", async () => {
    const h = harness();
    h.poller.setSession("ses_one");
    h.requests[0]?.resolve({ status: 200, body: JSON.stringify({ status: "ok", nodes: "nope" }) });
    await h.settle();
    assert.deepEqual(h.shown(), ["error"]);
    assert.equal(h.scheduled()?.ms, POLL_ERROR_MS);
  });

  test("an unchanged body is not re-rendered", async () => {
    const h = harness();
    const body = graphBody("ses_one", "running");
    h.poller.setSession("ses_one");
    h.requests[0]?.resolve({ status: 200, body });
    await h.settle();
    h.scheduled()?.run();
    h.requests[1]?.resolve({ status: 200, body });
    await h.settle();
    assert.deepEqual(h.shown(), ["graph:ses_one"]);
  });

  test("starting with no open session shows the no-session view", () => {
    const h = harness();
    h.poller.setSession(null);
    assert.deepEqual(h.shown(), ["no-session"]);
    assert.equal(h.requests.length, 0);
  });

  test("refresh before any session is known does nothing", async () => {
    const h = harness();
    await h.poller.refresh();
    assert.deepEqual(h.shown(), []);
    assert.equal(h.requests.length, 0);
  });

  test("clearing the session shows the no-session view", () => {
    const h = harness();
    h.poller.setSession("ses_one");
    h.poller.setSession(null);
    assert.deepEqual(h.shown(), ["no-session"]);
  });
});
