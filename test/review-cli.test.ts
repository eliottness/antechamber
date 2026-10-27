import assert from "node:assert/strict";
import test from "node:test";
import { OPENCODE_API_VERSION } from "../src/version.js";

test("R-008: advertised v2 compatibility version meets the supported host minimum", () => {
  const match = OPENCODE_API_VERSION.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (match === null) throw new Error(`invalid OpenCode API version: ${OPENCODE_API_VERSION}`);
  const majorText = match[1]!;
  const minorText = match[2]!;
  const patchText = match[3]!;
  const version = [Number(majorText), Number(minorText), Number(patchText)] as const;
  assert.ok(version[0] === 2 && (version[1] > 0 || (version[1] === 0 && version[2] >= 20)), OPENCODE_API_VERSION);
});

test("R-024: dry-run does not promise a backup that already collides", async (t) => {
  const fs = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createContext } = await import("../src/commands/context.js");
  const { setup } = await import("../src/commands/setup.js");
  const root = fs.mkdtempSync(join(tmpdir(), "antechamber-review-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binary = join(root, "antechamber");
  const settings = join(root, "settings.json");
  const now = new Date("2026-10-14T10:11:12Z");
  fs.writeFileSync(binary, "#!/usr/bin/env node\n", { mode: 0o755 });
  fs.writeFileSync(settings, '{"opencodeBinary":"old"}\n');
  fs.writeFileSync(`${settings}.bak-antechamber-20261014101112`, "earlier backup");
  const lines: string[] = [];
  const ctx = createContext({
    home: root,
    cwd: root,
    env: { PATH: root },
    now: () => now,
    output: (line) => lines.push(line),
    cliPath: join(root, "dist", "cli.js"),
    launcherPath: join(root, "bin", "opencode-antechamber"),
    exec: () => {
      throw new Error("unexpected command");
    },
  });

  assert.throws(() => setup({ binary, settings, dryRun: true }, ctx), { code: "EEXIST" });

  assert.equal(
    lines.some((line) => line.startsWith("Would back up")),
    false,
  );
});

test("R-025: interrupted first settings write leaves no malformed settings file", async (t) => {
  const fs = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createContext } = await import("../src/commands/context.js");
  const { setup } = await import("../src/commands/setup.js");
  const root = fs.mkdtempSync(join(tmpdir(), "antechamber-review-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binary = join(root, "antechamber");
  const settings = join(root, "settings.json");
  fs.writeFileSync(binary, "#!/usr/bin/env node\n", { mode: 0o755 });
  const failingFs = {
    ...fs,
    writeFileSync: ((...args: Parameters<typeof fs.writeFileSync>) => {
      const [path] = args;
      fs.writeFileSync(path, "{");
      throw new Error("simulated interrupted write");
    }) as typeof fs.writeFileSync,
  } as typeof fs;
  const ctx = createContext({
    fs: failingFs,
    home: root,
    cwd: root,
    env: { PATH: root },
    output: () => {},
    cliPath: join(root, "dist", "cli.js"),
    launcherPath: join(root, "bin", "opencode-antechamber"),
    exec: () => {
      throw new Error("unexpected command");
    },
  });

  assert.throws(() => setup({ binary, settings }, ctx), /simulated interrupted write/);

  assert.equal(fs.existsSync(settings), false);
});

test("R-026: symlinked launcher names find their installed package CLI", async (t) => {
  const childProcess = await import("node:child_process");
  const fs = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = fs.mkdtempSync(join(tmpdir(), "antechamber-review-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageDir = join(root, "installed package");
  const packageBin = join(packageDir, "bin");
  const launchers = join(root, "user launchers");
  const dist = join(packageDir, "dist");
  fs.mkdirSync(packageBin, { recursive: true });
  fs.mkdirSync(launchers);
  fs.mkdirSync(dist);
  for (const name of ["opencode-antechamber", "opencode-pi"]) {
    const source = new URL(`../bin/${name}`, import.meta.url);
    const target = join(packageBin, name);
    fs.copyFileSync(source, target);
    fs.chmodSync(target, 0o755);
    fs.symlinkSync(target, join(launchers, name));
  }
  fs.writeFileSync(join(dist, "cli.js"), 'console.log("fixture CLI version");\n');
  // A stand-in `bun` that runs the fixture CLI with this test's runtime, so no real Bun is needed.
  const fakeBun = (dir: string): void => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, "bun"), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 });
  };
  const run = (env: NodeJS.ProcessEnv) =>
    ["opencode-antechamber", "opencode-pi"].map((name) =>
      childProcess.spawnSync(join(launchers, name), ["--version"], { encoding: "utf8", timeout: 5000, env }),
    );
  const systemPath = "/usr/bin:/bin";
  const pathBun = join(root, "path-bin");
  fakeBun(pathBun);
  const installedHome = join(root, "home with bun");
  fakeBun(join(installedHome, ".bun", "bin"));

  for (const env of [
    { PATH: `${pathBun}:${systemPath}`, HOME: join(root, "empty home") },
    { PATH: systemPath, HOME: installedHome },
  ]) {
    const results = run(env);
    assert.deepEqual(
      results.map((result) => result.status),
      [0, 0],
      results.map((result) => result.stderr).join("\n"),
    );
    assert.deepEqual(
      results.map((result) => result.stdout),
      ["fixture CLI version\n", "fixture CLI version\n"],
    );
  }

  const missing = run({ PATH: systemPath, HOME: join(root, "empty home") });
  assert.deepEqual(
    missing.map((result) => result.status),
    [1, 1],
  );
  for (const result of missing) assert.match(result.stderr, /bun not found on PATH or in ~\/\.bun\/bin/);
});
