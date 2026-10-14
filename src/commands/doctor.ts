import { dirname, resolve } from "node:path";
import { piAgentDir } from "../agent-dir.js";
import { detectAgentName } from "../agent-name.js";
import { agentBinary, defaultStateDir, envSetting, isPlainPi } from "../config.js";
import { findPidfdPython } from "../pidfd.js";
import {
  type CommandContext,
  createContext,
  isPackageBinary,
  readSettings,
  resolveBinary,
  type SettingsOptions,
  settingsPath,
} from "./context.js";

export interface DoctorCheck {
  readonly name: string;
  readonly status: "PASS" | "WARN" | "FAIL" | "INFO";
  readonly message: string;
}

export interface DoctorReport {
  readonly checks: readonly DoctorCheck[];
  readonly exitCode: 0 | 1;
}

/** Checks capabilities with access/stat only, never creating state or config files. */
export function doctor(options: SettingsOptions = {}, ctx: CommandContext = createContext()): DoctorReport {
  const checks: DoctorCheck[] = [];
  const add = (name: string, status: DoctorCheck["status"], message: string): void => {
    checks.push({ name, status, message });
  };
  add("node", Number(ctx.nodeVersion.split(".")[0]) >= 22 ? "PASS" : "FAIL", `Node ${ctx.nodeVersion}; requires >=22`);
  const backend = agentBinary(ctx.env);
  const binary = resolveBinary(backend, ctx);
  if (binary === undefined) add("backend", "FAIL", `${backend} is not an executable on PATH`);
  else {
    try {
      add("backend", "PASS", `${binary}: ${ctx.exec(binary, ["--version"]) || "version command succeeded"}`);
    } catch (error) {
      add("backend", "FAIL", `${binary}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  add(
    "backend-kind",
    isPlainPi(ctx.env) ? "WARN" : "PASS",
    isPlainPi(ctx.env)
      ? "plain pi backend: best effort; OmO features unavailable"
      : `OmO-compatible backend (${backend})`,
  );
  const agentDir = resolve(ctx.cwd, piAgentDir(ctx.env, ctx.home));
  add("agent-dir", ctx.fs.existsSync(agentDir) && ctx.fs.statSync(agentDir).isDirectory() ? "PASS" : "FAIL", agentDir);
  add("agent-name", "PASS", detectAgentName(ctx.env, ctx.home, ctx.fs));
  const stateDir = resolve(ctx.cwd, envSetting("STATE_DIR", ctx.env) ?? defaultStateDir(ctx.home, ctx.fs.existsSync));
  try {
    let ancestor = stateDir;
    while (!ctx.fs.existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
    if (!ctx.fs.statSync(ancestor).isDirectory()) throw new Error(`${ancestor} is not a directory`);
    ctx.fs.accessSync(ancestor, ctx.fs.constants.W_OK | ctx.fs.constants.X_OK);
    add(
      "state-dir",
      "PASS",
      `${stateDir}${ancestor === stateDir ? " is writable" : ` can be created under writable ${ancestor}`}`,
    );
  } catch (error) {
    add("state-dir", "FAIL", `${stateDir}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const python =
    ctx.platform === "linux"
      ? findPidfdPython(ctx.env, (candidate, args) => {
          try {
            ctx.exec(candidate, args);
            return true;
          } catch (error) {
            if (!(error instanceof Error)) throw error;
            return false;
          }
        })
      : undefined;
  add(
    "private-host-teardown",
    python === undefined ? "WARN" : "PASS",
    python === undefined
      ? "requires Linux and python3 with working pidfd support"
      : `Linux pidfd support via ${python}`,
  );
  const openchamber = resolveBinary("openchamber", ctx);
  if (openchamber === undefined) add("openchamber", "WARN", "openchamber is not on PATH");
  else {
    try {
      add("openchamber", "PASS", `${openchamber}: ${ctx.exec(openchamber, ["--version"]) || "version not reported"}`);
    } catch (error) {
      add(
        "openchamber",
        "WARN",
        `${openchamber}: version not determinable (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  const settings = settingsPath(options, ctx);
  if (!ctx.fs.existsSync(settings))
    add("openchamber-settings", "WARN", `${settings} does not exist; run antechamber setup`);
  else {
    try {
      const configured = readSettings(settings, ctx).opencodeBinary;
      const matches = typeof configured === "string" && isPackageBinary(configured, ctx);
      add(
        "openchamber-settings",
        matches ? "PASS" : "WARN",
        `${settings}: opencodeBinary=${JSON.stringify(configured ?? null)}${matches ? "" : "; does not point at this antechamber installation"}`,
      );
    } catch (error) {
      add("openchamber-settings", "WARN", error instanceof Error ? error.message : String(error));
    }
  }
  add("auth", "INFO", `OPENCODE_SERVER_PASSWORD is ${ctx.env.OPENCODE_SERVER_PASSWORD ? "set" : "not set"}`);
  return { checks, exitCode: checks.some((check) => check.status === "FAIL") ? 1 : 0 };
}

export function formatDoctor(report: DoctorReport, json: boolean): string {
  return json
    ? JSON.stringify(report, null, 2)
    : report.checks.map((check) => `${check.status} ${check.name}: ${check.message}`).join("\n");
}
