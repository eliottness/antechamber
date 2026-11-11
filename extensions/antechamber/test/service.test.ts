import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type InstallDeps, runtimePaths } from "../src/runtime/runtime.ts";
import { createService, type RuntimeStatus } from "../src/service.ts";

const TOKEN = "service-test-token";

async function start(
  t: { after: (fn: () => void) => void },
  bun: string | undefined,
  deps: InstallDeps,
  extensionPath = "ext",
) {
  const root = mkdtempSync(join(tmpdir(), "antechamber-service-"));
  const paths = runtimePaths("2.0.0", { env: { ANTECHAMBER_RUNTIME_DIR: join(root, "runtime") }, home: root });
  const server = createService({ token: TOKEN, extensionDir: join(root, extensionPath), paths, bun, deps });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => {
    server.close();
    rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, token = TOKEN) => {
    const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}` } });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return { call, root };
}

function installer() {
  let release!: () => void;
  const finished = new Promise<void>((done) => {
    release = done;
  });
  const deps: InstallDeps = {
    install: async (_bun, cwd) => {
      for (const [name, version] of [
        ["antechamber", "2.0.0"],
        ["omo-ai", "5.1.69"],
      ] as const) {
        mkdirSync(join(cwd, "node_modules", name, "dist"), { recursive: true });
        writeFileSync(join(cwd, "node_modules", name, "package.json"), JSON.stringify({ version }));
      }
      writeFileSync(join(cwd, "node_modules", "antechamber", "dist", "cli.js"), "");
    },
    pause: () => Promise.resolve(),
    now: Date.now,
    pidAlive: () => true,
  };
  const wrapped: InstallDeps = {
    ...deps,
    install: async (bun, cwd) => {
      await deps.install(bun, cwd);
      release();
    },
  };
  return { deps: wrapped, finished };
}

test("/runtime reports a missing runtime, installs it on request and then reports its versions", async (t) => {
  const { deps, finished } = installer();
  const { call, root } = await start(t, "/bin/bun", deps);
  const missing = await call("GET", "/runtime");
  assert.equal(missing.status, 200);
  assert.equal((missing.body as unknown as RuntimeStatus).state, "missing");
  assert.equal(missing.body.launcher, join(root, "ext", "bin", "opencode-antechamber"));
  assert.equal((await call("POST", "/runtime/install")).status, 202);
  await finished;
  const ready = (await call("GET", "/runtime")).body;
  assert.equal(ready.antechamber, "2.0.0");
  assert.equal(ready.omo, "5.1.69");
});

test("/runtime says Bun is missing instead of offering an install that cannot run", async (t) => {
  const { deps } = installer();
  const { call } = await start(t, undefined, deps);
  const { body } = await call("GET", "/runtime");
  assert.equal(body.state, "failed");
  assert.match(String(body.error), /bun not found/);
});

test("graph and work paths reach their own handlers; everything needs the service token", async (t) => {
  const { deps } = installer();
  const { call } = await start(t, "/bin/bun", deps);
  assert.equal((await call("GET", "/runtime", "wrong")).status, 401);
  assert.deepEqual(await call("GET", "/health"), { status: 200, body: { ok: true } });
  const graph = await call("GET", "/graph");
  assert.equal(graph.status, 400);
  assert.match(String(graph.body.error), /session query/);
  const work = await call("GET", "/status");
  assert.equal(work.status, 400);
  assert.match(String(work.body.error), /session query/);
  assert.equal((await call("GET", "/nope")).status, 404);
});

test("Use as OpenCode CLI points OpenChamber's settings.json at the launcher once, keeping a backup", async (t) => {
  const { deps, finished } = installer();
  // A repository-URL install: <data dir>/extensions/antechamber is the clone, the extension sits inside it.
  const { call, root } = await start(t, "/bin/bun", deps, "data/extensions/antechamber/extensions/antechamber");
  const settings = join(root, "data", "settings.json");
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(settings, JSON.stringify({ opencodeBinary: "/usr/bin/opencode", themeId: "dark" }), { mode: 0o600 });
  const launcher = join(root, "data/extensions/antechamber/extensions/antechamber/bin/opencode-antechamber");

  assert.deepEqual((await call("POST", "/runtime/activate")).status, 409, "refused before the runtime is installed");
  await call("POST", "/runtime/install");
  await finished;
  const before = (await call("GET", "/runtime")).body;
  assert.equal(before.settings, settings);
  assert.equal(before.active, false);

  const activated = await call("POST", "/runtime/activate");
  assert.equal(activated.status, 200);
  assert.equal(activated.body.active, true);
  assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")), { opencodeBinary: launcher, themeId: "dark" });
  assert.equal(statSync(settings).mode & 0o777, 0o600);
  const backup = String(activated.body.backup);
  assert.deepEqual(JSON.parse(readFileSync(backup, "utf8")), { opencodeBinary: "/usr/bin/opencode", themeId: "dark" });

  const again = await call("POST", "/runtime/activate");
  assert.equal(again.body.backup, undefined, "an active launcher is left alone");
});

test("a folder install, with no OpenChamber data dir around it, is told to set the path by hand", async (t) => {
  const { deps, finished } = installer();
  const { call } = await start(t, "/bin/bun", deps);
  await call("POST", "/runtime/install");
  await finished;
  assert.equal((await call("GET", "/runtime")).body.settings, null);
  const refused = await call("POST", "/runtime/activate");
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "settings-not-found");
});
