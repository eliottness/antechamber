import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { AdapterServer } from "../src/server.js";

const turnRpc = resolve("test/fixtures/turn-omo.mjs");
const golden = JSON.parse(readFileSync(resolve("test/fixtures/mitm-v124/session-resource.json"), "utf8")) as {
  response: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

function assertGoldenShape(actual: unknown, expected: unknown, path = "$"): void {
  if (path.endsWith(".tokens") && expected === "[REDACTED]") {
    assert.ok(isRecord(actual), `${path} must be the token-usage object redacted by the capture`);
    for (const key of ["input", "output", "reasoning"]) assert.equal(typeof actual[key], "number");
    assert.ok(isRecord(actual.cache));
    assert.equal(typeof actual.cache.read, "number");
    assert.equal(typeof actual.cache.write, "number");
    return;
  }
  if (expected === null) {
    assert.equal(actual, null, `${path} must be null`);
    return;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) assert.fail(`${path} must be an array`);
    const actualArray = actual as unknown[];
    if (expected.length > 0) {
      assert.ok(actualArray.length > 0, `${path} must contain a captured item`);
      assertGoldenShape(actualArray[0], expected[0], `${path}[0]`);
    }
    return;
  }
  if (isRecord(expected)) {
    if (!isRecord(actual)) assert.fail(`${path} must be an object`);
    const actualRecord = actual as Record<string, unknown>;
    for (const [key, value] of Object.entries(expected)) {
      assert.ok(Object.hasOwn(actualRecord, key), `${path}.${key} must be present`);
      assertGoldenShape(actualRecord[key], value, `${path}.${key}`);
    }
    return;
  }
  assert.equal(typeof actual, typeof expected, `${path} must be a ${typeof expected}`);
}

async function startServer(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "antechamber-mitm-v124-sessions-"));
  const saved = new Map(
    ["ANTECHAMBER_PI_BINARY", "ANTECHAMBER_STATE_DIR", "PI_CODING_AGENT_DIR"].map((key) => [key, process.env[key]]),
  );
  process.env.ANTECHAMBER_PI_BINARY = turnRpc;
  process.env.ANTECHAMBER_STATE_DIR = join(directory, "state");
  process.env.PI_CODING_AGENT_DIR = join(directory, "pi");
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
  return { directory, url: server.url };
}

test("MITM124-03: session detail preserves the captured metadata shell", { timeout: 10_000 }, async (t) => {
  const { directory, url } = await startServer(t);
  const created = await fetch(`${url}/session?directory=${encodeURIComponent(directory)}`, {
    method: "POST",
    headers: { accept: "application/json" },
  });
  assert.equal(created.status, 200);
  const createdSession: unknown = await created.json();
  if (!isRecord(createdSession) || typeof createdSession.id !== "string") assert.fail("expected a created session id");
  const sessionID = (createdSession as Record<string, unknown>).id as string;

  const response = await fetch(`${url}/session/${sessionID}?directory=${encodeURIComponent(directory)}`, {
    headers: { accept: "application/json" },
  });
  assert.equal(response.status, 200);
  assertGoldenShape(await response.json(), golden.response);
});
