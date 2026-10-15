import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { AdapterServer } from "../src/server.js";
import { openEvents } from "./bug-harness.js";

const endpointFixture = resolve("test/fixtures/fake-omo-endpoints.mjs");
const catalogFixture = resolve("test/fixtures/review-qa-catalog-ghost.py");
const turnFixture = resolve("test/fixtures/turn-omo.mjs");

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): RecordValue {
  assert.ok(isRecord(value), `${label} must be an object`);
  return value;
}

async function startServer(t: TestContext, fixture = endpointFixture) {
  const root = mkdtempSync(join(tmpdir(), "antechamber-review-qa-"));
  const saved = new Map(
    ["ANTECHAMBER_PI_BINARY", "PI_CODING_AGENT_DIR", "ANTECHAMBER_STATE_DIR"].map((key) => [key, process.env[key]]),
  );
  process.env.ANTECHAMBER_PI_BINARY = fixture;
  process.env.ANTECHAMBER_STATE_DIR = join(root, "state");
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const server = new AdapterServer({ port: 0, host: "127.0.0.1", defaultDirectory: root });
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

async function postJson(url: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function createSession(url: string, headers: Record<string, string> = {}) {
  const response = await postJson(url, "/api/session", {}, headers);
  assert.equal(response.status, 200);
  const session = record(record(await response.json(), "session response").data, "session response data");
  assert.equal(typeof session.id, "string");
  return session.id;
}

function assertSuccess(response: Response, label: string) {
  assert.ok(response.status >= 200 && response.status < 300, `${label} returned ${response.status}`);
}

test("R-080: catalog discovery does not publish a session", async (t) => {
  const { root, url } = await startServer(t, catalogFixture);
  const bootstrap = await fetch(`${url}/config/providers`);
  assert.equal(bootstrap.status, 200);

  const listed = await fetch(`${url}/session?directory=${encodeURIComponent(root)}`);
  assert.equal(listed.status, 200);
  assert.deepEqual(await listed.json(), []);
});

test("R-081: v1 shell returns message info and parts", async (t) => {
  const { url } = await startServer(t);
  const sessionID = await createSession(url);

  const response = await postJson(url, `/session/${sessionID}/shell`, { command: "printf review-qa" });
  assert.equal(response.status, 200);
  const body = record(await response.json(), "v1 shell response");
  assert.ok(isRecord(body.info), "v1 shell response must contain info");
  assert.ok(Array.isArray(body.parts), "v1 shell response must contain parts");
});

test("R-082: encoded directory headers select the real worktree", async (t) => {
  const { root, url } = await startServer(t);
  const response = await postJson(url, "/api/session", {}, { "x-opencode-directory": encodeURIComponent(root) });
  assert.equal(response.status, 200);
  const session = record(record(await response.json(), "session response").data, "session response data");
  assert.equal(session.directory, root);
});

test("R-084: v2 session patch persists metadata", async (t) => {
  const { url } = await startServer(t);
  const sessionID = await createSession(url);
  const metadata = { source: "review-qa", tab: "composer" };

  const patched = await fetch(`${url}/api/session/${sessionID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ metadata }),
  });
  assertSuccess(patched, "session patch");

  const read = await fetch(`${url}/api/session/${sessionID}`);
  assert.equal(read.status, 200);
  const session = record(record(await read.json(), "session response").data, "session response data");
  assert.deepEqual(session.metadata, metadata);
});

test("R-088: v2 revert stage clear and commit succeed without changing files", async (t) => {
  const { root, url } = await startServer(t, resolve("test/fixtures/fake-omo.mjs"));
  const unchanged = join(root, "unchanged.txt");
  writeFileSync(unchanged, "original\n");
  const events = await openEvents(`${url}/api/event`);
  t.after(() => events.close());
  const sessionID = await createSession(url);
  const idle = events.wait(
    (event) => event.type === "session.idle" && isRecord(event.data) && event.data.sessionID === sessionID,
  );
  const prompted = await postJson(url, `/api/session/${sessionID}/prompt`, {
    id: "msg_review_qa_stage",
    text: "stage this message",
  });
  assert.equal(prompted.status, 200);
  await idle;

  assertSuccess(
    await postJson(url, `/api/session/${sessionID}/revert/stage`, {
      messageID: "msg_review_qa_stage",
      files: false,
    }),
    "revert stage",
  );
  assertSuccess(await fetch(`${url}/api/session/${sessionID}/revert`, { method: "DELETE" }), "revert clear");
  assertSuccess(
    await postJson(url, `/api/session/${sessionID}/revert/stage`, {
      messageID: "msg_review_qa_stage",
      files: false,
    }),
    "revert restage",
  );
  assertSuccess(await postJson(url, `/api/session/${sessionID}/revert/commit`, {}), "revert commit");
  assert.equal(readFileSync(unchanged, "utf8"), "original\n");
});

test("R-089: malformed shell results return a typed gateway error", async (t) => {
  const { url } = await startServer(t, turnFixture);
  const sessionID = await createSession(url);

  const response = await postJson(url, `/session/${sessionID}/shell`, { command: "printf review-qa" });
  assert.equal(response.status, 502);
  const body = record(await response.json(), "shell error response");
  assert.equal(body.name, "UpstreamProtocolError");
});

test("R-090: synthetic context admission uses the client route", async (t) => {
  const { url } = await startServer(t);
  const sessionID = await createSession(url);

  const response = await postJson(url, `/api/session/${sessionID}/synthetic`, {
    id: "msg_review_qa_context",
    text: "context before the prompt",
    delivery: "queue",
    resume: false,
  });
  assert.equal(response.status, 200);
  const data = record(record(await response.json(), "synthetic response").data, "synthetic record");
  assert.equal(data.id, "msg_review_qa_context");
  assert.equal(data.type, "synthetic");
  assert.deepEqual(data.payload, { text: "context before the prompt" });
});
