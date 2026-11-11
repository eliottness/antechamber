import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AdapterServer } from "../src/server.js";

test("retired OpenChamber 1.x endpoints use the ordinary route not found response", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "antechamber-removed-routes-"));
  const previous = process.env.ANTECHAMBER_STATE_DIR;
  process.env.ANTECHAMBER_STATE_DIR = join(directory, "state");
  const server = new AdapterServer({ host: "127.0.0.1", port: 0, defaultDirectory: directory });
  t.after(async () => {
    await server.stop();
    if (previous === undefined) delete process.env.ANTECHAMBER_STATE_DIR;
    else process.env.ANTECHAMBER_STATE_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  await server.start();
  for (const [method, path] of [
    ["GET", "/session"],
    ["POST", "/session"],
    ["GET", "/session/status"],
    ["GET", "/session/ses_removed/message"],
    ["POST", "/session/ses_removed/prompt_async"],
    ["GET", "/question"],
    ["POST", "/question/question_removed/reply"],
    ["GET", "/permission"],
    ["GET", "/global/event"],
    ["GET", "/event"],
    ["POST", "/global/upgrade"],
  ] as const) {
    const response = await fetch(`${server.url}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(method === "POST" ? { body: "{}" } : {}),
    });
    assert.equal(response.status, 404, `${method} ${path}`);
    assert.deepEqual(await response.json(), {
      name: "NotFoundError",
      data: { message: `no route: ${method} ${path}` },
    });
  }
  assert.equal((await fetch(`${server.url}/global/health`)).status, 200);
});
