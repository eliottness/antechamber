import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test, { type TestContext } from "node:test";
import { AdapterServer } from "../src/server.js";

function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "antechamber-latency-"));
  const saved = new Map(
    [
      "ANTECHAMBER_STATE_DIR",
      "PI_CODING_AGENT_DIR",
      "ANTECHAMBER_SLOW_REQUEST_MS",
      "ANTECHAMBER_EVENT_LOOP_LAG_MS",
    ].map((key) => [key, process.env[key]]),
  );
  process.env.ANTECHAMBER_STATE_DIR = join(root, "state");
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  return t.mock.method(console, "warn", () => {});
}

test("slow HTTP warnings include route patterns and status without query or path secrets", async (t) => {
  const warnings = setup(t);
  process.env.ANTECHAMBER_SLOW_REQUEST_MS = "10";
  let time = 0;
  t.mock.method(performance, "now", () => (time += 50));
  const server = new AdapterServer({ host: "127.0.0.1", port: 0, defaultDirectory: "/synthetic" });
  await server.start();
  t.after(() => server.stop());

  const response = await fetch(`${server.url}/api/session/secret-session/message/secret-message?token=query-secret`);
  const unknown = await fetch(`${server.url}/secret-path?token=secret`);

  assert.equal(response.status, 404);
  assert.equal(unknown.status, 404);
  const lines = warnings.mock.calls.map((call) => call.arguments.join(" "));
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /method=GET route=\/api\/session\/:sessionID\/message\/:messageID status=404 duration_ms=50/);
  assert.match(lines[1]!, /route=unmatched status=404/);
  assert.ok(lines.every((line) => !line.includes("secret")));
});

test("loop lag warns once per blocked interval and stops with the server", async (t) => {
  const warnings = setup(t);
  process.env.ANTECHAMBER_EVENT_LOOP_LAG_MS = "250";
  let time = 0;
  t.mock.method(performance, "now", () => time);
  t.mock.timers.enable({ apis: ["setInterval"] });
  const server = new AdapterServer({ host: "127.0.0.1", port: 0, defaultDirectory: "/synthetic" });
  await server.start();
  let stopped = false;
  t.after(() => (stopped ? undefined : server.stop()));

  time = 500;
  t.mock.timers.tick(100);
  time = 600;
  t.mock.timers.tick(100);
  assert.deepEqual(
    warnings.mock.calls.map((call) => call.arguments.join(" ")),
    ["[latency] event-loop-lag duration_ms=400 threshold_ms=250"],
  );
  await server.stop();
  stopped = true;
  time = 5000;
  t.mock.timers.tick(100);
  assert.equal(warnings.mock.callCount(), 1);
});
