import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { events, record, serverFor, spawnCount } from "./catalog-harness.js";

test("an idle SSE connection never starts catalog agents", { timeout: 30_000 }, async (t) => {
  const { url, spawnLog } = await serverFor(t);
  const stream = await events(t, url);
  assert.equal((await fetch(`${url}/api/model`)).status, 200);
  assert.equal((await fetch(`${url}/api/command`)).status, 200);
  const initial = spawnCount(spawnLog);
  assert.equal(initial, 2);

  await stream.heartbeat();
  await stream.heartbeat();
  assert.equal(spawnCount(spawnLog), initial);
  assert.equal(stream.count("provider.updated"), 0);
  assert.equal(stream.count("command.updated"), 0);
});

test("cold reads refresh only after sixty seconds and publish changed catalogs", { timeout: 35_000 }, async (t) => {
  const { root, url, spawnLog } = await serverFor(t);
  const stream = await events(t, url);
  await fetch(`${url}/api/model`);
  await fetch(`${url}/api/command`);
  const starts = spawnCount(spawnLog);
  writeFileSync(
    join(root, ".catalog-state.json"),
    JSON.stringify({
      models: [{ provider: "added", id: "new-model" }],
      commands: [{ name: "new-command", description: "Changed" }],
    }),
  );

  await stream.heartbeat();
  await stream.heartbeat();
  const cachedModels = record(await (await fetch(`${url}/api/model`)).json()).data;
  const cachedCommands = record(await (await fetch(`${url}/api/command`)).json()).data;
  assert.equal(spawnCount(spawnLog), starts);
  assert.equal(JSON.stringify(cachedModels).includes("new-model"), false);
  assert.equal(JSON.stringify(cachedCommands).includes("new-command"), false);
  assert.equal(stream.count("provider.updated"), 0);
  assert.equal(stream.count("command.updated"), 0);

  const actualNow = Date.now;
  try {
    Date.now = () => actualNow() + 61_000;
    assert.equal((await fetch(`${url}/api/agent`)).status, 200);
    assert.equal((await fetch(`${url}/api/model/default`)).status, 200);
    assert.equal(spawnCount(spawnLog), starts, "auxiliary reads do not refresh a cold catalog");
    const provider = stream.wait("provider.updated");
    const model = stream.wait("model.updated");
    const command = stream.wait("command.updated");
    assert.equal((await fetch(`${url}/api/model`)).status, 200);
    assert.equal((await fetch(`${url}/api/command`)).status, 200);
    await Promise.all([provider, model, command]);
  } finally {
    Date.now = actualNow;
  }
  assert.equal(spawnCount(spawnLog), starts + 2);
});

test("turns in sessions on different models do not change the configured catalog", { timeout: 30_000 }, async (t) => {
  const { root, url } = await serverFor(t);
  writeFileSync(
    join(root, ".catalog-state.json"),
    JSON.stringify({
      models: [
        { provider: "fake", id: "fake-model" },
        { provider: "other", id: "other-model" },
      ],
    }),
  );
  const stream = await events(t, url);
  const json = async (path: string, method = "GET", body?: unknown) =>
    record(
      await (
        await fetch(`${url}${path}`, {
          method,
          ...(body === undefined
            ? {}
            : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        })
      ).json(),
    ).data;
  const configured = await json("/api/model/default");
  const create = async (body: Record<string, unknown>) =>
    record(await json("/api/session", "POST", { location: { directory: root }, ...body })).id;
  const plain = await create({});
  const other = await create({ model: { providerID: "other", id: "other-model" } });
  for (const id of [other, plain, other, plain]) {
    const idle = stream.wait("session.idle", undefined, stream.count("session.idle"));
    await json(`/api/session/${id}/prompt`, "POST", { text: "turn" });
    await idle;
    // The idle refresh is already in flight when idle reaches the client; this read waits for it.
    assert.deepEqual(await json("/api/model/default"), configured);
  }
  // Every frame before the rename has been delivered once the rename arrives.
  const renamed = stream.wait("session.renamed", undefined, stream.count("session.renamed"));
  await fetch(`${url}/api/session/${plain}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "sentinel" }),
  });
  await renamed;
  assert.equal(stream.count("provider.updated"), 0);
  assert.equal(stream.count("model.updated"), 0);
});
