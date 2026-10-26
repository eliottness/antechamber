import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { AdapterServer } from "../src/server.js";

const endpointFixture = resolve("test/fixtures/fake-omo-endpoints.mjs");

type RecordValue = Record<string, unknown>;
type EventEnvelope = RecordValue & { type: string };

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEventEnvelope(value: unknown): value is EventEnvelope {
  return isRecord(value) && typeof value.type === "string";
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
  const root = mkdtempSync(join(tmpdir(), "antechamber-mitm-v232-sessions-"));
  const saved = new Map(
    ["ANTECHAMBER_PI_BINARY", "ANTECHAMBER_STATE_DIR", "PI_CODING_AGENT_DIR"].map((key) => [key, process.env[key]]),
  );
  process.env.ANTECHAMBER_PI_BINARY = endpointFixture;
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

async function openSse(t: TestContext, url: string) {
  const controller = new AbortController();
  const bus = new EventEmitter();
  const events: EventEnvelope[] = [];
  const response = await fetch(url, { signal: controller.signal });
  assert.equal(response.status, 200);
  const body = response.body;
  if (!body) throw new Error("SSE response must have a body");
  const reader = body.getReader();
  const ready = await reader.read();
  assert.equal(ready.done, false, "SSE connection must emit server.connected first");
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) return;
        buffer += decoder.decode(next.value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const data = frame.split("\n").find((line) => line.startsWith("data: "));
          if (!data) continue;
          const parsed: unknown = JSON.parse(data.slice("data: ".length));
          if (!isEventEnvelope(parsed)) continue;
          events.push(parsed);
          bus.emit("event", parsed);
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) bus.emit("error", error);
    }
  })();
  t.after(() => controller.abort());
  return {
    wait(predicate: (event: EventEnvelope) => boolean, label: string): Promise<EventEnvelope> {
      const found = events.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((resolveEvent, rejectEvent) => {
        const timer = setTimeout(() => {
          cleanup();
          rejectEvent(new Error(`SSE deadline: ${label}`));
        }, 5_000);
        const onEvent = (event: EventEnvelope) => {
          if (!predicate(event)) return;
          cleanup();
          resolveEvent(event);
        };
        const onError = (error: unknown) => {
          cleanup();
          rejectEvent(error);
        };
        const onAbort = () => {
          cleanup();
          rejectEvent(new Error(`SSE closed: ${label}`));
        };
        const cleanup = () => {
          clearTimeout(timer);
          bus.off("event", onEvent);
          bus.off("error", onError);
          controller.signal.removeEventListener("abort", onAbort);
        };
        bus.on("event", onEvent);
        bus.once("error", onError);
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}

test("MITM232-08: session metadata patches round-trip and publish updates", {
  timeout: 15_000,
}, async (t: TestContext) => {
  const golden = record(
    JSON.parse(readFileSync(resolve("test/fixtures/mitm-v232/session-metadata.json"), "utf8")),
    "session metadata fixture",
  );
  const request = record(golden.request, "metadata request");
  const { root, url } = await startServer(t);
  const sessionID = await createSession(url, root);
  const stream = await openSse(t, `${url}/api/event`);
  const metadataUpdated = stream.wait((event) => event.type === "session.metadata.updated", "session metadata update");
  void metadataUpdated.catch(() => undefined);

  const patched = await fetch(`${url}/api/session/${sessionID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-opencode-directory": encodeURIComponent(root) },
    body: JSON.stringify(request.body),
  });
  assert.equal(patched.status, 204);

  const session = await fetch(`${url}/api/session/${sessionID}`, {
    headers: { "x-opencode-directory": encodeURIComponent(root) },
  });
  assert.equal(session.status, 200);
  assertGoldenShape(golden.read, await session.json(), "patched session");

  const event = await metadataUpdated;
  assertGoldenShape(golden.event, event, "metadata event");
});

test("OpenCode 2.1 archived boolean archives, keeps the time on repeat, and restores", {
  timeout: 15_000,
}, async (t: TestContext) => {
  const { root, url } = await startServer(t);
  const sessionID = await createSession(url, root);
  const headers = { "content-type": "application/json", "x-opencode-directory": encodeURIComponent(root) };
  const patch = async (body: unknown) => {
    const response = await fetch(`${url}/api/session/${sessionID}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 204);
  };
  const archivedAt = async () => {
    const response = await fetch(`${url}/api/session/${sessionID}`, { headers });
    assert.equal(response.status, 200);
    const data = record(record(await response.json(), "session").data, "session.data");
    return record(data.time, "session.data.time").archived;
  };

  await patch({ archived: true });
  const first = await archivedAt();
  assert.equal(typeof first, "number");

  await patch({ archived: true });
  assert.equal(await archivedAt(), first, "repeating archived: true keeps the original archive time");

  await patch({ archived: false });
  assert.equal(await archivedAt(), undefined);
});
