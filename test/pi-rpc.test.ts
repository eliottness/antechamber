import assert from "node:assert/strict";
import childProcess, { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import { PiRpcClient } from "../src/pi-rpc.js";

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
