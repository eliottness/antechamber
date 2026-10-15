import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test, { type TestContext } from "node:test";
import { createContext, settingsPath } from "../src/commands/context.js";
import { doctor } from "../src/commands/doctor.js";
import { setup } from "../src/commands/setup.js";
import { SelfUpdateUnsupportedError } from "../src/self-update.js";

function fixture(t: TestContext) {
  const home = fs.mkdtempSync(join(tmpdir(), "antechamber-setup-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const binary = join(home, "antechamber");
  fs.writeFileSync(binary, "#!/usr/bin/env node\n", { mode: 0o755 });
  const cliPath = join(home, "dist", "cli.js");
  fs.mkdirSync(join(home, "dist"));
  fs.writeFileSync(cliPath, "#!/usr/bin/env node\n", { mode: 0o755 });
  const ctx = createContext({
    home,
    cwd: home,
    env: { PATH: home },
    now: () => new Date("2026-10-14T10:11:12Z"),
    output: () => {},
    cliPath,
    launcherPath: join(home, "bin", "opencode-antechamber"),
    exec: () => {
      throw new Error("Unexpected execution");
    },
  });
  return { home, binary, ctx, options: { binary } };
}

test("settings paths prefer explicit settings then profile then environment then home", (t) => {
  const { home, ctx } = fixture(t);
  const configured = { ...ctx, env: { OPENCHAMBER_DATA_DIR: join(home, "env") } };
  assert.equal(settingsPath({}, ctx), join(home, ".config/openchamber/settings.json"));
  assert.equal(settingsPath({}, configured), join(home, "env/settings.json"));
  assert.equal(settingsPath({ profile: "profile" }, configured), join(home, "profile/settings.json"));
  assert.equal(settingsPath({ settings: "custom", profile: "profile" }, configured), join(home, "custom"));
});

test("setup creates default settings under the injected home", (t) => {
  const { home, ctx, options, binary } = fixture(t);
  setup(options, ctx);
  assert.equal(
    JSON.parse(fs.readFileSync(join(home, ".config/openchamber/settings.json"), "utf8")).opencodeBinary,
    binary,
  );
});

test("setup uses OPENCHAMBER_DATA_DIR when no explicit file or profile is given", (t) => {
  const { home, ctx, options, binary } = fixture(t);
  const dir = join(home, "environment-profile");
  setup(options, { ...ctx, env: { ...ctx.env, OPENCHAMBER_DATA_DIR: dir } });
  assert.equal(JSON.parse(fs.readFileSync(join(dir, "settings.json"), "utf8")).opencodeBinary, binary);
  assert.equal(fs.existsSync(join(home, ".config")), false);
});

test("setup preserves keys and backs up exact original settings", (t) => {
  const { home, ctx, options, binary } = fixture(t);
  const settings = join(home, "settings.json");
  const original = '{"theme":"dark","nested":{"a":1},"opencodeBinary":"old"}\n';
  fs.writeFileSync(settings, original);
  setup({ ...options, settings }, ctx);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, "utf8")), {
    theme: "dark",
    nested: { a: 1 },
    opencodeBinary: binary,
  });
  assert.equal(fs.readFileSync(`${settings}.bak-antechamber-20261014101112`, "utf8"), original);
});

test("setup creates profile settings and reports the isolated launch command", (t) => {
  const { home, ctx, options, binary } = fixture(t);
  const profile = join(home, "isolated profile");
  const lines = setup({ ...options, profile }, ctx);
  assert.equal(JSON.parse(fs.readFileSync(join(profile, "settings.json"), "utf8")).opencodeBinary, binary);
  assert.ok(lines.some((line) => line.includes("OPENCHAMBER_DATA_DIR=") && line.includes("openchamber serve")));
});

test("setup is idempotent and creates no backup when already configured", (t) => {
  const { home, ctx, options, binary } = fixture(t);
  const settings = join(home, "settings.json");
  const original = JSON.stringify({ opencodeBinary: binary });
  fs.writeFileSync(settings, original);
  setup({ ...options, settings }, ctx);
  assert.equal(fs.readFileSync(settings, "utf8"), original);
  assert.equal(fs.readdirSync(home).filter((name) => name.includes(".bak-")).length, 0);
});

