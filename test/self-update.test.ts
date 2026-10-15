import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { upgrade } from "../src/commands/upgrade.js";
import {
  fetchLatestVersion,
  installMethod,
  isNewerVersion,
  type SelfUpdateDeps,
  type SelfUpdateResult,
  SelfUpdateUnsupportedError,
  selfUpdate,
} from "../src/self-update.js";
import { AdapterServer } from "../src/server.js";

function install(t: TestContext, ...segments: string[]) {
  const home = fs.mkdtempSync(join(tmpdir(), "antechamber-self-update-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const packageRoot = join(home, ...segments);
  fs.mkdirSync(packageRoot, { recursive: true });
  const npmGlobal = join(home, "npm", "lib", "node_modules");
  const calls: string[][] = [];
  const deps: SelfUpdateDeps = {
    packageRoot,
    env: {},
    home,
    realpath: fs.realpathSync,
    npmBinary: "/opt/node/bin/npm",
    bunBinary: join(home, ".bun", "bin", "bun"),
    npmRoot: async () => {
      calls.push(["npm", "root", "-g"]);
      return `${npmGlobal}\n`;
    },
    currentVersion: "0.2.2",
    latestVersion: async () => {
      calls.push(["registry"]);
      return "0.2.3";
    },
    install: async (binary, args) => {
      calls.push([binary, ...args]);
    },
  };
  return { home, deps, calls, npmGlobal };
}

const installs = (calls: string[][]) => calls.filter(([, command]) => command === "install" || command === "add");

test("installMethod refuses a source checkout without running npm", (t) => {
  const { deps } = install(t, "git", "antechamber");
  assert.throws(
    () =>
      installMethod(deps, () => {
        throw new Error("npm must not run");
      }),
    SelfUpdateUnsupportedError,
  );
});

test("installMethod recognizes global npm and bun installs and refuses the npx cache", (t) => {
  const npm = install(t, "npm", "lib", "node_modules", "antechamber");
  assert.equal(
    installMethod(npm.deps, () => npm.npmGlobal),
    "npm",
  );
  const bun = install(t, ".bun", "install", "global", "node_modules", "antechamber");
  assert.equal(
    installMethod(bun.deps, () => {
      throw new Error("npm must not run for bun");
    }),
    "bun",
  );
  const npx = install(t, ".npm", "_npx", "abc123", "node_modules", "antechamber");
  assert.throws(() => installMethod(npx.deps, () => npx.npmGlobal), SelfUpdateUnsupportedError);
});

test("a missing npm is reported as unavailable rather than as a non-global install", (t) => {
  const { deps } = install(t, "npm", "lib", "node_modules", "antechamber");
  const missing = () => {
    throw Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" });
  };
  assert.throws(
    () => installMethod(deps, missing),
    (error: unknown) => error instanceof SelfUpdateUnsupportedError && error.message.includes("ENOENT"),
  );
});

test("isNewerVersion follows semver precedence", () => {
  assert.equal(isNewerVersion("0.2.10", "0.2.9"), true);
  assert.equal(isNewerVersion("1.0.0", "0.9.9"), true);
  assert.equal(isNewerVersion("0.2.2", "0.2.2"), false);
  assert.equal(isNewerVersion("0.2.1", "0.2.2"), false);
  assert.equal(isNewerVersion("0.3.0", "0.3.0-rc.1"), true);
  assert.equal(isNewerVersion("0.3.0-rc.1", "0.3.0"), false);
  assert.equal(isNewerVersion("0.3.0-rc.10", "0.3.0-rc.9"), true);
  assert.equal(isNewerVersion("0.3.0-rc.1.1", "0.3.0-rc.1"), true);
  assert.equal(isNewerVersion("0.3.0-beta", "0.3.0-1"), true);
  assert.equal(isNewerVersion("garbage", "0.2.2"), false);
});

test("selfUpdate installs the exact latest version with the resolved package manager binary", async (t) => {
  const npm = install(t, "npm", "lib", "node_modules", "antechamber");
  assert.deepEqual(await selfUpdate(npm.deps), { updated: true, from: "0.2.2", to: "0.2.3", method: "npm" });
  assert.deepEqual(installs(npm.calls), [["/opt/node/bin/npm", "install", "-g", "antechamber@0.2.3"]]);

  const bun = install(t, ".bun", "install", "global", "node_modules", "antechamber");
  await selfUpdate(bun.deps);
  assert.deepEqual(installs(bun.calls), [[bun.deps.bunBinary, "add", "-g", "antechamber@0.2.3"]]);
});

test("selfUpdate skips the installer when already current", async (t) => {
  const { deps, calls } = install(t, "npm", "lib", "node_modules", "antechamber");
  const result = await selfUpdate({ ...deps, currentVersion: "0.2.3" });
  assert.deepEqual(result, { updated: false, from: "0.2.3", to: "0.2.3", method: "npm" });
  assert.deepEqual(installs(calls), []);
});

test("concurrent selfUpdate callers share one installer run", async (t) => {
  const { deps, calls } = install(t, "npm", "lib", "node_modules", "antechamber");
  const [first, second] = await Promise.all([selfUpdate(deps), selfUpdate(deps)]);
  assert.deepEqual(first, second);
  assert.equal(installs(calls).length, 1);
});

test("selfUpdate rejects unsupported installs before contacting the registry", async (t) => {
  const { deps, calls } = install(t, "git", "antechamber");
  await assert.rejects(selfUpdate(deps), SelfUpdateUnsupportedError);
  assert.deepEqual(calls, []);
});

async function registry(t: TestContext, status: number, body: unknown) {
  const seen: Array<{ url: string | undefined; authorization: string | undefined }> = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization });
    res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { port: (server.address() as AddressInfo).port, seen };
}

