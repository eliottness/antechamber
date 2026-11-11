import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ensureRuntime,
  findBun,
  type InstallDeps,
  runtimePaths,
  runtimeState,
  STALE_LOCK_MS,
} from "../src/runtime/runtime.ts";

function scratch(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "antechamber-runtime-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A `bun install` stand-in that lays out what the real one leaves behind and records what it was asked. */
function fakeInstall(version = "2.0.0", omo = "5.1.69") {
  const calls: Array<{ cwd: string; manifest: Record<string, unknown> }> = [];
  const install = async (_bun: string, cwd: string) => {
    calls.push({ cwd, manifest: JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) });
    for (const [name, pkgVersion] of [
      ["antechamber", version],
      ["omo-ai", omo],
    ]) {
      mkdirSync(join(cwd, "node_modules", name as string, "dist"), { recursive: true });
      writeFileSync(join(cwd, "node_modules", name as string, "package.json"), JSON.stringify({ version: pkgVersion }));
    }
    writeFileSync(join(cwd, "node_modules", "antechamber", "dist", "cli.js"), "");
  };
  return { calls, install };
}

function deps(overrides: Partial<InstallDeps> = {}): InstallDeps {
  return {
    install: fakeInstall().install,
    pause: () => Promise.resolve(),
    now: Date.now,
    pidAlive: () => true,
    ...overrides,
  };
}

test("installs the pinned antechamber with omo-ai trusted, then reuses it", async (t) => {
  const root = scratch(t);
  const paths = runtimePaths("2.0.0", { env: { ANTECHAMBER_RUNTIME_DIR: root }, home: root });
  const fake = fakeInstall();
  const runtime = await ensureRuntime(paths, "/bin/bun", deps({ install: fake.install }));
  assert.equal(runtime.dir, join(root, "2.0.0"));
  assert.equal(runtime.cli, join(root, "2.0.0", "node_modules", "antechamber", "dist", "cli.js"));
  assert.equal(runtime.antechamber, "2.0.0");
  assert.equal(runtime.omo, "5.1.69");
  assert.deepEqual(fake.calls[0]?.manifest.dependencies, { antechamber: "2.0.0" });
  assert.deepEqual(fake.calls[0]?.manifest.trustedDependencies, ["omo-ai"]);
  await ensureRuntime(paths, "/bin/bun", deps({ install: fake.install }));
  assert.equal(fake.calls.length, 1);
  assert.equal(runtimeState(paths).state, "ready");
  assert.ok(!existsSync(`${paths.dir}.lock`));
});

test("concurrent callers share one install", async (t) => {
  const root = scratch(t);
  const paths = runtimePaths("2.0.0", { env: { ANTECHAMBER_RUNTIME_DIR: root }, home: root });
  const fake = fakeInstall();
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  let first: Promise<unknown> | undefined;
  const shared = deps({
    install: async (bun, cwd) => {
      await gate;
      await fake.install(bun, cwd);
    },
    // The second caller finds the first one's lock; it checks again once that install finished.
    pause: async () => {
      release();
      await first;
    },
  });
  first = ensureRuntime(paths, "/bin/bun", shared);
  const second = ensureRuntime(paths, "/bin/bun", shared);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(a, b);
});

test("a lock left by a dead installer, or an old one, is taken over", async (t) => {
  for (const [label, pidAlive, age] of [
    ["dead pid", false, 0],
    ["stale lock", true, STALE_LOCK_MS + 1],
  ] as const) {
    const root = scratch(t);
    const paths = runtimePaths("2.0.0", { env: { ANTECHAMBER_RUNTIME_DIR: root }, home: root });
    mkdirSync(`${paths.dir}.lock`, { recursive: true });
    writeFileSync(join(`${paths.dir}.lock`, "pid"), "4194303");
    const fake = fakeInstall();
    const runtime = await ensureRuntime(
      paths,
      "/bin/bun",
      deps({ install: fake.install, pidAlive: () => pidAlive, now: () => Date.now() + age }),
    );
    assert.equal(fake.calls.length, 1, label);
    assert.equal(runtime.antechamber, "2.0.0", label);
  }
});

