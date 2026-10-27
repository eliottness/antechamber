import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { installMethod, npmBinaryFor } from "../self-update.js";
import {
  autoUpdateLauncherPath,
  autoUpdateLauncherText,
  type CommandContext,
  createContext,
  isPackageBinary,
  readSettings,
  resolveBinary,
  type SettingsOptions,
  settingsPath,
  shellQuote,
} from "./context.js";

interface SetupOptions extends SettingsOptions {
  readonly binary?: string;
  readonly dryRun?: boolean;
  readonly systemd?: string;
  readonly piBinary?: string;
  readonly restart?: boolean;
  readonly autoUpdate?: boolean;
  /** User-unit root, overridable without touching the real systemd configuration. */
  readonly systemdDir?: string;
}

function systemdValue(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error("systemd environment values cannot contain newlines or NUL");
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
}

function writeAtomically(path: string, content: string, ctx: CommandContext): void {
  const temporary = join(dirname(path), `.antechamber-${randomUUID()}.tmp`);
  ctx.fs.writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
  ctx.fs.renameSync(temporary, path);
}

/** The bundled OmO Graph extension folder, when this installation has its built files. */
function omoGraphExtensionDir(ctx: CommandContext): string | undefined {
  const dir = resolve(dirname(ctx.cliPath), "..", "extensions", "omo-dag");
  const built = ["package.json", "panel/main.js", "service/main.js"].every((file) =>
    ctx.fs.existsSync(join(dir, file)),
  );
  return built ? dir : undefined;
}

/** The bundled OmO Work status-section extension folder, when this installation has its built files. */
function omoWorkExtensionDir(ctx: CommandContext): string | undefined {
  const dir = resolve(dirname(ctx.cliPath), "..", "extensions", "omo-work");
  const built = ["package.json", "status/main.js", "service/main.js"].every((file) =>
    ctx.fs.existsSync(join(dir, file)),
  );
  return built ? dir : undefined;
}

/** The bundled OmO Compatibility extension folder; it is a manifest only, so it needs no build. */
function omoCompatExtensionDir(ctx: CommandContext): string | undefined {
  const dir = resolve(dirname(ctx.cliPath), "..", "extensions", "omo-compat");
  return ctx.fs.existsSync(join(dir, "package.json")) ? dir : undefined;
}

