import assert from "node:assert/strict";
import { test } from "node:test";
import { isActive, parseWorkStatus, type TodoPhase, type WorkStatus } from "../src/model.ts";
import { focusPhase, formatDuration, isEmpty, summarizePhase } from "../src/view.ts";

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

test("the snapshot parser rejects other shapes and activity keeps polling fast", () => {
  assert.throws(() => parseWorkStatus('{"version":2}'), /unexpected work-status shape/);
  const status = parseWorkStatus(JSON.stringify(empty));
  assert.equal(isActive(status), false);
  assert.equal(isActive({ ...status, goal: { armed: true, dueAtMs: 5 } }), true);
  assert.equal(isActive({ ...status, wakeSources: [{ source: "loop-guard", activeCount: 1, items: [] }] }), true);
});

test("background commands are OpenChamber's to show: they neither fill the section nor keep it polling", () => {
  const busy = {
    ...empty,
    monitors: [{ monitor, lines: [] }],
    evalCells: [{ cellId: "c", state: "running" }],
    background: [{ id: "bash_3", command: "npm run dev", startedAtMs: 0 }],
  };
  assert.equal(isEmpty(busy), true);
  assert.equal(isActive(busy), false);
  assert.equal(isEmpty({ ...empty, goal: { armed: false } }), false);
});
