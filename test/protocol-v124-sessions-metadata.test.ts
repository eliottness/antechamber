import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { AdapterServer } from "../src/server.js";

const fakeRpc = resolve("test/fixtures/fake-omo-endpoints.mjs");

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const property = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);

async function startServer(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "antechamber-v124-sessions-"));
  const previousBinary = process.env.ANTECHAMBER_PI_BINARY;
  const previousState = process.env.ANTECHAMBER_STATE_DIR;
  process.env.ANTECHAMBER_PI_BINARY = fakeRpc;
  process.env.ANTECHAMBER_STATE_DIR = join(directory, "state");
  const server = new AdapterServer({ host: "127.0.0.1", port: 0, defaultDirectory: directory });
  t.after(async () => {
    await server.stop();
    if (previousBinary === undefined) delete process.env.ANTECHAMBER_PI_BINARY;
    else process.env.ANTECHAMBER_PI_BINARY = previousBinary;
    if (previousState === undefined) delete process.env.ANTECHAMBER_STATE_DIR;
    else process.env.ANTECHAMBER_STATE_DIR = previousState;
    rmSync(directory, { recursive: true, force: true });
  });
  await server.start();
  return { directory, url: server.url };
}

async function createSession(
  url: string,
  directory: string,
  body: Record<string, unknown> = {},
): Promise<Record<string, unknown> & { id: string }> {
  const response = await fetch(`${url}/session?directory=${encodeURIComponent(directory)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  const session: unknown = await response.json();
  if (!isRecord(session) || typeof session.id !== "string") {
    throw new TypeError("expected a session with a string id");
  }
  return { ...session, id: session.id };
}

test("V124-001: persists OpenChamber session metadata", { timeout: 10_000 }, async (t) => {
  const { directory, url } = await startServer(t);
  const multiRun = { version: 1, sessionID: null };
  const created = await createSession(url, directory, {
    title: "run",
    metadata: { openchamber: { multirun: multiRun } },
  });
  assert.deepEqual(property(property(property(created, "metadata"), "openchamber"), "multirun"), multiRun);

  const sessionID = created.id;
  assert.equal(typeof sessionID, "string");
  const goal = { id: "goal-1", objective: "finish", status: "paused" };
  const updated = await fetch(`${url}/session/${sessionID}?directory=${encodeURIComponent(directory)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ metadata: { openchamber: { goal } } }),
  });
  assert.equal(updated.status, 200);
  const updateBody: unknown = await updated.json();
  assert.deepEqual(property(property(property(updateBody, "metadata"), "openchamber"), "goal"), goal);

  const read = await fetch(`${url}/session/${sessionID}?directory=${encodeURIComponent(directory)}`);
  assert.equal(read.status, 200);
  const readBody: unknown = await read.json();
  assert.deepEqual(property(property(property(readBody, "metadata"), "openchamber"), "goal"), goal);
});

test("V124-002: lists child sessions", { timeout: 10_000 }, async (t) => {
  const { directory, url } = await startServer(t);
  const parent = await createSession(url, directory, { title: "parent" });
  const child = await createSession(url, directory, { parentID: parent.id, title: "child" });

  const response = await fetch(`${url}/session/${parent.id}/children?directory=${encodeURIComponent(directory)}`);
  assert.equal(response.status, 200);
  const children: unknown = await response.json();
  if (!Array.isArray(children)) throw new TypeError("expected a child-session array");
  const found = children.find((candidate) => isRecord(candidate) && candidate.id === child.id);
  if (!isRecord(found)) throw new TypeError("expected the created child session");
  assert.equal(found.parentID, parent.id);
});