test("a half-written runtime without its ready marker is installed again", async (t) => {
  const root = scratch(t);
  const paths = runtimePaths("2.0.0", { env: { ANTECHAMBER_RUNTIME_DIR: root }, home: root });
  mkdirSync(join(paths.dir, "node_modules", "antechamber"), { recursive: true });
  writeFileSync(join(paths.dir, "junk"), "");
  const fake = fakeInstall();
  await ensureRuntime(paths, "/bin/bun", deps({ install: fake.install }));
  assert.equal(fake.calls.length, 1);
  assert.ok(!existsSync(join(paths.dir, "junk")));
});

test("a failed install is reported, releases the lock and leaves no runtime", async (t) => {
  const root = scratch(t);
  const paths = runtimePaths("2.0.0", { env: { ANTECHAMBER_RUNTIME_DIR: root }, home: root });
  const failing = deps({ install: () => Promise.reject(new Error("bun install failed (exit 1): 404 antechamber")) });
  await assert.rejects(ensureRuntime(paths, "/bin/bun", failing), /404 antechamber/);
  assert.deepEqual(runtimeState(paths), { state: "failed", error: "bun install failed (exit 1): 404 antechamber" });
  assert.ok(!existsSync(`${paths.dir}.lock`));
  await ensureRuntime(paths, "/bin/bun", deps());
  assert.equal(runtimeState(paths).state, "ready");
});

test("without Bun the install fails with how to get it", async (t) => {
  const root = scratch(t);
  const paths = runtimePaths("2.0.0", { env: { ANTECHAMBER_RUNTIME_DIR: root }, home: root });
  await assert.rejects(ensureRuntime(paths, undefined, deps()), /bun not found .*https:\/\/bun\.sh/);
});

test("an update keeps the previous runtime for adapters still running from it, and prunes older ones", async (t) => {
  const root = scratch(t);
  const env = { env: { ANTECHAMBER_RUNTIME_DIR: root }, home: root };
  let clock = 1_000_000;
  for (const version of ["1.0.0", "1.1.0", "2.0.0"]) {
    clock += 1000;
    await ensureRuntime(
      runtimePaths(version, env),
      "/bin/bun",
      deps({ install: fakeInstall(version).install, now: () => clock }),
    );
  }
  assert.ok(!existsSync(join(root, "1.0.0")));
  assert.ok(existsSync(join(root, "1.1.0")));
  assert.ok(existsSync(join(root, "2.0.0")));
});

test("ANTECHAMBER_RUNTIME_SPEC installs a local tarball into its own runtime", (t) => {
  const root = scratch(t);
  const tarball = join(root, "antechamber-2.0.0.tgz");
  writeFileSync(tarball, "x");
  const paths = runtimePaths("2.0.0", {
    env: { ANTECHAMBER_RUNTIME_DIR: root, ANTECHAMBER_RUNTIME_SPEC: tarball },
    home: root,
  });
  assert.equal(paths.spec, `file:${tarball}`);
  assert.match(paths.key, /^local-[0-9a-f]{12}$/);
});

test("Bun is found on PATH, else in $BUN_INSTALL/bin or ~/.bun/bin", () => {
  const found = new Set(["/opt/bun/bin/bun", "/home/u/.bun/bin/bun"]);
  const exists = (path: string) => found.has(path);
  assert.equal(findBun({ env: { PATH: "/usr/bin:/opt/bun/bin" }, home: "/home/u" }, exists), "/opt/bun/bin/bun");
  assert.equal(findBun({ env: { PATH: "/usr/bin" }, home: "/home/u" }, exists), "/home/u/.bun/bin/bun");
  assert.equal(findBun({ env: { PATH: "/usr/bin" }, home: "/home/x" }, exists), undefined);
});
