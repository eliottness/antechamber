import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { AdapterServer } from "../src/server.js";
import { openEvents } from "./bug-harness.js";

const fixture = resolve("test/fixtures/fake-omo-endpoints.mjs");
type Event = { type: string; data: Record<string, unknown> };

function isEvent(value: Record<string, unknown>): value is Record<string, unknown> & Event {
  return typeof value.type === "string" && isRecord(value.data);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("expected a JSON object");
  return value;
}

async function server(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "antechamber-v261-sessions-"));
  const keys = ["ANTECHAMBER_PI_BINARY", "ANTECHAMBER_STATE_DIR", "PI_CODING_AGENT_DIR", "ANTECHAMBER_AGENT"];
  const saved = keys.map((key) => [key, process.env[key]] as const);
  process.env.ANTECHAMBER_PI_BINARY = fixture;
  process.env.ANTECHAMBER_STATE_DIR = join(root, "state");
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.ANTECHAMBER_AGENT = "OmO";
  let instance = new AdapterServer({ host: "127.0.0.1", port: 0, defaultDirectory: root });
  await instance.start();
  t.after(async () => {
    await instance.stop();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const request = (path: string, method = "GET", body?: unknown) =>
    fetch(`${instance.url}${path}`, {
      method,
      headers: {
        "x-opencode-directory": encodeURIComponent(root),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const create = async (body: Record<string, unknown> = {}) => {
    const response = await request("/api/session", "POST", { location: { directory: root }, ...body });
    assert.equal(response.status, 200, response.status === 200 ? undefined : await response.text());
    const id = record(record(await response.json()).data).id;
    if (typeof id !== "string") throw new Error("session id must be a string");
    return id;
  };
  return {
    request,
    create,
    root,
    get url() {
      return instance.url;
    },
    async restart() {
      await instance.stop();
      instance = new AdapterServer({ host: "127.0.0.1", port: 0, defaultDirectory: root });
      await instance.start();
    },
  };
}

async function events(t: TestContext, url: string) {
  const stream = await openEvents(`${url}/api/event`);
  t.after(() => stream.close());
  return {
    get received(): Event[] {
      return stream.frames.filter(isEvent);
    },
    wait(type: string, since = 0): Promise<Event> {
      const found = stream.frames.slice(since).find((event) => event.type === type);
      if (found && isEvent(found)) return Promise.resolve(found);
      return stream
        .wait((event) => event.type === type)
        .then((event) => {
          if (!isEvent(event)) throw new Error(`invalid SSE event: ${type}`);
          return event;
        });
    },
  };
}

function nativeEntries(root: string): Array<Record<string, unknown>> {
  return readdirSync(root)
    .filter((name) => name.startsWith("fake-endpoints-") && name.endsWith(".jsonl"))
    .flatMap((name) =>
      readFileSync(join(root, name), "utf8")
        .trim()
        .split("\n")
        .map((line) => record(JSON.parse(line))),
    );
}

test("root and archived session filters preserve the requested subset", async (t) => {
  const api = await server(t);
  const root = await api.create();
  await api.create({ parentID: root });
  const archived = await api.create();
  assert.equal((await api.request(`/api/session/${archived}`, "PATCH", { archived: true })).status, 204);
  const list = async (query: string): Promise<string[]> => {
    const data = record(await (await api.request(`/api/session?${query}`)).json()).data;
    assert.ok(Array.isArray(data));
    return data.map((session: unknown) => {
      const id = record(session).id;
      if (typeof id !== "string") throw new Error("session id must be a string");
      return id;
    });
  };
  assert.deepEqual((await list("parentID=null&archived=false")).sort(), [root]);
  assert.deepEqual(await list("archived=true"), [archived]);
  assert.equal((await list("archived=false")).includes(archived), false);
});

test("metadata updates do not announce an agent switch", async (t) => {
  const api = await server(t);
  const id = await api.create();
  const stream = await events(t, api.url);
  const done = stream.wait("session.metadata.updated");
  assert.equal((await api.request(`/api/session/${id}`, "PATCH", { metadata: { marker: 1 } })).status, 204);
  await done;
  assert.equal(stream.received.filter((event) => event.type === "session.agent.selected").length, 0);
});

test("an actual agent selection includes the previous agent", async (t) => {
  const api = await server(t);
  const id = await api.create({ agent: "build" });
  const stream = await events(t, api.url);
  const selected = stream.wait("session.agent.selected");
  assert.equal((await api.request(`/api/session/${id}/agent`, "POST", { agent: "OmO" })).status, 204);
  assert.deepEqual((await selected).data, { sessionID: id, agent: "OmO", previous: "build" });
});

test("metadata updates do not announce a rename, but a title change does", async (t) => {
  const api = await server(t);
  const id = await api.create();
  const stream = await events(t, api.url);
  const done = stream.wait("session.metadata.updated");
  await api.request(`/api/session/${id}`, "PATCH", { metadata: { marker: 1 } });
  await done;
  assert.equal(stream.received.filter((event) => event.type === "session.renamed").length, 0);
  const renamed = stream.wait("session.renamed");
  await api.request(`/api/session/${id}`, "PATCH", { title: "Renamed" });
  assert.equal((await renamed).data.title, "Renamed");
});

test("archive transitions emit once per state change", async (t) => {
  const api = await server(t);
  const id = await api.create();
  const stream = await events(t, api.url);
  const archived = stream.wait("session.archived");
  await api.request(`/api/session/${id}`, "PATCH", { archived: true });
  assert.equal((await archived).data.sessionID, id);
  const count = stream.received.length;
  const updated = stream.wait("session.metadata.updated", count);
  await api.request(`/api/session/${id}`, "PATCH", { archived: true, metadata: { repeated: true } });
  await updated;
  assert.equal(stream.received.slice(count).filter((event) => event.type === "session.archived").length, 0);
  const unarchived = stream.wait("session.unarchived");
  await api.request(`/api/session/${id}`, "PATCH", { archived: false });
  assert.equal((await unarchived).data.sessionID, id);
});

test("session creation includes its model before model-selection events", async (t) => {
  const api = await server(t);
  const stream = await events(t, api.url);
  const id = await api.create();
  const created = await stream.wait("session.created");
  assert.equal(created.data.sessionID, id);
  assert.deepEqual(created.data.model, { id: "fake-model", providerID: "fake", variant: "default" });
  const creationIndex = stream.received.indexOf(created);
  const selectionIndex = stream.received.findIndex((event) => event.type === "session.model.selected");
  assert.ok(selectionIndex < 0 || selectionIndex > creationIndex);
});

test("creation with a requested model publishes the resolved model first", async (t) => {
  const api = await server(t);
  const stream = await events(t, api.url);
  const id = await api.create({ model: { providerID: "fake", id: "requested" } });
  const created = await stream.wait("session.created");
  assert.equal(created.data.sessionID, id);
  assert.deepEqual(created.data.model, { id: "requested", providerID: "fake", variant: "default" });
  assert.equal(
    stream.received.findIndex((event) => event.type === "session.model.selected"),
    -1,
  );
});

test("inbox exposes an admitted pending input", async (t) => {
  const api = await server(t);
  const id = await api.create();
  const stream = await events(t, api.url);
  const enqueued = stream.wait("session.inbox.enqueued");
  const prompt = await api.request(`/api/session/${id}/prompt`, "POST", {
    text: "fixture-hold-input",
    id: "msg_pending_input",
    delivery: "queue",
  });
  assert.equal(prompt.status, 200);
  await enqueued;
  const response = await api.request(`/api/session/${id}/inbox`);
  assert.equal(response.status, 200);
  const rows = record(await response.json()).data;
  assert.ok(Array.isArray(rows));
  assert.equal(typeof record(record(rows[0]).time).created, "number");
  const expected = [
    {
      id: "msg_pending_input",
      sessionID: id,
      type: "user",
      delivery: "queue",
      payload: { text: "fixture-hold-input" },
    },
  ];
  assert.deepEqual(
    rows.map((row: unknown) => {
      const { time: _time, ...entry } = record(row);
      return entry;
    }),
    expected,
  );
  await api.restart();
  const restored = await api.request(`/api/session/${id}/inbox`);
  assert.equal(restored.status, 200);
  const restoredRows = record(await restored.json()).data;
  assert.ok(Array.isArray(restoredRows));
  assert.equal(typeof record(record(restoredRows[0]).time).created, "number");
  assert.deepEqual(
    restoredRows.map((row: unknown) => {
      const { time: _time, ...entry } = record(row);
      return entry;
    }),
    expected,
  );
});

test("view advances a durable watermark without regressing on an older idle", async (t) => {
  const api = await server(t);
  const id = await api.create();
  const stream = await events(t, api.url);
  const viewed = stream.wait("session.viewed");
  void viewed.catch(() => undefined);
  assert.equal((await api.request(`/api/session/${id}/view`, "POST", { idle: 1234 })).status, 204);
  assert.equal((await viewed).data.idle, 1234);
  assert.equal((await api.request(`/api/session/${id}/view`, "POST", { idle: 1233 })).status, 204);
  await api.restart();
  const response = await api.request(`/api/session/${id}`);
  assert.equal(record(record(record(await response.json()).data).time).viewed, 1234);
});

test("instruction PUT delivers a hidden context block before the next user prompt after restart", async (t) => {
  const api = await server(t);
  const id = await api.create();
  const response = await api.request(`/api/experimental/session/${id}/instructions/entries/notes`, "PUT", {
    value: "Review the requirements",
  });
  assert.equal(response.status, 204);
  await api.restart();
  const stream = await events(t, api.url);
  const enqueued = stream.wait("session.inbox.enqueued");
  await api.request(`/api/session/${id}/prompt`, "POST", { text: "Hello" });
  await enqueued;
  const entries = nativeEntries(api.root);
  const context = entries.findIndex((entry) => entry.customType === "antechamber.instructions");
  const prompt = entries.findIndex((entry) => entry.type === "message" && record(entry.message).role === "user");
  assert.ok(context >= 0 && context < prompt);
  assert.deepEqual(entries[context]?.content, [
    { type: "text", text: '<context key="notes">\nReview the requirements\n</context>' },
  ]);
  assert.equal(entries[context]?.display, false);
});

test("a rejected instruction delivery does not block the prompt and is retried on the next one", async (t) => {
  const saved = process.env.FAKE_OMO_REJECT_INSTRUCTIONS;
  t.after(() => {
    if (saved === undefined) delete process.env.FAKE_OMO_REJECT_INSTRUCTIONS;
    else process.env.FAKE_OMO_REJECT_INSTRUCTIONS = saved;
  });
  process.env.FAKE_OMO_REJECT_INSTRUCTIONS = "once";
  const api = await server(t);
  const id = await api.create();
  const path = `/api/experimental/session/${id}/instructions/entries/notes`;
  assert.equal((await api.request(path, "PUT", { value: "Review the requirements" })).status, 204);
  const stream = await events(t, api.url);
  const first = stream.wait("session.inbox.enqueued");
  assert.equal((await api.request(`/api/session/${id}/prompt`, "POST", { text: "First" })).status, 200);
  await first;
  const users = () =>
    nativeEntries(api.root).filter((entry) => entry.type === "message" && record(entry.message).role === "user");
  assert.equal(users().length, 1);
  assert.equal(nativeEntries(api.root).filter((entry) => entry.customType === "antechamber.instructions").length, 0);
  const second = stream.wait("session.inbox.enqueued", stream.received.length);
  await api.request(`/api/session/${id}/prompt`, "POST", { text: "Second" });
  await second;
  assert.equal(nativeEntries(api.root).filter((entry) => entry.customType === "antechamber.instructions").length, 1);
});

test("repeated PUT of unchanged guidance does not resend it on the next prompt", async (t) => {
  const api = await server(t);
  const id = await api.create();
  const path = `/api/experimental/session/${id}/instructions/entries/notes`;
  assert.equal((await api.request(path, "PUT", { value: { rule: "Stay focused" } })).status, 204);
  const stream = await events(t, api.url);
  const first = stream.wait("session.inbox.enqueued");
  await api.request(`/api/session/${id}/prompt`, "POST", { text: "First" });
  await first;
  assert.equal((await api.request(path, "PUT", { value: { rule: "Stay focused" } })).status, 204);
  const second = stream.wait("session.inbox.enqueued", stream.received.length);
  await api.request(`/api/session/${id}/prompt`, "POST", { text: "Second" });
  await second;
  const context = nativeEntries(api.root).filter((entry) => entry.customType === "antechamber.instructions");
  assert.equal(context.length, 1);
  assert.deepEqual(context[0]?.content, [
    { type: "text", text: '<context key="notes">\n{\n  "rule": "Stay focused"\n}\n</context>' },
  ]);
});

test("deleting delivered guidance sends the explicit removal once", async (t) => {
  const api = await server(t);
  const id = await api.create();
  const path = `/api/experimental/session/${id}/instructions/entries/notes`;
  assert.equal((await api.request(path, "PUT", { value: "Obsolete" })).status, 204);
  const stream = await events(t, api.url);
  const first = stream.wait("session.inbox.enqueued");
  await api.request(`/api/session/${id}/prompt`, "POST", { text: "First" });
  await first;
  assert.equal((await api.request(path, "DELETE")).status, 204);
  const second = stream.wait("session.inbox.enqueued", stream.received.length);
  await api.request(`/api/session/${id}/prompt`, "POST", { text: "Second" });
  await second;
  assert.equal((await api.request(path, "DELETE")).status, 204);
  const third = stream.wait("session.inbox.enqueued", stream.received.length);
  await api.request(`/api/session/${id}/prompt`, "POST", { text: "Third" });
  await third;
  const context = nativeEntries(api.root).filter((entry) => entry.customType === "antechamber.instructions");
  assert.deepEqual(
    context.map((entry) => entry.content),
    [
      [{ type: "text", text: '<context key="notes">\nObsolete\n</context>' }],
      [{ type: "text", text: 'The context under "notes" no longer applies. Disregard it.' }],
    ],
  );
});

test("deleting an absent instruction entry is idempotent", async (t) => {
  const api = await server(t);
  const id = await api.create();
  assert.equal(
    (await api.request(`/api/experimental/session/${id}/instructions/entries/absent`, "DELETE")).status,
    204,
  );
});

test("successful compaction rearms active instructions for the following prompt", async (t) => {
  const api = await server(t);
  const id = await api.create();
  assert.equal(
    (await api.request(`/api/experimental/session/${id}/instructions/entries/notes`, "PUT", { value: "Keep" })).status,
    204,
  );
  const stream = await events(t, api.url);
  const first = stream.wait("session.inbox.enqueued");
  await api.request(`/api/session/${id}/prompt`, "POST", { text: "First" });
  await first;
  assert.equal((await api.request(`/api/session/${id}/compact`, "POST", {})).status, 200);
  const second = stream.wait("session.inbox.enqueued", stream.received.length);
  await api.request(`/api/session/${id}/prompt`, "POST", { text: "Second" });
  await second;
  const context = nativeEntries(api.root).filter((entry) => entry.customType === "antechamber.instructions");
  assert.deepEqual(
    context.map((entry) => entry.content),
    [
      [{ type: "text", text: '<context key="notes">\nKeep\n</context>' }],
      [{ type: "text", text: '<context key="notes">\nKeep\n</context>' }],
    ],
  );
});
