import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultStateDir, envSetting } from "../config.js";

export interface CommandContext {
  readonly fs: typeof fs;
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  readonly cwd: string;
  readonly exec: (binary: string, args: readonly string[]) => string;
  readonly now: () => Date;
  readonly platform: NodeJS.Platform;
  /** Bun's version, or undefined when this process is not running on Bun. */
  readonly bunVersion: string | undefined;
  /** The running Bun executable, or undefined when this process is not running on Bun. */
  readonly bunBinary: string | undefined;
  readonly output: (line: string) => void;
  readonly cliPath: string;
  readonly launcherPath: string;
}

export function createContext(overrides: Partial<CommandContext> = {}): CommandContext {
  const env = overrides.env ?? process.env;
  const cwd = overrides.cwd ?? process.cwd();
  return {
    fs,
    env,
    home: overrides.home ?? env.HOME ?? homedir(),
    cwd,
    exec: (binary, args) => {
      const result = spawnSync(binary, args, {
        env,
        cwd,
        encoding: "utf8",
        timeout: 5000,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
      });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`${binary} exited ${result.status}: ${result.stderr.trim()}`);
      return result.stdout.trim();
    },
    now: () => new Date(),
    platform: process.platform,
    bunVersion: process.versions.bun,
    bunBinary: process.versions.bun === undefined ? undefined : process.execPath,
    output: console.log,
    cliPath: packageCliPath,
    launcherPath: fileURLToPath(new URL("../../bin/opencode-antechamber", import.meta.url)),
    ...overrides,
  };
}

const packageCliPath = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

/** Resolve executables without shell evaluation, respecting the supplied PATH. */
export function resolveBinary(binary: string, ctx: CommandContext): string | undefined {
  const candidates =
    isAbsolute(binary) || binary.includes("/") || binary.includes("\\")
      ? [resolve(ctx.cwd, binary)]
      : (ctx.env.PATH ?? "").split(delimiter).map((dir) => resolve(ctx.cwd, dir, binary));
  for (const candidate of candidates) {
    try {
      ctx.fs.accessSync(candidate, ctx.fs.constants.X_OK);
      if (ctx.fs.statSync(candidate).isFile()) return candidate;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        !["ENOENT", "EACCES", "ENOTDIR"].includes(String(error.code))
      )
        throw error;
    }
  }
  return undefined;
}

export interface SettingsOptions {
  readonly settings?: string;
  readonly profile?: string;
}

export function settingsPath(options: SettingsOptions, ctx: CommandContext): string {
  if (options.settings !== undefined) return resolve(ctx.cwd, options.settings);
  const dir = options.profile ?? ctx.env.OPENCHAMBER_DATA_DIR ?? join(ctx.home, ".config", "openchamber");
  return resolve(ctx.cwd, dir, "settings.json");
}

export function readSettings(path: string, ctx: CommandContext): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(ctx.fs.readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON in settings file ${path}: ${error.message}`);
    throw error;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid settings file ${path}: expected a JSON object`);
  }
  return Object.fromEntries(Object.entries(value));
}

export function shellQuote(value: string): string {
  return /^[\w./:@=-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/** OpenChamber launcher written by `setup --auto-update`, kept beside the session registry. */
export function autoUpdateLauncherPath(ctx: CommandContext): string {
  return resolve(
    ctx.cwd,
    envSetting("STATE_DIR", ctx.env) ?? defaultStateDir(ctx.home, ctx.fs.existsSync),
    "opencode-antechamber",
  );
}

export function autoUpdateLauncherText(binary: string, bunBinary?: string): string {
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  return [
    "#!/bin/sh",
    "# Written by `antechamber setup --auto-update`; rerun `antechamber setup` without it to stop auto-updates.",
    "ANTECHAMBER_AUTO_UPDATE=1",
    "export ANTECHAMBER_AUTO_UPDATE",
    // The CLI's `env bun` shebang must find Bun even when OpenChamber's PATH lacks its directory.
    ...(bunBinary === undefined ? [] : [`PATH=${quote(dirname(bunBinary))}:"$PATH"`, "export PATH"]),
    `exec ${quote(binary)} "$@"`,
    "",
  ].join("\n");
}

export function autoUpdateLauncherTarget(text: string): string | undefined {
  const match = /^exec '((?:[^']|'\\'')*)' "\$@"$/m.exec(text);
  return match?.[1]?.replaceAll("'\\''", "'");
}

export function isPackageBinary(binary: string, ctx: CommandContext): boolean {
  const resolved = resolveBinary(binary, ctx);
  if (resolved === undefined) return false;
  const target = ctx.fs.realpathSync(resolved);
  return [ctx.cliPath, ctx.launcherPath].some(
    (path) => ctx.fs.existsSync(path) && ctx.fs.realpathSync(path) === target,
  );
}
