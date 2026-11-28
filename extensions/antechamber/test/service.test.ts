import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runtimeNotice } from "../src/runtime/notice.ts";
import { type InstallDeps, launchStampPath, runtimePaths, writeStamp } from "../src/runtime/runtime.ts";
import { createService, type RuntimeStatus } from "../src/service.ts";

const TOKEN = "service-test-token";

async function start(
  t: { after: (fn: () => void) => void },
  bun: string | undefined,
  deps: InstallDeps,
  extensionPath = "ext",
  autoActivate = false,
  /** An earlier start's root: a restart of the service over the same files. */
  existing?: string,
) {
  const root = existing ?? mkdtempSync(join(tmpdir(), "antechamber-service-"));
  const paths = runtimePaths("2.0.0", { env: { ANTECHAMBER_RUNTIME_DIR: join(root, "runtime") }, home: root });
  const server = createService({
    token: TOKEN,
    extensionDir: join(root, extensionPath),
    paths,
    home: root,
    bun,
    deps,
    autoActivate,
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => {
    server.close();
    if (!existing) rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, token = TOKEN) => {
    const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}` } });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return { call, root, paths };
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

const REPO_INSTALL = "data/extensions/antechamber/extensions/antechamber";

async function autoInstall(t: { after: (fn: () => void) => void }, settings: Record<string, unknown>) {
  const { deps, finished } = installer();
  const started = await start(t, "/bin/bun", deps, REPO_INSTALL, true);
  mkdirSync(join(started.root, "data"), { recursive: true });
  const file = join(started.root, "data", "settings.json");
  writeFileSync(file, JSON.stringify(settings));
  await started.call("POST", "/runtime/install");
  await finished;
  const launcher = join(started.root, REPO_INSTALL, "bin", "opencode-antechamber");
  // The fake install has resolved; the rest of ensureRuntime and the activation run without I/O waits, so they are
  // done before the service answers the next request.
  const settled = async () => (await started.call("GET", "/runtime")).body as unknown as RuntimeStatus;
  return { ...started, file, launcher, settled };
}

test("once installed, the service makes itself the OpenCode CLI when none is set, and asks for a reload", async (t) => {
  const { file, launcher, settled, root } = await autoInstall(t, { themeId: "dark" });
  const status = await settled();
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { themeId: "dark", opencodeBinary: launcher });
  assert.equal(status.active, true);
  assert.equal(status.needsReload, true, "OpenChamber still runs the OpenCode it started before the switch");
  writeStamp(launchStampPath(root, launcher), Date.now() + 1000);
  assert.equal((await settled()).needsReload, false, "a launch after the switch means antechamber now runs");
});

test("a restarted service still asks for the restart, and never switches the CLI unasked a second time", async (t) => {
  const { file, root } = await autoInstall(t, { themeId: "dark" });
  const restart = () => start(t, "/bin/bun", installer().deps, REPO_INSTALL, true, root);
  const again = await restart();
  assert.equal((await again.call("GET", "/runtime")).body.needsReload, true, "the switch is remembered on disk");

  writeFileSync(file, JSON.stringify({ themeId: "dark" }), "utf8");
  const later = await restart();
  const status = (await later.call("GET", "/runtime")).body as unknown as RuntimeStatus;
  assert.equal(JSON.parse(readFileSync(file, "utf8")).opencodeBinary, undefined, "the user's later choice stands");
  assert.equal(status.active, false);
});

test("an unreadable settings.json is reported instead of taking the service down", async (t) => {
  const { deps, finished } = installer();
  const { call, root } = await start(t, "/bin/bun", deps, REPO_INSTALL, true);
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(join(root, "data", "settings.json"), "{ not json");
  await call("POST", "/runtime/install");
  await finished;
  const { status, body } = await call("GET", "/runtime");
  assert.equal(status, 200);
  assert.match(String(body.settingsError), /could not be read/);
  assert.equal(body.active, false);
  const refused = await call("POST", "/runtime/activate");
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "settings-unreadable");
  assert.equal(readFileSync(join(root, "data", "settings.json"), "utf8"), "{ not json", "the file is left as it was");
  assert.equal((await call("GET", "/health")).status, 200, "the service is still up");
});

test("the service replaces another antechamber launcher without asking", async (t) => {
  const { file, launcher, settled } = await autoInstall(t, { opencodeBinary: "/old/bin/opencode-antechamber" });
  assert.equal((await settled()).active, true);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).opencodeBinary, launcher);
});

test("a custom OpenCode CLI stays until the user picks antechamber", async (t) => {
  const { file, settled } = await autoInstall(t, { opencodeBinary: "/usr/local/bin/opencode" });
  const status = await settled();
  assert.equal(status.active, false);
  assert.equal(status.configured, "/usr/local/bin/opencode");
  assert.equal(status.needsReload, false);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).opencodeBinary, "/usr/local/bin/opencode");
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

test("a folder install recognizes its launcher in OpenChamber's default settings", async (t) => {
  const { deps, finished } = installer();
  const { call, root } = await start(t, "/bin/bun", deps, "ext", true);
  const settings = join(root, ".config", "openchamber", "settings.json");
  const launcher = join(root, "ext", "bin", "opencode-antechamber");
  mkdirSync(join(root, ".config", "openchamber"), { recursive: true });
  writeFileSync(settings, JSON.stringify({ opencodeBinary: launcher }));

  await call("POST", "/runtime/install");
  await finished;
  const status = (await call("GET", "/runtime")).body;
  assert.equal(status.settings, null);
  assert.equal(status.configured, launcher);
  assert.equal(status.active, true);
  assert.equal(status.needsReload, false);
  assert.equal(runtimeNotice(status as unknown as RuntimeStatus), undefined);
});

test("a folder install cannot switch a default profile it did not come from", async (t) => {
  const { deps, finished } = installer();
  const { call, root } = await start(t, "/bin/bun", deps, "ext", true);
  const settings = join(root, ".config", "openchamber", "settings.json");
  mkdirSync(join(root, ".config", "openchamber"), { recursive: true });
  writeFileSync(settings, JSON.stringify({ themeId: "dark" }));

  await call("POST", "/runtime/install");
  await finished;
  const status = (await call("GET", "/runtime")).body;
  assert.equal(status.active, false);
  assert.equal(status.needsReload, false);
  assert.equal(status.settings, null);
  const notice = runtimeNotice(status as unknown as RuntimeStatus);
  assert.equal(notice?.action, undefined);
  assert.equal(notice?.code, join(root, "ext", "bin", "opencode-antechamber"));
  assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")), { themeId: "dark" });

  const refused = await call("POST", "/runtime/activate");
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "settings-not-found");
  assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")), { themeId: "dark" });
});

test("a folder install ignores an unreadable default profile and shows manual setup", async (t) => {
  const { deps, finished } = installer();
  const { call, root } = await start(t, "/bin/bun", deps, "ext", true);
  const settings = join(root, ".config", "openchamber", "settings.json");
  mkdirSync(join(root, ".config", "openchamber"), { recursive: true });
  writeFileSync(settings, "{ not json");

  await call("POST", "/runtime/install");
  await finished;
  const status = (await call("GET", "/runtime")).body as unknown as RuntimeStatus;
  const notice = runtimeNotice(status);
  assert.equal(status.active, false);
  assert.equal(status.settings, null);
  assert.equal(status.settingsError, undefined);
  assert.equal(notice?.action, undefined);
  assert.equal(notice?.code, join(root, "ext", "bin", "opencode-antechamber"));
  assert.equal(readFileSync(settings, "utf8"), "{ not json");
});
