import assert from "node:assert/strict";
import childProcess, { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import { COMPACT_RPC_TIMEOUT_MS, PiRpcClient, RPC_COMMAND_TIMEOUT_MS } from "../src/pi-rpc.js";

function transport(t: TestContext) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = Object.assign(new ChildProcess(), { stdin, stdout, stderr });
  const kill = t.mock.method(proc, "kill", () => {
    proc.emit("exit", null, "SIGKILL");
    return true;
  });
  t.mock.method(childProcess, "spawn", () => proc);
  syncBuiltinESMExports();
  const pi = new PiRpcClient({ cwd: process.cwd() });
  t.after(async () => {
    await pi.dispose();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return { pi, proc, stdin, stdout, stderr, kill };
}

for (const fields of [
  { success: "yes" },
  { success: undefined },
  { success: true, command: 12 },
  { success: false, error: {} },
])
  test("rejects malformed correlated RPC responses", { timeout: 5_000 }, async (t) => {
    const { pi, stdin, stdout } = transport(t);
    const logged = t.mock.method(console, "error", () => {});
    const sent = once(stdin, "data", { signal: AbortSignal.timeout(1_000) });
    const pending = pi.command({ type: "get_state" }, 1_000);
    const [chunk] = await sent;
    const command = JSON.parse(String(chunk));
    const rejected = assert.rejects(pending, /malformed.*response/i);
    stdout.write(JSON.stringify({ type: "response", id: command.id, command: "get_state", ...fields }) + "\n");
    await rejected;
    assert.equal(pi.isBusy, false);
    assert.equal(logged.mock.callCount(), 1);
  });

test("ignores non-object JSON and invalid response IDs without losing valid frames", async (t) => {
  const { pi, stdin, stdout } = transport(t);
  t.mock.method(console, "error", () => {});
  const sent = once(stdin, "data", { signal: AbortSignal.timeout(1_000) });
  const pending = pi.command({ type: "get_state" }, 1_000);
  const [chunk] = await sent;
  const command = JSON.parse(String(chunk));
  stdout.write('null\n[]\n{"type":"response","id":12,"command":"get_state","success":true}\n');
  stdout.write(
    JSON.stringify({ type: "response", id: command.id, command: "get_state", success: true, data: "valid" }) + "\n",
  );
  assert.equal((await pending).data, "valid");
});

test("kills oversized unterminated frames and rejects all pending commands", async (t) => {
  const { pi, stdout, kill } = transport(t);
  t.mock.method(console, "error", () => {});
  const first = pi.command({ type: "get_state" }, 1_000);
  const second = pi.command({ type: "get_entries" }, 1_000);
  const rejected = Promise.all([
    assert.rejects(first, /JSONL frame.*67108864/),
    assert.rejects(second, /JSONL frame.*67108864/),
  ]);
  stdout.write(Buffer.alloc(64 * 1024 * 1024 + 1, "x"));
  await rejected;
  assert.equal(kill.mock.callCount(), 1);
  assert.equal(pi.isBusy, false);
  await assert.rejects(pi.command({ type: "get_state" }), /not running/);
});

for (const debug of [false, true])
  test(`process exit stderr is ${debug ? "visible in debug" : "private by default"}`, async (t) => {
    const previous = process.env.ANTECHAMBER_DEBUG;
    if (debug) process.env.ANTECHAMBER_DEBUG = "1";
    else delete process.env.ANTECHAMBER_DEBUG;
    t.after(() => {
      if (previous === undefined) delete process.env.ANTECHAMBER_DEBUG;
      else process.env.ANTECHAMBER_DEBUG = previous;
    });
    const { proc, stderr } = transport(t);
    const logged = t.mock.method(console, "error", () => {});
    stderr.write("private provider credentials");
    proc.emit("exit", 0, null);
    const output = logged.mock.calls.map((call) => call.arguments.join(" ")).join("\n");
    assert.match(output, /code=0 signal=null/);
    assert.equal(output.includes("private provider credentials"), debug);
  });

for (const [start, end] of [
  ["agent_start", "agent_idle"],
  ["auto_retry_start", "agent_idle"],
  ["compaction_start", "compaction_end"],
])
  test(`prompt admission survives ${start} beyond the ordinary command deadline`, async (t) => {
    const { pi, stdin, stdout } = transport(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    t.mock.method(console, "error", () => {});
    const sent = once(stdin, "data", { signal: AbortSignal.timeout(1_000) });
    const pending = pi.command({ type: "prompt", message: "continue", streamingBehavior: "steer" });
    const settled = pending.then(
      (response) => ({ response }),
      (error: unknown) => ({ error }),
    );
    const [chunk] = await sent;
    const command = JSON.parse(String(chunk));
    stdout.write(`${JSON.stringify({ type: start })}\n`);
    t.mock.timers.tick(RPC_COMMAND_TIMEOUT_MS + 1);
    assert.equal(pi.isBusy, true);
    stdout.write(`${JSON.stringify({ type: end })}\n`);
    const reply = {
      type: "response",
      id: command.id,
      command: "prompt",
      success: true,
      data: { disposition: "started" },
    };
    stdout.write(`${JSON.stringify(reply)}\n`);
    const result = await settled;
    assert.ok("response" in result);
    assert.equal(result.response.success, true);
    t.mock.timers.tick(COMPACT_RPC_TIMEOUT_MS + RPC_COMMAND_TIMEOUT_MS);
    stdin.once("data", (next) => {
      const request = JSON.parse(String(next));
      stdout.write(`${JSON.stringify({ type: "response", id: request.id, command: request.type, success: true })}\n`);
    });
    assert.equal((await pi.command({ type: "get_state" })).success, true);
  });

test("prompt admission resumes the ordinary deadline when active work settles", async (t) => {
  const { pi, stdout } = transport(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "error", () => {});
  stdout.write('{"type":"agent_start"}\n');
  const pending = pi.command({ type: "prompt", message: "continue", streamingBehavior: "steer" });
  const rejected = assert.rejects(pending, /pi command "prompt" timed out after 60000ms/);
  t.mock.timers.tick(RPC_COMMAND_TIMEOUT_MS + 1);
  assert.equal(pi.isBusy, true);
  stdout.write('{"type":"agent_end"}\n');
  t.mock.timers.tick(RPC_COMMAND_TIMEOUT_MS);
  await rejected;
  await assert.rejects(pi.command({ type: "get_state" }), /not running/);
});

test("active work cannot extend prompt admission indefinitely", async (t) => {
  const { pi, stdout } = transport(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "error", () => {});
  const pending = pi.command({ type: "prompt", message: "continue", streamingBehavior: "steer" });
  const maximum = COMPACT_RPC_TIMEOUT_MS + RPC_COMMAND_TIMEOUT_MS;
  const rejected = assert.rejects(pending, new RegExp(`pi command "prompt" timed out after ${maximum}ms`));
  for (let elapsed = 0; elapsed < maximum; elapsed += RPC_COMMAND_TIMEOUT_MS) {
    stdout.write('{"type":"agent_start"}\n');
    t.mock.timers.tick(RPC_COMMAND_TIMEOUT_MS);
  }
  await rejected;
  await assert.rejects(pi.command({ type: "get_state" }), /not running/);
});

for (const [command, timeout] of [
  [{ type: "get_state" }, undefined],
  [{ type: "prompt", message: "continue" }, RPC_COMMAND_TIMEOUT_MS],
] as const)
  test(`active work preserves the requested deadline for ${command.type}`, async (t) => {
    const { pi, stdout } = transport(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    t.mock.method(console, "error", () => {});
    stdout.write('{"type":"agent_start"}\n');
    const pending = pi.command(command, timeout);
    const rejected = assert.rejects(pending, new RegExp(`pi command "${command.type}" timed out after 60000ms`));
    t.mock.timers.tick(RPC_COMMAND_TIMEOUT_MS);
    await rejected;
    await assert.rejects(pi.command({ type: "get_state" }), /not running/);
  });

test("a silent prompt still closes the transport after the ordinary deadline", async (t) => {
  const { pi } = transport(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "error", () => {});
  const pending = pi.command({ type: "prompt", message: "continue" });
  const rejected = assert.rejects(pending, /pi command "prompt" timed out after 60000ms/);
  t.mock.timers.tick(RPC_COMMAND_TIMEOUT_MS);
  await rejected;
  await assert.rejects(pi.command({ type: "get_state" }), /not running/);
});

test("ending compaction does not resume the deadline while the agent is still active", async (t) => {
  const { pi, stdout } = transport(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "error", () => {});
  stdout.write('{"type":"agent_start"}\n{"type":"compaction_start"}\n');
  const pending = pi.command({ type: "prompt", message: "continue" });
  const rejected = assert.rejects(pending, /pi command "prompt" timed out after 60000ms/);
  stdout.write('{"type":"compaction_end"}\n');
  t.mock.timers.tick(RPC_COMMAND_TIMEOUT_MS + 1);
  assert.equal(pi.isBusy, true);
  stdout.write('{"type":"agent_idle"}\n');
  t.mock.timers.tick(RPC_COMMAND_TIMEOUT_MS);
  await rejected;
});

test("aborting prompt admission clears both deadlines without closing the transport", async (t) => {
  const { pi, stdin, stdout } = transport(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  const reason = new Error("cancelled");
  stdout.write('{"type":"compaction_start"}\n');
  const sent = once(stdin, "data", { signal: AbortSignal.timeout(1_000) });
  const pending = pi.command({ type: "prompt", message: "continue" }, undefined, controller.signal);
  const rejected = assert.rejects(pending, (error: unknown) => error === reason);
  await sent;
  controller.abort(reason);
  await rejected;
  t.mock.timers.tick(COMPACT_RPC_TIMEOUT_MS + RPC_COMMAND_TIMEOUT_MS);
  stdin.once("data", (chunk) => {
    const command = JSON.parse(String(chunk));
    stdout.write(`${JSON.stringify({ type: "response", id: command.id, command: "get_state", success: true })}\n`);
  });
  assert.equal((await pi.command({ type: "get_state" })).success, true);
});
