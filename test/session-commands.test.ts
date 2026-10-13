import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { PiRpcClient } from "../src/pi-rpc.js";
import { getCommands } from "../src/session-commands.js";

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
