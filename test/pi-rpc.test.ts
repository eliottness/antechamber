import assert from "node:assert/strict";
import childProcess, { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import type { MonitorSessions } from "../src/monitor-sessions.js";
import { COMPACT_RPC_TIMEOUT_MS, PiRpcClient, PiStoppedError, RPC_COMMAND_TIMEOUT_MS } from "../src/pi-rpc.js";
import type { ManagedSession } from "../src/sessions.js";
import { WorkStatusBridge } from "../src/work-status.js";

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

/** The PiStoppedError a timed-out ordered command stops the agent with. */
function stoppedBy(command: string, ms: number) {
  return (error: unknown) =>
    error instanceof PiStoppedError &&
    error.reason.kind === "timeout" &&
    error.reason.command === command &&
    error.reason.ms === ms;
}

/** Asserts the client still round-trips a get_state; every buffered get_state frame is answered. */
async function answersNextCommand(pi: PiRpcClient, stdin: PassThrough, stdout: PassThrough) {
  const reply = (chunk: Buffer | string) => {
    const request = JSON.parse(String(chunk));
    if (request.type !== "get_state") return;
    stdout.write(`${JSON.stringify({ type: "response", id: request.id, command: request.type, success: true })}\n`);
  };
  stdin.on("data", reply);
  assert.equal((await pi.command({ type: "get_state" })).success, true);
  stdin.off("data", reply);
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
    stdout.write(`${JSON.stringify({ type: "response", id: command.id, command: "get_state", ...fields })}\n`);
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
    `${JSON.stringify({ type: "response", id: command.id, command: "get_state", success: true, data: "valid" })}\n`,
  );
  assert.equal((await pending).data, "valid");
});

test("tracks the current session file across correlated state responses", async (t) => {
  const { pi, stdin, stdout } = transport(t);
  for (const sessionFile of ["/tmp/first-session.jsonl", "/tmp/forked-session.jsonl", undefined]) {
    stdin.once("data", (chunk) => {
      const command = JSON.parse(String(chunk));
      stdout.write(
        `${JSON.stringify({
          type: "response",
          id: command.id,
          command: command.type,
          success: true,
          data: { sessionFile },
        })}\n`,
      );
    });
    await pi.command({ type: "get_state" });
    assert.equal(pi.sessionFile, sessionFile);
  }
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
  const rejected = assert.rejects(pending, stoppedBy("prompt", 60_000));
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
  const rejected = assert.rejects(pending, stoppedBy("prompt", maximum));
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
    const rejected = assert.rejects(pending, stoppedBy(command.type, 60_000));
    t.mock.timers.tick(RPC_COMMAND_TIMEOUT_MS);
    await rejected;
    await assert.rejects(pi.command({ type: "get_state" }), /not running/);
  });

