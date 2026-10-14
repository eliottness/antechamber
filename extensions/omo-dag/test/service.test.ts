import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/service.ts";
import type { TaskGraph } from "../src/graph.ts";

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
