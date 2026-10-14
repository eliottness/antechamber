import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { AdapterServer } from "../src/server.js";

const endpointRpc = resolve("test/fixtures/fake-omo-endpoints.mjs");
const bootstrapGolden = JSON.parse(
  readFileSync(resolve("test/fixtures/mitm-v124/bootstrap-resources.json"), "utf8"),
) as {
  responses: Record<string, unknown>;
};
const projectGolden = JSON.parse(
  readFileSync(resolve("test/fixtures/mitm-v124/project-vcs-resources.json"), "utf8"),
) as {
  responses: { project: unknown; vcs: unknown };
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

function assertGoldenShape(actual: unknown, expected: unknown, path = "$"): void {
  if (expected === null) {
    assert.equal(actual, null, `${path} must be null`);
    return;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) assert.fail(`${path} must be an array`);
    const actualArray = actual as unknown[];
    if (expected.length > 0 && path !== "$.plugin") {
      assert.ok(actualArray.length > 0, `${path} must contain a captured item`);
      assertGoldenShape(actualArray[0], expected[0], `${path}[0]`);
    }
    return;
  }
  if (isRecord(expected)) {
    if (!isRecord(actual)) assert.fail(`${path} must be an object`);
    const actualRecord = actual as Record<string, unknown>;
    for (const [key, value] of Object.entries(expected)) {
      assert.ok(Object.hasOwn(actualRecord, key), `${path}.${key} must be present`);
      assertGoldenShape(actualRecord[key], value, `${path}.${key}`);
    }
    return;
  }
  assert.equal(typeof actual, typeof expected, `${path} must be a ${typeof expected}`);
}

async function startServer(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "antechamber-mitm-v124-misc-"));
  const saved = new Map(
    ["ANTECHAMBER_PI_BINARY", "ANTECHAMBER_STATE_DIR", "PI_CODING_AGENT_DIR"].map((key) => [key, process.env[key]]),
  );
  process.env.ANTECHAMBER_PI_BINARY = endpointRpc;
  process.env.ANTECHAMBER_STATE_DIR = join(directory, "state");
  process.env.PI_CODING_AGENT_DIR = join(directory, "pi");
  const server = new AdapterServer({ host: "127.0.0.1", port: 0, defaultDirectory: directory });
  t.after(async () => {
    await server.stop();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  await server.start();
  return { directory, url: server.url };
}

async function getJson(url: string, path: string): Promise<unknown> {
  const response = await fetch(`${url}${path}`, { headers: { accept: "application/json" } });
  assert.equal(response.status, 200, `${path} must return 200`);
  return response.json();
}

test("MITM124-04: bootstrap resources preserve captured OpenCode metadata", { timeout: 10_000 }, async (t) => {
  const { directory, url } = await startServer(t);
  const globalConfig = await getJson(url, "/global/config");
  const config = await getJson(url, `/config?directory=${encodeURIComponent(directory)}`);
  const agent = await getJson(url, "/agent");
  const command = await getJson(url, "/command");

  assertGoldenShape(globalConfig, bootstrapGolden.responses.globalConfig);
  assertGoldenShape(config, bootstrapGolden.responses.config);
  assertGoldenShape(agent, bootstrapGolden.responses.agent);
  assertGoldenShape(command, bootstrapGolden.responses.command);
});

test("MITM124-05: project and VCS resources preserve captured compatibility fields", { timeout: 10_000 }, async (t) => {
  const { directory, url } = await startServer(t);
  const query = `?directory=${encodeURIComponent(directory)}`;
  const current = await getJson(url, `/project/current${query}`);
  const projects = await getJson(url, `/project${query}`);
  const vcs = await getJson(url, `/vcs${query}`);

  assertGoldenShape(current, projectGolden.responses.project);
  assertGoldenShape(projects, [projectGolden.responses.project]);
  assertGoldenShape(vcs, projectGolden.responses.vcs);
});