test("dry-run creates no profile or systemd directory", (t) => {
  const { home, ctx, options } = fixture(t);
  const profile = join(home, "absent");
  const lines = setup(
    { ...options, profile, dryRun: true, systemd: "openchamber.service", piBinary: options.binary },
    ctx,
  );
  assert.ok(lines.some((line) => line.includes("opencodeBinary")));
  assert.equal(fs.existsSync(profile), false);
  assert.equal(fs.existsSync(join(home, ".config")), false);
});

test("dry-run leaves existing settings unchanged and creates no backup", (t) => {
  const { home, ctx, options } = fixture(t);
  const settings = join(home, "settings.json");
  fs.writeFileSync(settings, '{"theme":"dark"}\n');
  setup({ ...options, settings, dryRun: true }, ctx);
  assert.equal(fs.readFileSync(settings, "utf8"), '{"theme":"dark"}\n');
  assert.equal(fs.readdirSync(home).filter((name) => name.includes(".bak-")).length, 0);
});

test("fallback package CLI is made executable before configuring it", (t) => {
  const { home, ctx } = fixture(t);
  fs.chmodSync(ctx.cliPath, 0o644);
  const settings = join(home, "settings.json");
  setup({ settings }, ctx);
  assert.equal(JSON.parse(fs.readFileSync(settings, "utf8")).opencodeBinary, ctx.cliPath);
  assert.equal(fs.statSync(ctx.cliPath).mode & 0o111, 0o111);
});

test("backup collision refuses to overwrite an existing backup or modify settings", (t) => {
  const { home, ctx, options } = fixture(t);
  const settings = join(home, "settings.json");
  fs.writeFileSync(settings, "{}");
  const backup = `${settings}.bak-antechamber-20261014101112`;
  fs.writeFileSync(backup, "earlier backup");
  assert.throws(() => setup({ ...options, settings }, ctx), /EEXIST/);
  assert.equal(fs.readFileSync(settings, "utf8"), "{}");
  assert.equal(fs.readFileSync(backup, "utf8"), "earlier backup");
});

for (const invalid of ["{", "null", "[]", '"settings"']) {
  test(`setup refuses invalid settings object ${invalid} without writing`, (t) => {
    const { home, ctx, options } = fixture(t);
    const settings = join(home, "settings.json");
    fs.writeFileSync(settings, invalid);
    assert.throws(() => setup({ ...options, settings }, ctx), /settings|JSON/i);
    assert.equal(fs.readFileSync(settings, "utf8"), invalid);
    assert.equal(fs.readdirSync(home).filter((name) => name.includes(".bak-")).length, 0);
  });
}

test("systemd setup writes the environment and lifecycle settings and warns about conflicts", (t) => {
  const { home, ctx, options, binary } = fixture(t);
  const systemdDir = join(home, "units");
  const dir = join(systemdDir, "openchamber.service.d");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, "zz-custom.conf"), '[Service]\nEnvironment="OCPI_PI_BINARY=pi"\n');
  fs.writeFileSync(join(dir, "antechamber.conf"), "old drop-in\n");
  const lines = setup({ ...options, systemd: "openchamber.service", systemdDir, piBinary: binary }, ctx);
  const text = fs.readFileSync(join(dir, "antechamber.conf"), "utf8");
  assert.ok(text.includes(`Environment="PATH=${home}"`));
  assert.ok(text.includes(`Environment="ANTECHAMBER_PI_BINARY=${binary}"`));
  assert.ok(text.includes("KillMode=control-group\nTimeoutStopSec=20\n"));
  assert.equal(fs.readFileSync(join(dir, "antechamber.conf.bak-antechamber-20261014101112"), "utf8"), "old drop-in\n");
  assert.ok(lines.some((line) => line.startsWith("WARN") && line.includes("zz-custom.conf")));
  assert.ok(lines.some((line) => line.includes("systemctl --user daemon-reload")));
});

test("restart invokes systemctl only when explicitly requested", (t) => {
  const { home, ctx, options, binary } = fixture(t);
  const calls: string[][] = [];
  setup(
    { ...options, systemd: "custom.service", systemdDir: join(home, "units"), piBinary: binary, restart: true },
    {
      ...ctx,
      exec: (command, args) => {
        calls.push([command, ...args]);
        return "";
      },
    },
  );
  assert.deepEqual(calls, [
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "restart", "custom.service"],
  ]);
});

