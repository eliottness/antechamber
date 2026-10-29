import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { PiRpcClient } from "../src/pi-rpc.js";
import { appendLiveOutput, getCommands } from "../src/session-commands.js";

test("live shell output keeps its newest part without emptying on a trailing newline", () => {
  assert.equal(appendLiveOutput("ab\n", "cd\n", 10), "ab\ncd\n");
  // One chunk over the limit whose only newline is its last char keeps the bounded suffix.
  assert.equal(appendLiveOutput("", `${"x".repeat(20)}\n`, 10), `${"x".repeat(9)}\n`);
  // A partial first line is dropped when whole lines remain.
  assert.equal(appendLiveOutput("first line\n", "second\n", 10), "second\n");
});

test("command discovery shares concurrent calls, caches briefly, and expires", { timeout: 30_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "antechamber-command-cache-"));
  const previous = process.env.ANTECHAMBER_PI_BINARY;
  process.env.ANTECHAMBER_PI_BINARY = resolve("test/fixtures/fake-omo-endpoints.mjs");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const original = PiRpcClient.prototype.command;
  let calls = 0;
  const discovery = t.mock.method(
    PiRpcClient.prototype,
    "command",
    async function (this: PiRpcClient, ...args: Parameters<PiRpcClient["command"]>) {
      calls++;
      const response = await original.apply(this, args);
      entered.resolve();
      await release.promise;
      return response;
    },
  );
  t.after(() => {
    release.resolve();
    if (previous === undefined) delete process.env.ANTECHAMBER_PI_BINARY;
    else process.env.ANTECHAMBER_PI_BINARY = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  const first = getCommands(directory);
  const concurrent = getCommands(directory);
  try {
    await entered.promise;
    assert.equal(calls, 1);
  } finally {
    release.resolve();
    await Promise.all([first, concurrent]);
  }
  const result = await first;
  assert.deepEqual(result, [{ name: "fixture", description: "Fixture command", template: "" }]);
  assert.deepEqual(await getCommands(directory), result);
  assert.equal(discovery.mock.callCount(), 1);
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 60_000);
  assert.deepEqual(await getCommands(directory), result);
  assert.equal(discovery.mock.callCount(), 2);
});

test("failed command discovery is not cached", { timeout: 30_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "antechamber-command-error-"));
  const previous = process.env.ANTECHAMBER_PI_BINARY;
  process.env.ANTECHAMBER_PI_BINARY = resolve("test/fixtures/fake-omo-endpoints.mjs");
  const original = PiRpcClient.prototype.command;
  let failed = false;
  const discovery = t.mock.method(
    PiRpcClient.prototype,
    "command",
    function (this: PiRpcClient, ...args: Parameters<PiRpcClient["command"]>) {
      if (!failed) {
        failed = true;
        return Promise.reject(new Error("discovery failed"));
      }
      return original.apply(this, args);
    },
  );
  t.after(() => {
    if (previous === undefined) delete process.env.ANTECHAMBER_PI_BINARY;
    else process.env.ANTECHAMBER_PI_BINARY = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  await assert.rejects(getCommands(directory), /discovery failed/);
  assert.deepEqual(await getCommands(directory), [{ name: "fixture", description: "Fixture command", template: "" }]);
  assert.equal(discovery.mock.callCount(), 2);
});