test("fetchLatestVersion reads the registry's latest tag and strips URL credentials", async (t) => {
  const { port, seen } = await registry(t, 200, { version: "0.2.3" });
  const version = await fetchLatestVersion({ npm_config_registry: `http://user:s3cret@127.0.0.1:${port}/` });
  assert.equal(version, "0.2.3");
  assert.deepEqual(seen, [{ url: "/antechamber/latest", authorization: undefined }]);
});

test("fetchLatestVersion rejects bad answers without echoing registry credentials", async (t) => {
  const { port } = await registry(t, 200, { version: "not-a-version" });
  await assert.rejects(fetchLatestVersion({ npm_config_registry: `http://127.0.0.1:${port}` }));
  const closed = await registry(t, 404, {});
  await assert.rejects(fetchLatestVersion({ npm_config_registry: `http://127.0.0.1:${closed.port}` }));
  await assert.rejects(
    fetchLatestVersion({ npm_config_registry: "http://user:s3cret@127.0.0.1:1" }),
    (error: unknown) => error instanceof Error && !error.message.includes("s3cret"),
  );
});

async function upgradeServer(t: TestContext, update: () => Promise<SelfUpdateResult>) {
  const directory = fs.mkdtempSync(join(tmpdir(), "antechamber-upgrade-route-"));
  const previous = process.env.ANTECHAMBER_STATE_DIR;
  process.env.ANTECHAMBER_STATE_DIR = join(directory, "state");
  const server = new AdapterServer({ host: "127.0.0.1", port: 0, defaultDirectory: directory, selfUpdate: update });
  t.after(async () => {
    await server.stop();
    if (previous === undefined) delete process.env.ANTECHAMBER_STATE_DIR;
    else process.env.ANTECHAMBER_STATE_DIR = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await server.start();
  return (body: unknown) =>
    fetch(`${server.url}/global/upgrade`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
}

test("POST /global/upgrade returns the installed antechamber version and ignores the OpenCode target", async (t) => {
  const post = await upgradeServer(t, async () => ({ updated: true, from: "0.2.2", to: "0.2.3", method: "npm" }));
  const response = await post({ target: "1.18.23" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, version: "0.2.3", updated: true });
});

test("POST /global/upgrade maps unsupported installs to 409 and failures to 500", async (t) => {
  const unsupported = await upgradeServer(t, async () => {
    throw new SelfUpdateUnsupportedError("not global");
  });
  const refused = await unsupported({});
  assert.equal(refused.status, 409);
  assert.equal(((await refused.json()) as { name: string }).name, "UnsupportedError");

  const failing = await upgradeServer(t, async () => {
    throw new Error("npm install -g antechamber@0.2.3 failed");
  });
  const failed = await failing({});
  assert.equal(failed.status, 500);
  assert.equal(((await failed.json()) as { name: string }).name, "UnknownError");
});

test("upgrade prints both versions and the package manager", async () => {
  const lines: string[] = [];
  await upgrade(
    async () => ({ updated: true, from: "0.2.2", to: "0.2.3", method: "npm" }),
    (line) => lines.push(line),
  );
  await upgrade(
    async () => ({ updated: false, from: "0.2.3", to: "0.2.3", method: "bun" }),
    (line) => lines.push(line),
  );
  assert.equal(lines.length, 2);
  assert.ok(["0.2.2", "0.2.3", "npm"].every((token) => lines[0]?.includes(token)));
  assert.ok(lines[1]?.includes("0.2.3"));
});
