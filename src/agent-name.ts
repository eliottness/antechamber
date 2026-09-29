/**
 * Agent-name detection: the adapter reports one OpenCode "agent" to the UI.
 * When the pi instance runs the oh-my-pi extension, the real agent name comes
 * from ~/.pi/oh-my-pi.jsonc (orchestrator.agentName); otherwise we fall back
 * to the historical "build" name. Resolution order:
 *   1. OCPI_AGENT env override
 *   2. ~/.pi/oh-my-pi.jsonc → orchestrator.agentName
 *   3. ~/.pi/agent/settings.json packages containing oh-my-pi → "oh-my-pi"
 *   4. "build"
 * The result is memoized: config changes require an adapter restart.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Strip `//` line comments that are not inside string literals (JSONC). */
function stripLineComments(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    out += c;
  }
  return out;
}

function detect(): string {
  const fromEnv = process.env.OCPI_AGENT;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim();

  try {
    const raw = readFileSync(join(homedir(), ".pi", "oh-my-pi.jsonc"), "utf8");
    const cfg = JSON.parse(stripLineComments(raw)) as { orchestrator?: { agentName?: unknown } };
    const name = cfg.orchestrator?.agentName;
    if (typeof name === "string" && name.trim() !== "") return name.trim();
  } catch {
    // missing or unparseable config → fall through
  }

  try {
    const raw = readFileSync(join(homedir(), ".pi", "agent", "settings.json"), "utf8");
    const settings = JSON.parse(raw) as { packages?: unknown };
    if (Array.isArray(settings.packages) && settings.packages.some((p) => typeof p === "string" && p.includes("oh-my-pi"))) {
      return "oh-my-pi";
    }
  } catch {
    // missing or unparseable settings → fall through
  }

  return "build";
}

let cached: string | undefined;

export function getAgentName(): string {
  if (cached === undefined) cached = detect();
  return cached;
}

/**
 * Agent names the adapter publishes to OpenChamber's picker. pi has exactly one
 * agent, but OpenChamber's default-agent resolution prefers a primary agent
 * named `build` (and its settings UI assumes one exists), so `build` is always
 * published alongside pi's own name. Both are aliases for the same pi agent —
 * the requested agent name is not forwarded to pi, so selecting either runs
 * the same agent. When pi's name already is `build` the list collapses to one.
 */
export function getExposedAgentNames(): string[] {
  const piName = getAgentName();
  return piName === "build" ? ["build"] : ["build", piName];
}