/** Plan all inputs before applying changes; dependencies are injected for hermetic tests. */
export function setup(options: SetupOptions, ctx: CommandContext = createContext()): string[] {
  const lines: string[] = [];
  const report = (line: string): void => {
    lines.push(line);
    ctx.output(line);
  };
  if (options.restart && options.systemd === undefined) throw new Error("--restart requires --systemd");
  const settings = settingsPath(options, ctx);
  const existing = ctx.fs.existsSync(settings);
  const data = existing ? readSettings(settings, ctx) : {};
  const onPath = resolveBinary("antechamber", ctx);
  const binary =
    options.binary !== undefined
      ? resolveBinary(options.binary, ctx)
      : onPath !== undefined && isPackageBinary(onPath, ctx)
        ? onPath
        : ctx.cliPath;
  if (binary === undefined) throw new Error(`Cannot resolve executable --binary ${options.binary}`);
  if (binary === ctx.cliPath && !ctx.fs.readFileSync(binary, "utf8").startsWith("#!/usr/bin/env bun\n")) {
    throw new Error(`Package CLI ${binary} is missing its bun shebang; run npm run build`);
  }
  let launcher: string | undefined;
  let launcherText: string | undefined;
  let oldLauncher: string | undefined;
  if (options.autoUpdate) {
    installMethod(
      {
        packageRoot: resolve(dirname(ctx.cliPath), ".."),
        env: ctx.env,
        home: ctx.home,
        realpath: (path) => ctx.fs.realpathSync(path),
      },
      () => ctx.exec(npmBinaryFor(), ["root", "-g"]),
    );
    launcher = autoUpdateLauncherPath(ctx);
    launcherText = autoUpdateLauncherText(binary, ctx.bunBinary);
    if (ctx.fs.existsSync(launcher)) oldLauncher = ctx.fs.readFileSync(launcher, "utf8");
  }
  const configured = launcher ?? binary;
  const updated = `${JSON.stringify({ ...data, opencodeBinary: configured }, null, 2)}\n`;
  const changed = data.opencodeBinary !== configured;

  let dropIn: string | undefined;
  let dropInText: string | undefined;
  let oldDropIn: string | undefined;
  if (options.systemd !== undefined) {
    const unit = options.systemd;
    if (!/^[a-zA-Z0-9_.@:-]+\.service$/.test(unit)) throw new Error(`Invalid systemd service unit: ${unit}`);
    const backend = resolveBinary(options.piBinary ?? "omo", ctx);
    if (backend === undefined) throw new Error(`Cannot resolve backend ${options.piBinary ?? "omo"} for --systemd`);
    const root = options.systemdDir ?? join(ctx.home, ".config", "systemd", "user");
    const dir = resolve(ctx.cwd, root, `${unit}.d`);
    dropIn = join(dir, "antechamber.conf");
    dropInText = [
      "[Service]",
      `Environment="PATH=${systemdValue(ctx.env.PATH ?? "")}"`,
      `Environment="ANTECHAMBER_PI_BINARY=${systemdValue(backend)}"`,
      "KillMode=control-group",
      "TimeoutStopSec=20",
      "",
    ].join("\n");
    if (ctx.fs.existsSync(dropIn)) oldDropIn = ctx.fs.readFileSync(dropIn, "utf8");
    if (ctx.fs.existsSync(dir)) {
      for (const name of ctx.fs.readdirSync(dir).sort()) {
        if (name === "antechamber.conf" || !name.endsWith(".conf")) continue;
        const content = ctx.fs.readFileSync(join(dir, name), "utf8");
        if (
          content
            .split("\n")
            .some((line) => /^\s*Environment(?:File)?\s*=/.test(line) && /\b(?:ANTECHAMBER_|OCPI_)/.test(line))
        ) {
          report(
            `WARN ${join(dir, name)} sets ANTECHAMBER_*/OCPI_*; ${name > "antechamber.conf" ? "later files override this drop-in" : "review earlier settings and legacy fallbacks"}.`,
          );
        }
      }
    }
  }

  const stamp = ctx.now().toISOString().replace(/\D/g, "").slice(0, 14);
  const backup = (path: string): void => {
    const target = `${path}.bak-antechamber-${stamp}`;
    if (options.dryRun) {
      if (ctx.fs.existsSync(target)) {
        throw Object.assign(new Error(`EEXIST: file already exists, copyfile '${path}' -> '${target}'`), {
          code: "EEXIST",
        });
      }
      report(`Would back up ${path} to ${target}`);
    } else {
      ctx.fs.copyFileSync(path, target, ctx.fs.constants.COPYFILE_EXCL);
      report(`Backed up ${path} to ${target}`);
    }
  };
  if (binary === ctx.cliPath && (ctx.fs.statSync(binary).mode & 0o111) === 0) {
    if (options.dryRun) report(`Would make ${binary} executable`);
    else {
      ctx.fs.chmodSync(binary, ctx.fs.statSync(binary).mode | 0o111);
      report(`Made ${binary} executable`);
    }
  }
  if (launcher !== undefined && launcherText !== undefined) {
    if (oldLauncher === launcherText && (ctx.fs.statSync(launcher).mode & 0o111) !== 0)
      report(`Already configured: ${launcher}`);
    else if (options.dryRun) report(`Would write auto-update launcher ${launcher} for ${binary}`);
    else {
      ctx.fs.mkdirSync(dirname(launcher), { recursive: true });
      writeAtomically(launcher, launcherText, ctx);
      ctx.fs.chmodSync(launcher, 0o755);
      report(`Wrote auto-update launcher ${launcher} for ${binary}`);
    }
  }
  if (changed) {
    report(`${options.dryRun ? "Would update" : "Updating"} ${settings}`);
    report(`- opencodeBinary: ${JSON.stringify(data.opencodeBinary ?? null)}`);
    report(`+ opencodeBinary: ${JSON.stringify(configured)}`);
    if (existing) backup(settings);
    if (!options.dryRun) {
      ctx.fs.mkdirSync(dirname(settings), { recursive: true });
      writeAtomically(settings, updated, ctx);
      report(`Wrote ${settings}`);
    }
  } else report(`Already configured: ${settings} points at ${configured}`);

  if (dropIn !== undefined && dropInText !== undefined) {
    if (oldDropIn === dropInText) report(`Already configured: ${dropIn}`);
    else {
      report(`${options.dryRun ? "Would write" : "Writing"} ${dropIn}:\n${dropInText}`);
      if (oldDropIn !== undefined) backup(dropIn);
      if (!options.dryRun) {
        ctx.fs.mkdirSync(dirname(dropIn), { recursive: true });
        writeAtomically(dropIn, dropInText, ctx);
        report(`Wrote ${dropIn}`);
      }
    }
    const unit = options.systemd ?? "openchamber.service";
    report(`systemctl --user daemon-reload && systemctl --user restart ${shellQuote(unit)}`);
    if (options.restart && !options.dryRun) {
      ctx.exec("systemctl", ["--user", "daemon-reload"]);
      report("Reloaded systemd user units");
      ctx.exec("systemctl", ["--user", "restart", unit]);
      report(`Restarted ${unit}`);
    }
  }
  if (options.profile !== undefined && options.settings === undefined) {
    report(`OPENCHAMBER_DATA_DIR=${shellQuote(resolve(ctx.cwd, options.profile))} openchamber serve`);
  }
  const extension = omoGraphExtensionDir(ctx);
  if (extension !== undefined) {
    report(
      `Optional OmO Graph extension: in OpenChamber, Settings \u2192 Extensions \u2192 Add \u2192 Folder: ${extension}`,
    );
  }
  const work = omoWorkExtensionDir(ctx);
  if (work !== undefined) {
    report(
      `Optional OmO Work section (todo phases, monitors, eval cells; OpenChamber 2.x): Settings \u2192 Extensions \u2192 Add \u2192 Folder: ${work}`,
    );
  }
  const compat = omoCompatExtensionDir(ctx);
  if (compat !== undefined) {
    report(
      `Optional OmO Compatibility extension (eval card headers): Settings \u2192 Extensions \u2192 Add \u2192 Folder: ${compat}`,
    );
  }
  return lines;
}