test("PATH launcher must belong to this installation otherwise setup uses the package CLI", (t) => {
  const { home, ctx } = fixture(t);
  const lines = setup({ settings: join(home, "settings.json"), dryRun: true }, ctx);
  assert.ok(lines.some((line) => line.includes(ctx.cliPath)));
  fs.unlinkSync(join(home, "antechamber"));
  fs.symlinkSync(ctx.cliPath, join(home, "antechamber"));
  assert.ok(
    setup({ settings: join(home, "settings.json"), dryRun: true }, ctx).some((line) =>
      line.includes(join(home, "antechamber")),
    ),
  );
});

function globalInstall(t: TestContext) {
  const base = fixture(t);
  const npmRoot = join(base.home, "npm", "lib", "node_modules");
  const cliPath = join(npmRoot, "antechamber", "dist", "cli.js");
  fs.mkdirSync(join(npmRoot, "antechamber", "dist"), { recursive: true });
  fs.writeFileSync(cliPath, "#!/usr/bin/env node\n", { mode: 0o755 });
  const binary = join(base.home, "npm", "bin", "antechamber");
  fs.mkdirSync(join(base.home, "npm", "bin"));
  fs.symlinkSync(cliPath, binary);
  const ctx = {
    ...base.ctx,
    cliPath,
    env: { PATH: join(base.home, "npm", "bin") },
    exec: (command: string, args: readonly string[]) => {
      assert.deepEqual([basename(command), ...args], ["npm", "root", "-g"]);
      return npmRoot;
    },
  };
  return { home: base.home, ctx, binary, launcher: join(base.home, ".config", "antechamber", "opencode-antechamber") };
}

test("auto-update setup points OpenChamber at an executable launcher for the global install", (t) => {
  const { home, ctx, binary, launcher } = globalInstall(t);
  const settings = join(home, "settings.json");
  setup({ settings, autoUpdate: true }, ctx);
  assert.equal(JSON.parse(fs.readFileSync(settings, "utf8")).opencodeBinary, launcher);
  const text = fs.readFileSync(launcher, "utf8");
  assert.ok(text.startsWith("#!/bin/sh\n"));
  assert.ok(text.includes("ANTECHAMBER_AUTO_UPDATE=1\nexport ANTECHAMBER_AUTO_UPDATE\n"));
  assert.ok(text.includes(`exec '${binary}' "$@"`));
  assert.equal(fs.statSync(launcher).mode & 0o777, 0o755);

  const written = fs.readFileSync(settings, "utf8");
  setup({ settings, autoUpdate: true }, ctx);
  assert.equal(fs.readFileSync(settings, "utf8"), written);
  assert.equal(fs.readFileSync(launcher, "utf8"), text);
  assert.equal(fs.readdirSync(home).filter((name) => name.includes(".bak-")).length, 0);

  const check = doctor({ settings }, ctx).checks.find((entry) => entry.name === "openchamber-settings");
  assert.equal(check?.status, "PASS");
  assert.ok(check?.message.includes(binary));
});

test("auto-update dry-run writes neither the launcher nor settings", (t) => {
  const { home, ctx, launcher } = globalInstall(t);
  const settings = join(home, "settings.json");
  const lines = setup({ settings, autoUpdate: true, dryRun: true }, ctx);
  assert.ok(lines.some((line) => line.startsWith(`Would write auto-update launcher ${launcher}`)));
  assert.equal(fs.existsSync(launcher), false);
  assert.equal(fs.existsSync(settings), false);
});

test("auto-update setup refuses an installation that cannot update itself", (t) => {
  const { home, ctx } = fixture(t);
  const settings = join(home, "settings.json");
  assert.throws(() => setup({ settings, autoUpdate: true }, ctx), SelfUpdateUnsupportedError);
  assert.equal(fs.existsSync(settings), false);
});

test("setup points at the bundled OmO Graph extension once it is built", (t) => {
  const { home, ctx, options } = fixture(t);
  const extension = join(home, "extensions", "omo-dag");
  const hint = (lines: string[]) => lines.filter((line) => line.includes("OmO Graph extension"));
  assert.deepEqual(hint(setup({ ...options, dryRun: true }, ctx)), []);

  fs.mkdirSync(join(extension, "panel"), { recursive: true });
  fs.mkdirSync(join(extension, "service"));
  for (const file of ["package.json", "panel/main.js", "service/main.js"]) fs.writeFileSync(join(extension, file), "");
  const [line] = hint(setup({ ...options, dryRun: true }, ctx));
  assert.ok(line?.endsWith(`Folder: ${extension}`));
});
