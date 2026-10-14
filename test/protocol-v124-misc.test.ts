import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { AdapterServer } from "../src/server.js";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

async function startServer(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "antechamber-v124-misc-"));
  const previousState = process.env.ANTECHAMBER_STATE_DIR;
  process.env.ANTECHAMBER_STATE_DIR = join(directory, "state");
  const server = new AdapterServer({ host: "127.0.0.1", port: 0, defaultDirectory: directory });
  t.after(async () => {
    await server.stop();
    if (previousState === undefined) delete process.env.ANTECHAMBER_STATE_DIR;
    else process.env.ANTECHAMBER_STATE_DIR = previousState;
    rmSync(directory, { recursive: true, force: true });
  });
  await server.start();
  return server.url;
}

test("V124-012: decodes form-list directory headers", { timeout: 10_000 }, async (t) => {
  const url = await startServer(t);
  const response = await fetch(`${url}/api/form`, { headers: { "x-opencode-directory": "%2Ftmp%2Fworkspace" } });
  assert.equal(response.status, 200);
  const body: unknown = await response.json();
  if (!isRecord(body) || !isRecord(body.location)) throw new TypeError("expected a v2 location envelope");
  assert.equal(body.location.directory, "/tmp/workspace");
  assert.ok(Array.isArray(body.data));
});
