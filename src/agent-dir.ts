import { homedir } from "node:os";
import { join } from "node:path";
import { isPlainPi } from "./config.js";

function expandLeadingTilde(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(home, path.slice(2));
  return path;
}

/**
 * Root directory of the coding agent's state. Mirrors OmO's own resolution
 * (OMO_ > SENPI_ > PI_CODING_AGENT_DIR, default ~/.omo/agent); a plain pi
 * backend defaults to pi's ~/.pi/agent instead.
 */
export function piAgentDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const configured = [env.OMO_CODING_AGENT_DIR, env.SENPI_CODING_AGENT_DIR, env.PI_CODING_AGENT_DIR].find(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );
  if (configured !== undefined) return expandLeadingTilde(configured.trim(), home);
  return isPlainPi(env) ? join(home, ".pi", "agent") : join(home, ".omo", "agent");
}
