import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import test from "node:test";
import { trackDetachedFixture } from "./detached-fixture.js";

test("fixture cleanup after an assertion failure", async (t) => {
  const child = spawn(process.execPath, [resolve("test/fixtures/fake-omo-host.mjs")], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  trackDetachedFixture(t, child);
  assert.ok(child.stdout);
  const [output] = await once(child.stdout, "data", { signal: AbortSignal.timeout(10_000) });
  t.diagnostic(`fixture-identities ${String(output).trim()}`);
  assert.fail("injected assertion failure");
});
