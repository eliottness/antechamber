import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { AdapterServer } from "../src/server.js";
import { openEvents } from "./bug-harness.js";

const turnFixture = resolve("test/fixtures/turn-omo.mjs");

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): RecordValue {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function assertGoldenShape(expected: unknown, actual: unknown, path = "$"): void {
  if (isRecord(expected)) {
    const received = record(actual, path);
    for (const [key, value] of Object.entries(expected)) {
      assert.ok(key in received, `${path}.${key} must be present`);
      assertGoldenShape(value, received[key], `${path}.${key}`);
    }
    return;
  }
  assert.equal(typeof actual, typeof expected, `${path} must remain a ${typeof expected}`);
}

async function startServer(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "antechamber-mitm-v232-events-"));
  const saved = new Map(
    ["ANTECHAMBER_PI_BINARY", "ANTECHAMBER_STATE_DIR", "PI_CODING_AGENT_DIR"].map((key) => [key, process.env[key]]),
  );
  process.env.ANTECHAMBER_PI_BINARY = turnFixture;
  process.env.ANTECHAMBER_STATE_DIR = join(root, "state");
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const server = new AdapterServer({ host: "127.0.0.1", port: 0, defaultDirectory: root });
  await server.start();
  t.after(async () => {
    await server.stop();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, url: server.url };
}

async function createSession(url: string, directory: string): Promise<string> {
  const response = await fetch(`${url}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-directory": encodeURIComponent(directory) },
    body: JSON.stringify({ location: { directory } }),
  });
  assert.equal(response.status, 200);
  const data = record(record(await response.json(), "session response").data, "session response.data");
  if (typeof data.id === "string") return data.id;
  throw new Error("session response.data.id must be a string");
}

test("MITM232-06: v2 streamed frames retain durable replay metadata", { timeout: 15_000 }, async (t: TestContext) => {
  const golden = record(
    JSON.parse(readFileSync(resolve("test/fixtures/mitm-v232/durable-events.json"), "utf8")),
    "durable event fixture",
  );
  const { root, url } = await startServer(t);
  const stream = await openEvents(`${url}/api/event`);
  t.after(() => stream.close());
  const sessionID = await createSession(url, root);
  const textStarted = stream.wait(
    (event) =>
      event.type === "session.text.started" && record(event.data, "session text start data").sessionID === sessionID,
  );
  const prompt = await fetch(`${url}/api/session/${sessionID}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-directory": encodeURIComponent(root) },
    body: JSON.stringify({ id: "msg_mitm_v232_durable", text: "durable fields" }),
  });
  assert.equal(prompt.status, 200);
  assertGoldenShape(golden.event, await textStarted, "v2 event");
});
