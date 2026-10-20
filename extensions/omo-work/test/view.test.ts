import assert from "node:assert/strict";
import { test } from "node:test";
import { isActive, parseWorkStatus, type TodoPhase, type WorkStatus } from "../src/model.ts";
import { cellMeta, focusPhase, formatDuration, monitorMeta, monitorTone, summarizePhase } from "../src/view.ts";

const monitor = {
  id: "bash_7",
  description: "wait for the build",
  command: "tail -F build.log",
  filter: null,
  paused: false,
  persistent: false,
  startedAtMs: 0,
  deadlineMs: null,
  fireCount: 1,
  lastFiredAtMs: null,
};

const empty: WorkStatus = {
  version: 1,
  sessionID: "ses_a",
  live: true,
  generatedAt: 0,
  todo: [],
  monitors: [],
  evalCells: [],
  evalCellsListed: true,
  background: [],
  goal: null,
  wakeSources: [],
};

test("durations stay short at every scale", () => {
  assert.equal(formatDuration(-5), "0s");
  assert.equal(formatDuration(59_999), "59s");
  assert.equal(formatDuration(61_000), "1m 01s");
  assert.equal(formatDuration(3_660_000), "1h 01m");
  assert.equal(formatDuration(90_000_000), "1d 1h");
});

test("phases count live tasks and open on the one in progress, else the first unfinished", () => {
  const phases: TodoPhase[] = [
    { name: "Done", tasks: [{ content: "a", status: "completed" }] },
    {
      name: "Next",
      tasks: [
        { content: "b", status: "pending" },
        { content: "c", status: "cancelled" },
      ],
    },
    { name: "Later", tasks: [{ content: "d", status: "pending" }] },
  ];
  assert.deepEqual(summarizePhase(phases[1]!), { name: "Next", done: 0, total: 1, finished: false, tone: "idle" });
  assert.equal(summarizePhase(phases[0]!).tone, "ok");
  assert.equal(focusPhase(phases), 1);
  const running = [...phases];
  running[2] = { name: "Later", tasks: [{ content: "d", status: "in_progress" }] };
  assert.equal(focusPhase(running), 2);
  assert.equal(summarizePhase(running[2]!).current, "d");
});

test("monitor rows read as watching, paused or how they ended", () => {
  assert.equal(monitorMeta({ monitor, lines: [] }, 65_000), "watching 1m 05s · 1 event");
  assert.equal(monitorTone({ monitor: { ...monitor, paused: true }, lines: [] }), "warn");
  const failed = {
    monitor: { ...monitor, fireCount: 3 },
    ending: { reason: "exit", exitCode: 2, endedAtMs: 5, label: "command exited with code 2" },
    lines: [],
  };
  assert.equal(monitorTone(failed), "bad");
  assert.equal(monitorMeta(failed, 10), "command exited with code 2 · 3 events");
});

test("cell rows show elapsed time only while the cell runs", () => {
  assert.equal(cellMeta({ cellId: "c", language: "py", state: "running", startedAtMs: 0 }, 2_000), "py · running · 2s");
  assert.equal(cellMeta({ cellId: "c", state: "completed", startedAtMs: 0 }, 2_000), "completed");
});

test("the snapshot parser rejects other shapes and activity keeps polling fast", () => {
  assert.throws(() => parseWorkStatus('{"version":2}'), /unexpected work-status shape/);
  const status = parseWorkStatus(JSON.stringify(empty));
  assert.equal(isActive(status), false);
  assert.equal(isActive({ ...status, evalCells: [{ cellId: "c", state: "queued" }] }), true);
  assert.equal(isActive({ ...status, monitors: [{ monitor, lines: [] }] }), true);
});
