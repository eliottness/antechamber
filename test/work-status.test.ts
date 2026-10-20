import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { openEvents } from "./bug-harness.js";
import { MONITOR_STATE_EVENT } from "../src/monitor-sessions.js";
import { AdapterServer } from "../src/server.js";
import { ocIdFor } from "../src/session-store.js";
import type { ManagedSession, SessionManager } from "../src/sessions.js";
import type { WorkStatus } from "../src/work-status.js";

const monitor = {
  id: "bash_7",
  description: "wait for the build",
  paused: false,
  startedAtMs: 1_760_000_000_000,
  command: "tail -F build.log",
  filter: "^DONE$",
  persistent: false,
  deadlineMs: 1_760_000_600_000,
  fireCount: 2,
  lastFiredAtMs: 1_760_000_001_000,
};

async function startServer(t: TestContext, password?: string) {
  const directory = mkdtempSync(join(tmpdir(), "antechamber-work-status-"));
  const saved = new Map(
    ["ANTECHAMBER_PI_BINARY", "ANTECHAMBER_STATE_DIR", "PI_CODING_AGENT_DIR", "OPENCODE_SERVER_PASSWORD"].map((key) => [
      key,
      process.env[key],
    ]),
  );
  process.env.ANTECHAMBER_PI_BINARY = resolve("test/fixtures/turn-omo.mjs");
  process.env.ANTECHAMBER_STATE_DIR = join(directory, "state");
  process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
  if (password !== undefined) process.env.OPENCODE_SERVER_PASSWORD = password;
  const server = new AdapterServer({ host: "127.0.0.1", port: 0, defaultDirectory: directory });
  t.after(async () => {
    await server.stop();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  await server.start();
  const manager = (server as unknown as { sessions: SessionManager }).sessions;
  return { server, manager, url: server.url };
}

async function emit(s: ManagedSession, frame: Record<string, unknown>): Promise<void> {
  assert.ok(s.pi);
  // The fake agent writes the frame before its reply, so the frame is handled once this resolves.
  const reply = await s.pi.command({ type: "emit", frame });
  assert.equal(reply.success, true);
}

const extensionEvent = (name: string, data: unknown) => ({ type: "extension_event", name, data });

test("the work-status route reports todo phases, monitors, eval cells, background sessions and the goal timer", async (t) => {
  const { server, manager, url } = await startServer(t, "secret");
  const basic = `Basic ${Buffer.from("opencode:secret").toString("base64")}`;
  const created = await fetch(`${url}/session`, { method: "POST", body: "{}", headers: { Authorization: basic } });
  assert.equal(created.status, 200);
  const { id } = (await created.json()) as { id: string };
  const s = manager.get(id);
  assert.ok(s?.pi && s.piPath && s.piSessionId);

  await emit(s, extensionEvent(MONITOR_STATE_EVENT, { activeCount: 1, monitors: [monitor] }));
  // Matched lines arrive only in this hidden custom message (raw RPC capture, omo-ai 5.1.33).
  const notification = {
    role: "custom",
    customType: "senpi-monitor:notification",
    content: "<system-reminder>Monitor event(wait for the build): DONE</system-reminder>",
    display: false,
    details: { monitors: [{ id: "bash_7", description: monitor.description, eventCount: 1, kinds: ["line"] }] },
    timestamp: monitor.startedAtMs + 1_000,
  };
  await emit(s, { type: "message_start", message: notification });
  await emit(s, { type: "message_end", message: notification });
  // senpi-codemode/src/index.ts publishes its detached cells as a wake source over RPC.
  await emit(
    s,
    extensionEvent("wake_source_state", {
      source: "senpi-codemode",
      activeCount: 1,
      items: [{ id: "cell_1", description: "build the docs", startedAtMs: 1_760_000_002_000 }],
    }),
  );
  await emit(s, extensionEvent("wake_source_state", { source: "loop-guard", activeCount: 1 }));
  await emit(
    s,
    extensionEvent("goal_continuation_scheduled", {
      goalId: "g1",
      dueAtMs: 1_760_000_100_000,
      wakeSources: { "senpi-codemode": 1, "terminal-monitors": 1 },
    }),
  );
  await emit(
    s,
    extensionEvent("goal_continuation_timer_state", { armed: true, kind: "monitor", dueAtMs: 1_760_000_100_000 }),
  );
  await emit(s, {
    type: "entry_appended",
    entry: {
      type: "custom",
      customType: "senpi.todo-state",
      data: {
        phases: [
          { name: "Investigation", tasks: [{ content: "Read the code", status: "completed" }] },
          {
            name: "Implementation",
            tasks: [
              { content: "Write the route", status: "in_progress" },
              { content: "Drop the old path", status: "abandoned" },
            ],
          },
        ],
      },
    },
  });
  await s.pi.command({
    type: "set_eval_cells",
    cells: [
      {
        cellId: "cell_1",
        language: "js",
        state: "running",
        startedAtMs: 1_760_000_002_000,
        summary: "build the docs",
        outputTail: "step 1\nstep 2\n",
      },
    ],
  });
  // terminal/terminal-manifest.js: <session dir>/extensions/terminal/<encoded session id>.json.
  const manifest = join(dirname(s.piPath), "extensions", "terminal", `${encodeURIComponent(s.piSessionId)}.json`);
  mkdirSync(dirname(manifest), { recursive: true });
  writeFileSync(
    manifest,
    JSON.stringify({
      version: 1,
      sessionId: s.piSessionId,
      monitors: [],
      backgroundSessions: [
        { id: "bash_3", command: "npm run dev", startedAtMs: 1_760_000_003_000, runtime: { pid: process.pid } },
        { id: "bash_4", command: "gone", startedAtMs: 1_760_000_004_000, runtime: { pid: 2 ** 30 } },
      ],
    }),
  );

  const route = `${url}/antechamber/work-status/${id}`;
  const bearer = { Authorization: `Bearer ${server.extensionToken}` };
  assert.equal((await fetch(route)).status, 401);
  assert.equal((await fetch(route, { headers: { Authorization: "Bearer wrong" } })).status, 401);
  assert.equal(
    (await fetch(`${url}/session`, { headers: bearer })).status,
    401,
    "the token opens only antechamber routes",
  );
  assert.equal((await fetch(route, { headers: { Authorization: basic } })).status, 200);

  const response = await fetch(route, { headers: bearer });
  assert.equal(response.status, 200);
  const status = (await response.json()) as WorkStatus;
  assert.equal(status.live, true);
  assert.deepEqual(status.todo, [
    { name: "Investigation", tasks: [{ content: "Read the code", status: "completed" }] },
    {
      name: "Implementation",
      tasks: [
        { content: "Write the route", status: "in_progress" },
        { content: "Drop the old path", status: "cancelled" },
      ],
    },
  ]);
  assert.equal(status.monitors.length, 1);
  assert.equal(status.monitors[0]?.monitor.description, "wait for the build");
  assert.equal(status.monitors[0]?.ending, undefined);
  assert.deepEqual(status.monitors[0]?.lines, ["DONE"]);
  assert.equal(status.evalCellsListed, true);
  assert.deepEqual(status.evalCells, [
    { cellId: "cell_1", language: "js", state: "running", startedAtMs: 1_760_000_002_000, summary: "build the docs" },
  ]);
  assert.deepEqual(status.background, [
    { id: "bash_3", command: "npm run dev", startedAtMs: 1_760_000_003_000, pid: process.pid },
  ]);
  assert.deepEqual(status.goal, {
    armed: true,
    kind: "monitor",
    dueAtMs: 1_760_000_100_000,
    wakeSources: { "senpi-codemode": 1, "terminal-monitors": 1 },
  });
  assert.deepEqual(
    status.wakeSources.map((source) => source.source),
    ["loop-guard"],
  );

  const peek = await fetch(`${route}/eval/cell_1?tailBytes=7`, { headers: bearer });
  assert.equal(peek.status, 200);
  assert.equal(((await peek.json()) as { outputTail: string }).outputTail, "step 2\n");
  const stop = await fetch(`${route}/eval/cell_1/stop`, { method: "POST", headers: bearer });
  assert.equal(stop.status, 200);
  assert.equal(((await stop.json()) as { state: string }).state, "cancelled");
  assert.equal((await fetch(`${route}/eval/nope`, { headers: bearer })).status, 404);
  assert.equal((await fetch(`${url}/antechamber/work-status/not-a-session`, { headers: bearer })).status, 400);

  assert.equal((await fetch(`${route}/goal/fire`, { method: "POST", headers: bearer })).status, 204);
  const inspected = await s.pi.command<{ firedGoal: number }>({ type: "inspect" });
  assert.equal(inspected.data?.firedGoal, 1);
});

test("without codemode the section still shows the cells the wake source names", async (t) => {
  const { server, manager, url } = await startServer(t);
  const created = await fetch(`${url}/session`, { method: "POST", body: "{}" });
  const { id } = (await created.json()) as { id: string };
  const s = manager.get(id);
  assert.ok(s?.pi);
  await emit(
    s,
    extensionEvent("wake_source_state", {
      source: "senpi-codemode",
      activeCount: 1,
      items: [{ id: "cell_9", description: "long build", startedAtMs: 5 }],
    }),
  );
  const response = await fetch(`${url}/antechamber/work-status/${id}`, {
    headers: { Authorization: `Bearer ${server.extensionToken}` },
  });
  const status = (await response.json()) as WorkStatus;
  assert.equal(status.evalCellsListed, false);
  assert.deepEqual(status.evalCells, [{ cellId: "cell_9", state: "running", startedAtMs: 5, summary: "long build" }]);
});

test("monitor child sessions stay on v1 and are hidden from v2 lists and events", async (t) => {
  const { manager, url } = await startServer(t);
  const created = await fetch(`${url}/session`, { method: "POST", body: "{}" });
  const { id } = (await created.json()) as { id: string };
  const s = manager.get(id);
  assert.ok(s?.pi);
  const v1 = await openEvents(`${url}/event`);
  const v2 = await openEvents(`${url}/api/event`);
  t.after(async () => {
    await v1.close();
    await v2.close();
  });
  const childID = ocIdFor(`${id}/monitor/bash_7`);
  const v1Created = v1.wait(
    (event) =>
      event.type === "session.created" && (event.properties as { info?: { id?: string } }).info?.id === childID,
  );
  await emit(s, extensionEvent(MONITOR_STATE_EVENT, { activeCount: 1, monitors: [monitor] }));
  await v1Created;

  // Events are written in order: once a later session reaches v2, the monitor's frames would have too.
  const marker = v2.wait((event) => event.type === "session.created");
  const other = await fetch(`${url}/api/session`, { method: "POST", body: "{}" });
  assert.equal(other.status, 200);
  await marker;
  const mentionsChild = (event: Record<string, unknown>) => JSON.stringify(event).includes(childID);
  assert.equal(v2.frames.filter(mentionsChild).length, 0);
  assert.ok(v1.frames.some(mentionsChild));

  const v1List = (await (await fetch(`${url}/session`)).json()) as Array<{ id: string }>;
  assert.ok(v1List.some((session) => session.id === childID));
  const v2List = (await (await fetch(`${url}/api/session`)).json()) as { data: Array<{ id: string }> };
  assert.ok(v2List.data.some((session) => session.id === id));
  assert.ok(!v2List.data.some((session) => session.id === childID));
  const active = (await (await fetch(`${url}/api/session/active`)).json()) as { data: Record<string, unknown> };
  assert.equal(active.data[childID], undefined);
});

function rawGet(url: string, path: string, authorization: string): Promise<number> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    // node:http sends the path as written; fetch would resolve the dot segments client-side.
    const req = request({ hostname, port, path, headers: { authorization } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.once("error", reject);
    req.end();
  });
}

test("the run-record token opens no route outside work-status, whatever the path spelling", async (t) => {
  const { server, url } = await startServer(t, "secret");
  const bearer = `Bearer ${server.extensionToken}`;
  for (const path of [
    "/antechamber/../session",
    "/antechamber/work-status/../../session",
    "/antechamber/work-status/%2e%2e/%2e%2e/api/session",
    "/antechamber/work-status/..\\..\\config",
    "/antechamber/x",
  ])
    assert.equal(await rawGet(url, path, bearer), 401, path);
  assert.equal(await rawGet(url, "/antechamber/work-status/ses_unknown", bearer), 404);
});
