import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { AdapterServer } from "../src/server.js";

const endpointFixture = resolve("test/fixtures/fake-omo-endpoints.mjs");

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): RecordValue {
  assert.ok(isRecord(value), `${label} must be an object`);
  return value as RecordValue;
}

async function startServer(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "antechamber-v232-misc-"));
  const saved = new Map(
    ["ANTECHAMBER_PI_BINARY", "ANTECHAMBER_STATE_DIR", "PI_CODING_AGENT_DIR"].map((key) => [key, process.env[key]]),
  );
  process.env.ANTECHAMBER_PI_BINARY = endpointFixture;
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

async function postJson(url: string, path: string, body: unknown) {
  return fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("V232-011: config returns a bare ConfigEntry list OpenChamber can fold", async (t) => {
  const { url } = await startServer(t);
  const response = await fetch(`${url}/api/config`);
  assert.equal(response.status, 200);
  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) assert.fail("OpenChamber 2.3.2 iterates /api/config directly");
  assert.ok(payload.every((entry) => isRecord(entry) && typeof entry.type === "string"));
  const document = payload.find((entry) => isRecord(entry) && entry.type === "document");
  const info = record(record(document, "config document").info, "config document info");
  assert.equal(typeof info.default_agent, "string");
});

test("V232-031b: bootstrap inventories without OmO equivalents return empty located lists", async (t) => {
  const { url } = await startServer(t);
  for (const path of ["/api/shell", "/api/websearch/provider"]) {
    const response = await fetch(`${url}${path}`);
    assert.equal(response.status, 200, path);
    const payload = record(await response.json(), path);
    assert.ok(isRecord(payload.location), `${path} location`);
    assert.deepEqual(payload.data, [], path);
  }
});

test("V232-012: rejects credential creation without retaining secrets", async (t) => {
  const { root, url } = await startServer(t);
  const save = await postJson(url, "/api/credential", {
    id: "credential_v232",
    integrationID: "fake",
    label: "OpenChamber",
    value: "secret",
    activate: true,
  });
  assert.equal(save.status, 400);
  assert.deepEqual(await save.json(), {
    name: "UnsupportedError",
    data: { message: "Credential management is not available; configure providers in OmO" },
  });
  const list = await fetch(`${url}/api/credential`);
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), { location: { directory: root }, data: [] });
});

test("credential deletion is an idempotent empty no-op", async (t) => {
  const { url } = await startServer(t);
  for (let i = 0; i < 2; i++) {
    const response = await fetch(`${url}/api/credential/unknown`, { method: "DELETE" });
    assert.equal(response.status, 204);
    assert.equal(await response.text(), "");
  }
});

test("V232-013: decodes URI-marked location headers", async (t) => {
  const { url } = await startServer(t);
  const directory = "/tmp/v232 repo name";
  const response = await fetch(`${url}/api/location`, {
    headers: {
      "x-opencode-directory": encodeURIComponent(directory),
      "x-opencode-directory-encoding": "uri",
    },
  });
  assert.equal(response.status, 200);
  const payload = record(await response.json(), "location response");
  assert.equal(payload.directory, directory);
});

test("V232-028: VCS summary exposes branch identity", async (t) => {
  const { root, url } = await startServer(t);
  execFileSync("git", ["init", "-q", root]);
  const response = await fetch(`${url}/api/vcs?location=${encodeURIComponent(root)}`);
  assert.equal(response.status, 200);
  const payload = record(await response.json(), "vcs response");
  const data = record(payload.data, "vcs data");
  const branch = record(data.branch, "vcs branch");
  assert.equal(typeof branch.current, "string");
});

test("V232-029: initializes a Git repository", async (t) => {
  const { root, url } = await startServer(t);
  const response = await postJson(url, `/api/vcs/init?location=${encodeURIComponent(root)}`, {});
  assert.equal(response.status, 204);
  assert.equal(
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, encoding: "utf8" }).trim(),
    "true",
  );
});

test("V232-030: finds indexed workspace files", async (t) => {
  const { root, url } = await startServer(t);
  writeFileSync(join(root, "needle.ts"), "export const needle = true;\n");
  const response = await fetch(
    `${url}/api/fs/find?location=${encodeURIComponent(root)}&query=needle&type=file&limit=10`,
  );
  assert.equal(response.status, 200);
  const payload = record(await response.json(), "file search response");
  assert.equal(Array.isArray(payload.data), true);
  assert.ok((payload.data as unknown[]).some((entry) => record(entry, "file entry").path === "needle.ts"));
});

