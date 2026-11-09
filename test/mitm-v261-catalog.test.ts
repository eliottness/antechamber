import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { events, record, serverFor, spawnCount } from "./catalog-harness.js";

async function createSession(url: string, directory: string): Promise<string> {
  const response = await fetch(`${url}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ location: { directory } }),
  });
  assert.equal(response.status, 200);
  const id = record(record(await response.json()).data).id;
  if (typeof id !== "string") throw new Error("Expected a session id");
  return id;
}

async function sendTurn(url: string, sessionID: string): Promise<void> {
  const response = await fetch(`${url}/api/session/${sessionID}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "check catalog" }),
  });
  assert.equal(response.status, 200);
}

test("generation returns text from an isolated agent without creating a session", async (t) => {
  const { url } = await serverFor(t);
  const response = await fetch(`${url}/api/experimental/generate/text`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "hello", model: { providerID: "fake", id: "fake-model" } }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { data: { text: "reply: hello" } });
  const sessions = await fetch(`${url}/api/session`);
  assert.deepEqual(record(await sessions.json()).data, []);
});

test("image-only model searches do not advertise text generation models", async (t) => {
  const { url } = await serverFor(t);
  const response = await fetch(`${url}/api/model?types=image`);
  assert.equal(response.status, 200);
  assert.deepEqual(record(await response.json()).data, []);
});

test("directory search returns matching ancestors typed as directories", async (t) => {
  const { root, url } = await serverFor(t);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "math.ts"), "");
  const response = await fetch(`${url}/api/fs/find?query=ma&type=directory`);
  assert.equal(response.status, 200);
  assert.deepEqual(record(await response.json()).data, [
    { path: "/", type: "directory" },
    { path: "src/", type: "directory" },
  ]);
});

test("watching a file emits filesystem.changed after an external edit", async (t) => {
  const { root, url } = await serverFor(t);
  writeFileSync(join(root, "notes.txt"), "before");
  const stream = await events(t, url);
  const response = await fetch(`${url}/api/experimental/fs/watch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "notes.txt" }),
  });
  assert.equal(response.status, 204);
  const changed = stream.wait("filesystem.changed");
  writeFileSync(join(root, "notes.txt"), "after");
  assert.deepEqual((await changed).data, { file: join(root, "notes.txt"), event: "change" });
});

test("an atomic save keeps the file watched", async (t) => {
  const { root, url } = await serverFor(t);
  const file = join(root, "notes.txt");
  writeFileSync(file, "before");
  const stream = await events(t, url);
  const response = await fetch(`${url}/api/experimental/fs/watch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "notes.txt" }),
  });
  assert.equal(response.status, 204);
  const saved = stream.wait("filesystem.changed");
  writeFileSync(join(root, "notes.txt.tmp"), "saved");
  renameSync(join(root, "notes.txt.tmp"), file);
  assert.equal((await saved).data.event, "change");
  const edited = stream.wait("filesystem.changed", undefined, stream.count("filesystem.changed"));
  writeFileSync(file, "edited");
  assert.equal((await edited).data.event, "change");
});

test("watching a missing file answers 404", async (t) => {
  const { url } = await serverFor(t);
  const response = await fetch(`${url}/api/experimental/fs/watch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "missing.txt" }),
  });
  assert.equal(response.status, 404);
  assert.equal(record(await response.json()).name, "FileNotFoundError");
});

test("one unwatch keeps a second file subscription active", async (t) => {
  const { root, url } = await serverFor(t);
  writeFileSync(join(root, "notes.txt"), "before");
  const body = JSON.stringify({ path: "notes.txt" });
  const headers = { "content-type": "application/json" };
  const stream = await events(t, url);
  for (let i = 0; i < 2; i++)
    assert.equal((await fetch(`${url}/api/experimental/fs/watch`, { method: "POST", headers, body })).status, 204);
  assert.equal((await fetch(`${url}/api/experimental/fs/watch`, { method: "DELETE", headers, body })).status, 204);
  const changed = stream.wait("filesystem.changed");
  writeFileSync(join(root, "notes.txt"), "after");
  assert.equal((await changed).data.event, "change");
});

test("creating a session in a new directory publishes project.updated", async (t) => {
  const { root, url } = await serverFor(t);
  const dir = join(root, "another");
  mkdirSync(dir);
  const stream = await events(t, url);
  const updated = stream.wait("project.updated");
  const response = await fetch(`${url}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ location: { directory: dir } }),
  });
  assert.equal(response.status, 200);
  assert.equal((await updated).data.id, dir);
});

