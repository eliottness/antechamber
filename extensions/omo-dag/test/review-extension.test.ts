import assert from "node:assert/strict";
import test from "node:test";
import { parseGraph } from "../src/poller.ts";

test("R-037: malformed graph node fields are rejected before rendering", () => {
  assert.throws(
    () =>
      parseGraph(
        JSON.stringify({
          status: "ok",
          rootId: "ses_root",
          focusId: "ses_root",
          title: "Root",
          models: 1,
          columns: [],
          edges: [],
          nodes: [
            {
              id: "ses_root",
              kind: "root",
              sessionId: "ses_root",
              title: "Root",
              state: "idle",
              rawStatus: "idle",
              column: 0,
              wave: 0,
              costUsd: "not-a-number",
            },
          ],
        }),
      ),
    /unexpected graph shape/,
  );
});

test("R-036: task scanning skips task directories and symlinks outside its configured roots", {
  skip: process.platform !== "linux",
}, async (t) => {
  const fs = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { TaskStore } = await import("../src/store.ts");
  const root = fs.mkdtempSync(join(tmpdir(), "omo-dag-review-edge-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agent = join(root, "agent");
  const tasks = join(agent, "projects", "review", "senpi-task", "tasks");
  const outside = join(root, "outside.json");
  fs.mkdirSync(tasks, { recursive: true });
  fs.writeFileSync(join(tasks, "valid.json"), JSON.stringify({ task_id: "st_valid0001" }));
  fs.mkdirSync(join(tasks, "broken.json"));
  fs.writeFileSync(outside, JSON.stringify({ task_id: "st_outside0001" }));
  fs.symlinkSync(outside, join(tasks, "outside.json"));
  const store = new TaskStore({ agentDirs: [agent], stateDirs: [] });
  let records: Array<{ task_id: string }> = [];

  assert.doesNotThrow(() => {
    records = store.loadTasks();
  });

  assert.deepEqual(records.map((record) => record.task_id).sort(), ["st_valid0001"]);
});

test("R-038: equivalent root spellings reuse one TaskStore cache entry", async (t) => {
  const fs = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = fs.mkdtempSync(join(tmpdir(), "omo-dag-review-edge-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const NativeMap = globalThis.Map;
  const observed: Array<Map<unknown, unknown>> = [];
  class ObservedMap<K, V> extends NativeMap<K, V> {
    constructor(entries?: Iterable<readonly [K, V]> | null) {
      super(entries);
      observed.push(this as unknown as Map<unknown, unknown>);
    }
  }
  globalThis.Map = ObservedMap as unknown as MapConstructor;
  const marker = Symbol("review-edge-store");
  try {
    const { createServer } = await import("../src/service.ts");
    const server = createServer("review-edge-token", () => {
      return {
        marker,
        loadTasks: () => [],
        loadRegistry: () => ({}),
      } as never;
    });
    t.after(
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    );
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("service did not bind a TCP port");
    const base = `http://127.0.0.1:${address.port}`;
    const agent = join(root, "agent");
    const state = join(root, "state");

    for (const variant of [agent, `${agent}/.`, `${agent}/./`, `${agent}/nested/..`]) {
      const query = new URLSearchParams({ session: "ses_review", agentDir: variant, stateDir: state });
      assert.equal(
        (await fetch(`${base}/graph?${query}`, { headers: { Authorization: "Bearer review-edge-token" } })).status,
        200,
      );
    }

    const cache = observed.find(
      (candidate) =>
        candidate.size > 0 &&
        [...candidate.values()].every(
          (value) => typeof value === "object" && value !== null && (value as { marker?: symbol }).marker === marker,
        ),
    );
    assert.ok(cache, "TaskStore cache was not observed");
    assert.equal(cache.size, 1);
  } finally {
    globalThis.Map = NativeMap;
  }
});
