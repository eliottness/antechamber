import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { ApprovalBridge } from "../src/approvals.js";
import { AdapterServer } from "../src/server.js";

const approvalFixture = resolve("test/fixtures/approval-rpc.mjs");

type Envelope = { type: string; data?: Record<string, unknown> };

async function startServer(t: TestContext, fixture = approvalFixture) {
  const root = mkdtempSync(join(tmpdir(), "antechamber-v261-forms-"));
  const keys = ["ANTECHAMBER_PI_BINARY", "ANTECHAMBER_STATE_DIR", "PI_CODING_AGENT_DIR"] as const;
  const saved = keys.map((key) => process.env[key]);
  process.env.ANTECHAMBER_PI_BINARY = fixture;
  process.env.ANTECHAMBER_STATE_DIR = join(root, "state");
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const server = new AdapterServer({ host: "127.0.0.1", port: 0, defaultDirectory: root });
  try {
    await server.start();
  } catch (error) {
    keys.forEach((key, index) => {
      if (saved[index] === undefined) delete process.env[key];
      else process.env[key] = saved[index];
    });
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  t.after(async () => {
    await server.stop();
    keys.forEach((key, index) => {
      if (saved[index] === undefined) delete process.env[key];
      else process.env[key] = saved[index];
    });
    rmSync(root, { recursive: true, force: true });
  });
  return { url: server.url, root };
}

async function createSession(url: string, directory: string) {
  const response = await fetch(`${url}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-directory": directory },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 200);
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || !("data" in body)) throw new Error("session response missing data");
  const session = body.data;
  if (!session || typeof session !== "object" || !("id" in session) || typeof session.id !== "string")
    throw new Error("session response missing id");
  return session.id;
}

async function prompt(url: string, sessionID: string, text: string) {
  const response = await fetch(`${url}/api/session/${sessionID}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  assert.equal(response.status, 200);
}

async function openSse(t: TestContext, url: string) {
  const controller = new AbortController();
  const events = new EventEmitter();
  const history: Envelope[] = [];
  const response = await fetch(`${url}/api/event`, { signal: controller.signal });
  assert.equal(response.status, 200);
  if (!response.body) throw new Error("SSE response missing body");
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  void (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) return;
        buffer += decoder.decode(next.value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame.split("\n").find((part) => part.startsWith("data: "));
          if (!line) continue;
          const event: Envelope = JSON.parse(line.slice(6));
          history.push(event);
          events.emit("event", event);
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) events.emit("error", error);
    }
  })();
  t.after(() => controller.abort());
  return {
    wait(type: string, sessionID: string): Promise<Envelope> {
      const match = (event: Envelope) =>
        event.type === type &&
        (event.data?.sessionID === sessionID ||
          (event.data?.form &&
            typeof event.data.form === "object" &&
            "sessionID" in event.data.form &&
            event.data.form.sessionID === sessionID));
      const found = history.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((resolveEvent, rejectEvent) => {
        const timeout = setTimeout(() => {
          cleanup();
          rejectEvent(new Error(`SSE deadline: ${type}`));
        }, 5_000);
        const onEvent = (event: Envelope) => {
          if (!match(event)) return;
          cleanup();
          resolveEvent(event);
        };
        const onError = (error: unknown) => {
          cleanup();
          rejectEvent(error);
        };
        const cleanup = () => {
          clearTimeout(timeout);
          events.off("event", onEvent);
          events.off("error", onError);
        };
        events.on("event", onEvent);
        events.once("error", onError);
      });
    },
  };
}

test("permission.asked publishes the v2 action resources and source id", { timeout: 15_000 }, async (t) => {
  const { root, url } = await startServer(t);
  const sessionID = await createSession(url, root);
  const stream = await openSse(t, url);
  const asked = stream.wait("permission.asked", sessionID);

  await prompt(url, sessionID, "permission");

  const data = (await asked).data;
  if (!data) throw new Error("permission event missing data");
  assert.equal(typeof data.id, "string");
  assert.equal(data.sessionID, sessionID);
  assert.equal(data.action, "read");
  assert.deepEqual(data.resources, ["/tmp/fixture"]);
  const source = data.source;
  if (!source || typeof source !== "object" || !("id" in source) || !("messageID" in source))
    throw new Error("permission event missing tool source");
  assert.equal(source.id, "fixture-call");
  assert.equal("type" in source && source.type, "tool");
  assert.equal(typeof source.messageID, "string");
});

test("pending read permission advertises its exact native always scope", { timeout: 15_000 }, async (t) => {
  const { root, url } = await startServer(t);
  const sessionID = await createSession(url, root);
  const stream = await openSse(t, url);
  const asked = stream.wait("permission.asked", sessionID);

  await prompt(url, sessionID, "permission");

  const event = (await asked).data;
  if (!event) throw new Error("permission event missing data");
  assert.deepEqual(event.save, ["/tmp/fixture"]);
  const response = await fetch(`${url}/api/permission/request`, { headers: { "x-opencode-directory": root } });
  assert.equal(response.status, 200);
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || !("data" in body) || !Array.isArray(body.data))
    throw new Error("permission list missing data");
  assert.deepEqual(
    body.data.map((item: { save: string[] }) => item.save),
    [["/tmp/fixture"]],
  );
});

test("permission without an always option advertises no saved scope", () => {
  const bridge = new ApprovalBridge(
    "ses_test",
    () => {},
    () => {},
    () => "msg_test",
  );
  bridge.handle({
    id: "per_test",
    method: "select",
    title: "Permission required: read\nPatterns:\n - /tmp/fixture",
    options: ["Allow once", "Deny"],
  });
  assert.deepEqual(bridge.permissions()[0]?.always, []);
  bridge.cancelAll();
});

test("form list includes only pending forms from the requested directory", { timeout: 15_000 }, async (t) => {
  const { root, url } = await startServer(t, resolve("test/fixtures/question-rpc.mjs"));
  const firstDirectory = join(root, "first");
  const secondDirectory = join(root, "second");
  mkdirSync(firstDirectory);
  mkdirSync(secondDirectory);
  const first = await createSession(url, firstDirectory);
  const second = await createSession(url, secondDirectory);
  const stream = await openSse(t, url);
  const firstCreated = stream.wait("form.created", first);
  await prompt(url, first, "idle");
  await firstCreated;
  const secondCreated = stream.wait("form.created", second);
  await prompt(url, second, "idle");
  await secondCreated;

  const response = await fetch(`${url}/api/form`, { headers: { "x-opencode-directory": firstDirectory } });
  assert.equal(response.status, 200);
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || !("location" in body) || !("data" in body))
    throw new Error("form list missing location and data");
  assert.deepEqual(body.location, { directory: firstDirectory });
  if (!Array.isArray(body.data)) throw new Error("form list missing data array");
  assert.deepEqual(
    body.data.map((form: { sessionID: string }) => form.sessionID),
    [first],
  );
});
