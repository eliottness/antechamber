import { homedir } from "node:os";
import { join } from "node:path";
import { isPlainPi } from "./config.js";

function expandLeadingTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

/**
 * Root directory of the coding agent's state. Mirrors OmO's own resolution
 * (OMO_ > SENPI_ > PI_CODING_AGENT_DIR, default ~/.omo/agent); a plain pi
 * backend defaults to pi's ~/.pi/agent instead.
 */
export function piAgentDir(): string {
  const configured = [
    process.env.OMO_CODING_AGENT_DIR,
    process.env.SENPI_CODING_AGENT_DIR,
    process.env.PI_CODING_AGENT_DIR,
  ].find((value): value is string => typeof value === "string" && value.trim() !== "");
  if (configured !== undefined) return expandLeadingTilde(configured.trim());
  return isPlainPi() ? join(homedir(), ".pi", "agent") : join(homedir(), ".omo", "agent");
}