test("V232-031: MCP lists no servers and explicitly rejects mutations", async (t) => {
  const { url } = await startServer(t);
  const [list, connect, disconnect] = await Promise.all([
    fetch(`${url}/api/mcp`),
    postJson(url, "/api/experimental/mcp/demo/connect", {}),
    postJson(url, "/api/experimental/mcp/demo/disconnect", {}),
  ]);
  assert.equal(list.status, 200);
  assert.deepEqual(record(await list.json(), "mcp list").data, []);
  for (const response of [connect, disconnect]) {
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      name: "UnsupportedError",
      data: { message: "MCP is not available with OmO" },
    });
  }
});

test("V232-032: inventories provider integrations", async (t) => {
  const { url } = await startServer(t);
  const response = await fetch(`${url}/api/integration`);
  assert.equal(response.status, 200);
  const payload = record(await response.json(), "integration response");
  assert.equal(Array.isArray(payload.data), true);
});

test("V232-035: location eviction answers OpenCode's empty 204", async (t) => {
  const { root, url } = await startServer(t);
  const response = await fetch(`${url}/api/debug/location?location=${encodeURIComponent(root)}`, { method: "DELETE" });
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
});

test("V232-036: reports experimental session usage statistics", async (t) => {
  const { url } = await startServer(t);
  const response = await fetch(`${url}/api/experimental/session/stats?from=0&to=1&timezone=UTC&tools=none`);
  assert.ok(
    response.status === 200 ||
      (response.status === 400 &&
        JSON.stringify(await response.clone().json()) ===
          JSON.stringify({
            name: "UnsupportedError",
            data: { message: "Session statistics are not available with OmO" },
          })),
  );
});

test("plugins expose empty read-only inventories and reject updates", async (t) => {
  const { root, url } = await startServer(t);
  for (const response of [
    await fetch(`${url}/api/plugin`),
    await postJson(url, "/api/plugin/check", {}),
    await postJson(url, "/api/plugin/check", { target: "example" }),
  ]) {
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { location: { directory: root }, data: [] });
  }
  const update = await postJson(url, "/api/plugin/update", { targets: ["example"] });
  assert.equal(update.status, 400);
  assert.deepEqual(await update.json(), {
    name: "UnsupportedError",
    data: { message: "Plugin updates are not available with OmO" },
  });
});

test("experimental generation reports the captured unavailable service shape", async (t) => {
  const { url } = await startServer(t);
  const response = await postJson(url, "/api/experimental/generate", { prompt: "Generate a recap" });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    _tag: "ServiceUnavailableError",
    message: "No generation model is available through antechamber/OmO",
    service: "opencode",
  });
});

for (const action of ["generate", "background", "move"]) {
  test(`session ${action} is explicitly unsupported but unknown sessions remain 404`, async (t) => {
    const { url } = await startServer(t);
    const created = await postJson(url, "/api/session", {});
    assert.equal(created.status, 200);
    const id = record(record(await created.json(), "created session").data, "session").id;
    assert.equal(typeof id, "string");
    const response = await postJson(url, `/api/session/${id}/${action}`, {});
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      name: "UnsupportedError",
      data: { message: `Session ${action} is not available with OmO` },
    });
    const missing = await postJson(url, `/api/session/unknown/${action}`, {});
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), {
      name: "NotFoundError",
      data: { message: "session not found: unknown" },
    });
  });
}

for (const [method, suffix] of [
  ["PATCH", ""],
  ["POST", "/activate"],
] as const) {
  test(`credential ${method} ${suffix || "update"} rejects unsupported management`, async (t) => {
    const { url } = await startServer(t);
    const response = await fetch(`${url}/api/credential/example${suffix}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "Updated" }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      name: "UnsupportedError",
      data: { message: "Credential management is not available; configure providers in OmO" },
    });
  });
}

test("an empty integration inventory has no detail resources", async (t) => {
  const { url } = await startServer(t);
  const response = await fetch(`${url}/api/integration/example`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    name: "NotFoundError",
    data: { message: "integration not found: example" },
  });
});

for (const [method, subpath] of [
  ["POST", "key"],
  ["POST", "external"],
  ["POST", "oauth"],
  ["POST", "command"],
  ["GET", "oauth/attempt"],
  ["DELETE", "oauth/attempt"],
  ["POST", "oauth/attempt/complete"],
  ["GET", "command/attempt"],
  ["DELETE", "command/attempt"],
] as const) {
  test(`integration ${method} connect/${subpath} directs configuration to OmO`, async (t) => {
    const { url } = await startServer(t);
    const response = await fetch(`${url}/api/integration/example/connect/${subpath}`, { method });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      name: "UnsupportedError",
      data: { message: "Integration connections are not available; configure providers in OmO" },
    });
  });
}

test("project updates reject unsupported mutations", async (t) => {
  const { url } = await startServer(t);
  const response = await fetch(`${url}/api/project/example`, {
    method: "PATCH",
    body: JSON.stringify({ canonical: "/tmp/renamed" }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    name: "UnsupportedError",
    data: { message: "Project updates are not available with OmO" },
  });
});
