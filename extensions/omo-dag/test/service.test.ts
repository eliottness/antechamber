import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, MAX_GRAPH_BODY_CHARS } from "../src/service.ts";
import type { TaskGraph } from "../src/graph.ts";
import { TaskStore } from "../src/store.ts";

const TOKEN = "test-token";
let dir: string;
let base: string;
let server: ReturnType<typeof createServer>;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "omo-dag-"));
  const tasks = join(dir, "agent", "projects", "demo-1234", "senpi-task", "tasks");
  mkdirSync(tasks, { recursive: true });
  mkdirSync(join(dir, "state"), { recursive: true });
  writeFileSync(
    join(tasks, "st_aaaa0001.json"),
    JSON.stringify({
      task_id: "st_aaaa0001",
      status: "running",
      parent_session_id: "root-pi",
      root_session_id: "root-pi",
      created_at: "2026-10-13T12:00:00Z",
      task_summary: "Survey the code",
    }),
  );
  writeFileSync(join(tasks, "broken.json"), "{ not json");
  writeFileSync(
    join(tasks, "st_bbbb0001.json"),
    JSON.stringify({
      task_id: "st_bbbb0001",
      status: 7,
      parent_session_id: "root-pi",
      root_session_id: "root-pi",
      created_at: [],
      task_summary: { text: "not a string" },
      final_response: 42,
      spawn_spec: { prompt: 1 },
      run_stats: "x",
    }),
  );
  writeFileSync(
    join(tasks, "st_cccc0001.json"),
    JSON.stringify({ task_id: "st_cccc0001", root_session_id: 99, parent_session_id: null }),
  );
  writeFileSync(
    join(dir, "state", "sessions.json"),
    JSON.stringify({ ses_root: { piSessionId: "root-pi", title: "Demo run" } }),
  );
  server = createServer(TOKEN);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = (path: string, token = TOKEN) => fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });

describe("service", () => {
  test("retains task records with the same id in different parent sessions", (t) => {
    const root = mkdtempSync(join(tmpdir(), "omo-dag-collision-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const agent = join(root, "agent");
    for (const parent of ["first", "second"]) {
      const tasks = join(agent, "projects", parent, "senpi-task", "tasks");
      mkdirSync(tasks, { recursive: true });
      writeFileSync(
        join(tasks, "st_shared001.json"),
        JSON.stringify({ task_id: "st_shared001", parent_session_id: parent }),
      );
    }
    const store = new TaskStore({ agentDirs: [agent], stateDirs: [] });

    assert.deepEqual(
      store
        .loadTasks()
        .map((task) => task.parent_session_id)
        .sort(),
      ["first", "second"],
    );
  });

  test("retains a warm task during a torn write and refreshes it once JSON is valid", (t) => {
    const root = mkdtempSync(join(tmpdir(), "omo-dag-cache-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const agent = join(root, "agent");
    const tasks = join(agent, "projects", "cache", "senpi-task", "tasks");
    const task = join(tasks, "st_warm0001.json");
    mkdirSync(tasks, { recursive: true });
    writeFileSync(task, JSON.stringify({ task_id: "st_warm0001", status: "running" }));
    const store = new TaskStore({ agentDirs: [agent], stateDirs: [] });

    assert.equal(store.loadTasks()[0]?.status, "running");
    writeFileSync(task, "{ partial");
    assert.equal(store.loadTasks()[0]?.status, "running");
    writeFileSync(task, JSON.stringify({ task_id: "st_warm0001", status: "completed" }));
    assert.equal(store.loadTasks()[0]?.status, "completed");
  });

  test("bounds oversized graph responses and reports omitted nodes", async (t) => {
    const tasks = Array.from({ length: 3000 }, (_, index) => ({
      task_id: `st_large${String(index).padStart(6, "0")}`,
      status: "completed",
      parent_session_id: "root-pi",
      root_session_id: "root-pi",
      created_at: "2026-10-14T12:00:00Z",
      task_summary: `Task ${index}: ${"summary ".repeat(32)}`,
      final_response: "output ".repeat(160),
    }));
    const capped = createServer(TOKEN, () => {
      return {
        loadTasks: () => tasks,
        loadRegistry: () => ({ ses_root: { piSessionId: "root-pi", title: "Large run" } }),
      } as never;
    });
    t.after(
      () =>
        new Promise<void>((resolve, reject) => {
          capped.close((error) => (error ? reject(error) : resolve()));
        }),
    );
    await new Promise<void>((resolve, reject) => {
      capped.once("error", reject);
      capped.listen(0, "127.0.0.1", () => {
        capped.off("error", reject);
        resolve();
      });
    });
    const address = capped.address();
    if (address === null || typeof address === "string") throw new Error("service did not bind a TCP port");
    const response = await fetch(`http://127.0.0.1:${address.port}/graph?session=ses_root`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const body = await response.text();
    const graph = JSON.parse(body) as TaskGraph;

    assert.equal(response.status, 200);
    assert.ok(body.length <= MAX_GRAPH_BODY_CHARS);
    assert.ok(graph.truncated);
    assert.equal(graph.truncated.omittedNodes, tasks.length - (graph.nodes.length - 1));
  });

  test("rejects requests without the host token", async () => {
    assert.equal((await get("/health", "wrong")).status, 401);
  });

  test("answers health for the host readiness probe", async () => {
    assert.equal((await get("/health")).status, 200);
  });

  test("builds the graph from the given directories, skips torn files and ignores mistyped fields", async () => {
    const q = new URLSearchParams({ session: "ses_root", agentDir: join(dir, "agent"), stateDir: join(dir, "state") });
    const res = await get(`/graph?${q}`);
    assert.equal(res.status, 200);
    const graph = (await res.json()) as TaskGraph;
    assert.equal(graph.title, "Demo run");
    assert.deepEqual(graph.nodes.map((n) => n.id).sort(), ["ses_root", "st_aaaa0001", "st_bbbb0001"]);
    assert.equal(graph.nodes.find((n) => n.id === "st_aaaa0001")?.state, "running");
    const odd = graph.nodes.find((n) => n.id === "st_bbbb0001");
    assert.equal(odd?.title, "st_bbbb0001");
    assert.equal(odd?.state, "idle");
    assert.equal(odd?.summary, undefined);
  });

  test("validates the session id", async () => {
    assert.equal((await get("/graph?session=../etc")).status, 400);
    assert.equal((await get("/nope")).status, 404);
  });
});
