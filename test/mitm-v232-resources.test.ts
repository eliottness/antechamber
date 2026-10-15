import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { AdapterServer } from "../src/server.js";
import { openEvents } from "./bug-harness.js";

const endpointFixture = resolve("test/fixtures/fake-omo-endpoints.mjs");
const turnFixture = resolve("test/fixtures/turn-omo.mjs");

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): RecordValue {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function fixture(name: string): RecordValue {
  return record(JSON.parse(readFileSync(resolve(`test/fixtures/mitm-v232/${name}`), "utf8")), name);
}

function assertGoldenShape(expected: unknown, actual: unknown, path = "$"): void {
  if (path.endsWith(".tokens") && expected === "[REDACTED]") {
    const tokens = record(actual, path);
    for (const key of ["input", "output", "reasoning"]) assert.equal(typeof tokens[key], "number");
    const cache = record(tokens.cache, `${path}.cache`);
    assert.equal(typeof cache.read, "number");
    assert.equal(typeof cache.write, "number");
    return;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) throw new Error(`${path} must be an array`);
    const sample = expected[0];
    if (sample !== undefined) {
      assert.ok(actual.length > 0, `${path} must contain an item`);
      assertGoldenShape(sample, actual[0], `${path}[0]`);
    }
    return;
  }
  if (isRecord(expected)) {
    const received = record(actual, path);
    for (const [key, value] of Object.entries(expected)) {
      assert.ok(key in received, `${path}.${key} must be present`);
      assertGoldenShape(value, received[key], `${path}.${key}`);
    }
    return;
  }
  if (expected === null) {
    assert.equal(actual, null, `${path} must be null`);
    return;
  }
  assert.equal(typeof actual, typeof expected, `${path} must remain a ${typeof expected}`);
}

async function startServer(t: TestContext, binary: string) {
  const root = mkdtempSync(join(tmpdir(), "antechamber-mitm-v232-resources-"));
  const saved = new Map(
    ["ANTECHAMBER_PI_BINARY", "ANTECHAMBER_STATE_DIR", "PI_CODING_AGENT_DIR"].map((key) => [key, process.env[key]]),
  );
  process.env.ANTECHAMBER_PI_BINARY = binary;
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
    body: JSON.stringify({
      agent: "build",
      model: { providerID: "anthropic", id: "claude-haiku-4-5" },
      location: { directory },
    }),
  });
  assert.equal(response.status, 200);
  const data = record(record(await response.json(), "session response").data, "session response.data");
  if (typeof data.id === "string") return data.id;
  throw new Error("session response.data.id must be a string");
}

test("MITM232-04: v2 resources preserve captured field paths and types", {
  timeout: 15_000,
}, async (t: TestContext) => {
  const golden = fixture("resource-schemas.json");
  const responses = record(golden.responses, "resource fixture responses");
  const { root, url } = await startServer(t, turnFixture);
  const headers = { "x-opencode-directory": encodeURIComponent(root) };
  assert.equal((await fetch(`${url}/api/vcs/init`, { method: "POST", headers })).status, 204);

  const project = await fetch(`${url}/api/project`, { headers });
  assert.equal(project.status, 200);
  assertGoldenShape(responses.project, await project.json(), "project response");

  const vcs = await fetch(`${url}/api/vcs`, { headers });
  assert.equal(vcs.status, 200);
  assertGoldenShape(responses.vcs, await vcs.json(), "vcs response");

  const sessionID = await createSession(url, root);
  const capturedSession = record(record(responses.session, "captured session").data, "captured session data");
  const metadata = capturedSession.metadata;
  assert.equal(
    (
      await fetch(`${url}/api/session/${sessionID}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ metadata }),
      })
    ).status,
    204,
  );

  const stream = await openEvents(`${url}/api/event`);
  t.after(() => stream.close());
  const idle = stream.wait(
    (event) => event.type === "session.idle" && record(event.data, "session idle data").sessionID === sessionID,
  );
  const prompt = await fetch(`${url}/api/session/${sessionID}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ id: "msg_mitm_v232_resource", text: "resource fields" }),
  });
  assert.equal(prompt.status, 200);
  await idle;
  const session = await fetch(`${url}/api/session/${sessionID}`, { headers });
  assert.equal(session.status, 200);
  assertGoldenShape(responses.session, await session.json(), "session response");

  const messages = await fetch(`${url}/api/session/${sessionID}/message?order=desc&limit=1`, { headers });
  assert.equal(messages.status, 200);
  assertGoldenShape(responses.message, await messages.json(), "message response");
});

test("MITM232-07: v2 agents preserve captured descriptor fields", { timeout: 10_000 }, async (t: TestContext) => {
  const golden = fixture("agent-descriptor.json");
  const { root, url } = await startServer(t, endpointFixture);
  const response = await fetch(`${url}/api/agent`, {
    headers: { "x-opencode-directory": encodeURIComponent(root) },
  });
  assert.equal(response.status, 200);
  assertGoldenShape(golden.response, await response.json(), "agent response");
});