test("a silent prompt still closes the transport after the ordinary deadline", async (t) => {
  const { pi } = transport(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "error", () => {});
  const pending = pi.command({ type: "prompt", message: "continue" });
  const rejected = assert.rejects(pending, stoppedBy("prompt", 60_000));
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
  const rejected = assert.rejects(pending, stoppedBy("prompt", 60_000));
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

test("a timed-out probe fails alone: the prompt and the agent survive, the late reply is dropped", async (t) => {
  const { pi, stdin, stdout } = transport(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const frames: Array<{ id: string; type: string }> = [];
  stdin.on("data", (chunk) => frames.push(JSON.parse(String(chunk))));
  stdout.write('{"type":"agent_start"}\n');
  const prompt = pi.command({ type: "prompt", message: "continue" });
  const probe = pi.probe({ type: "eval_cells.list" }, 10_000);
  const rejected = assert.rejects(
    probe,
    (error: unknown) =>
      !(error instanceof PiStoppedError) && /"eval_cells.list" timed out after 10000ms/.test(String(error)),
  );
  t.mock.timers.tick(10_000);
  await rejected;
  assert.equal(pi.stopReason, undefined);
  const [promptFrame, probeFrame] = frames;
  assert.equal(promptFrame?.type, "prompt");
  assert.equal(probeFrame?.type, "eval_cells.list");
  stdout.write(
    `${JSON.stringify({ type: "response", id: probeFrame.id, command: "eval_cells.list", success: true, data: [] })}\n`,
  );
  stdout.write(`${JSON.stringify({ type: "response", id: promptFrame.id, command: "prompt", success: true })}\n`);
  assert.equal((await prompt).success, true);
  stdin.removeAllListeners("data");
  await answersNextCommand(pi, stdin, stdout);
});

test("OmO Work's eval_cells poll timing out leaves the agent running", async (t) => {
  const { pi, stdin, stdout } = transport(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const bridge = new WorkStatusBridge({ list: () => [] } as unknown as MonitorSessions);
  const session = { info: { id: "ses_poll" }, pi } as unknown as ManagedSession;
  const sent = once(stdin, "data", { signal: AbortSignal.timeout(1_000) });
  const snapshot = bridge.snapshot(session);
  const [chunk] = await sent;
  assert.equal(JSON.parse(String(chunk)).type, "eval_cells.list");
  t.mock.timers.tick(10_000);
  assert.equal((await snapshot).evalCellsListed, false);
  assert.equal(pi.stopReason, undefined);
  await answersNextCommand(pi, stdin, stdout);
});

for (const order of ["exit arrives first", "output closes first"] as const)
  test(`a crash reports its exit status when the ${order}`, async (t) => {
    const { pi, proc, stdout } = transport(t);
    t.mock.method(console, "error", () => {});
    const pending = assert.rejects(pi.command({ type: "get_state" }, 1_000), PiStoppedError);
    if (order === "exit arrives first") {
      proc.emit("exit", 3, null);
      stdout.end();
    } else {
      const ended = once(stdout, "end", { signal: AbortSignal.timeout(1_000) });
      stdout.end();
      await ended;
      proc.emit("exit", 3, null);
    }
    await pending;
    assert.deepEqual(pi.stopReason, { kind: "exit", code: 3, signal: null });
  });

test("a late get_state reply to a timed-out probe leaves the tracked session file alone", async (t) => {
  const { pi, stdin, stdout } = transport(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sent = once(stdin, "data", { signal: AbortSignal.timeout(1_000) });
  const probe = pi.probe({ type: "get_state" }, 1_000);
  const rejected = assert.rejects(probe, /timed out after 1000ms/);
  const [chunk] = await sent;
  t.mock.timers.tick(1_000);
  await rejected;
  const late = { type: "response", id: JSON.parse(String(chunk)).id, command: "get_state", success: true };
  stdout.write(`${JSON.stringify({ ...late, data: { sessionFile: "/tmp/late-session.jsonl" } })}\n`);
  assert.equal(pi.sessionFile, undefined);
});

test("exit listeners read why the agent stopped, and a requested dispose records none", async (t) => {
  const timedOut = transport(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "error", () => {});
  const pending = timedOut.pi.command({ type: "get_state" }, 1_000);
  const rejected = assert.rejects(pending, stoppedBy("get_state", 1_000));
  t.mock.timers.tick(1_000);
  await rejected;
  assert.deepEqual(timedOut.pi.stopReason, { kind: "timeout", command: "get_state", ms: 1_000 });

  const crashed = transport(t);
  const exited = once(crashed.pi, "exit");
  const inFlight = assert.rejects(crashed.pi.command({ type: "get_state" }, 1_000), (error: unknown) => {
    return error instanceof PiStoppedError && error.reason.kind === "exit" && error.reason.code === 1;
  });
  crashed.proc.emit("exit", 1, null);
  await Promise.all([exited, inFlight]);
  assert.deepEqual(crashed.pi.stopReason, { kind: "exit", code: 1, signal: null });

  const disposed = transport(t);
  await disposed.pi.dispose();
  disposed.proc.emit("exit", null, "SIGTERM");
  assert.equal(disposed.pi.stopReason, undefined);
});