test("a settled turn refreshes changed providers and models through its live agent", async (t) => {
  const { root, url, spawnLog } = await serverFor(t);
  const stream = await events(t, url);
  await fetch(`${url}/api/model`);
  const sessionID = await createSession(url, root);
  const idle = stream.wait("session.idle");
  await sendTurn(url, sessionID);
  await idle;
  await fetch(`${url}/api/model`);
  assert.equal(stream.count("provider.updated"), 0);
  assert.equal(stream.count("model.updated"), 0);
  const starts = spawnCount(spawnLog);
  const provider = stream.wait("provider.updated", 15_000);
  const model = stream.wait("model.updated", 15_000);
  writeFileSync(
    join(root, ".catalog-state.json"),
    JSON.stringify({
      models: [{ provider: "added", id: "new-model", name: "New model" }],
    }),
  );
  await sendTurn(url, sessionID);
  await Promise.all([provider, model]);
  assert.equal(spawnCount(spawnLog), starts);
  const response = await fetch(`${url}/api/model`);
  const models = record(await response.json()).data;
  if (!Array.isArray(models)) throw new Error("Expected models array");
  assert.equal(
    models.some((item: unknown) => record(item).id === "new-model"),
    true,
  );
});

test("a settled turn refreshes changed commands through its live agent", async (t) => {
  const { root, url, spawnLog } = await serverFor(t);
  const stream = await events(t, url);
  await fetch(`${url}/api/command`);
  const sessionID = await createSession(url, root);
  const idle = stream.wait("session.idle");
  await sendTurn(url, sessionID);
  await idle;
  await fetch(`${url}/api/command`);
  assert.equal(stream.count("command.updated"), 0);
  const starts = spawnCount(spawnLog);
  const updated = stream.wait("command.updated", 15_000);
  writeFileSync(
    join(root, ".catalog-state.json"),
    JSON.stringify({
      commands: [{ name: "changed", description: "New command" }],
    }),
  );
  await sendTurn(url, sessionID);
  await updated;
  assert.equal(spawnCount(spawnLog), starts);
  const response = await fetch(`${url}/api/command`);
  const commands = record(await response.json()).data;
  if (!Array.isArray(commands)) throw new Error("Expected commands array");
  assert.equal(
    commands.some((item: unknown) => record(item).name === "changed"),
    true,
  );
});

test("changing a linked Git HEAD publishes only real branch changes", async (t) => {
  const { root, url } = await serverFor(t);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  renameSync(join(root, ".git"), join(root, "gitdir"));
  writeFileSync(join(root, ".git"), "gitdir: gitdir\n");
  const stream = await events(t, url);
  const initial = await fetch(`${url}/api/vcs`);
  assert.equal(record(record(await initial.json()).data).branch !== undefined, true);
  writeFileSync(join(root, "gitdir", "HEAD"), "ref: refs/heads/main\n");
  assert.equal((await fetch(`${url}/api/vcs`)).status, 200);
  assert.equal(stream.count("vcs.branch.updated"), 0);
  const updated = stream.wait("vcs.branch.updated", 2_000);
  writeFileSync(join(root, "gitdir", "HEAD"), "ref: refs/heads/feature\n");
  assert.equal((await updated).data.branch, "feature");
});

test("usage limits without a Console login return null", async (t) => {
  const { root, url } = await serverFor(t);
  const response = await fetch(`${url}/api/experimental/usage/limits`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { location: { directory: root }, data: null });
});

test("debug locations list does not invent persistent instances", async (t) => {
  const { url } = await serverFor(t);
  const response = await fetch(`${url}/api/debug/location`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), []);
});
