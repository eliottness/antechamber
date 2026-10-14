/**
 * Agent-name detection: the adapter reports one OpenCode "agent" to the UI.
 * Resolution order (<agent dir> is piAgentDir(), ~/.omo/agent by default):
 *   1. ANTECHAMBER_AGENT env override
 *   2. <agent dir>/../oh-my-pi.jsonc → orchestrator.agentName
 *   3. <agent dir>/../omo.jsonc exists (an OmO install) → "OmO"
 *   4. <agent dir>/settings.json packages containing oh-my-pi → "oh-my-pi"
 *   5. "build" (plain pi)
 * The result is memoized: config changes require an adapter restart.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { envSetting } from "./config.js";
import { piAgentDir } from "./agent-dir.js";

/** Strip JSONC comments without touching string literals or joining tokens. */
function stripComments(text: string): string {
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
    if (c === "/" && text[i + 1] === "*") {
      out += " ";
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] === "\n") out += "\n";
        i++;
      }
      if (i === text.length) throw new SyntaxError("Unterminated JSONC block comment");
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

export function detectAgentName(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  fs: { readonly existsSync: typeof existsSync; readonly readFileSync: typeof readFileSync } = {
    existsSync,
    readFileSync,
  },
): string {
  const fromEnv = envSetting("AGENT", env);
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim();
  const agentDir = piAgentDir(env, home);

  try {
    const raw = fs.readFileSync(join(dirname(agentDir), "oh-my-pi.jsonc"), "utf8");
    const cfg = JSON.parse(stripComments(raw)) as { orchestrator?: { agentName?: unknown } };
    const name = cfg.orchestrator?.agentName;
    if (typeof name === "string" && name.trim() !== "") return name.trim();
  } catch {
    // missing or unparseable config → fall through
  }

  if (fs.existsSync(join(dirname(agentDir), "omo.jsonc"))) return "OmO";

  try {
    const raw = fs.readFileSync(join(agentDir, "settings.json"), "utf8");
    const settings = JSON.parse(raw) as { packages?: unknown };
    if (
      Array.isArray(settings.packages) &&
      settings.packages.some((p) => typeof p === "string" && p.includes("oh-my-pi"))
    ) {
      return "oh-my-pi";
    }
  } catch {
    // missing or unparseable settings → fall through
  }

  return "build";
}

let cached: string | undefined;

export function getAgentName(): string {
  if (cached === undefined) cached = detectAgentName();
  return cached;
}

/**
 * Agent names the adapter publishes to OpenChamber's picker. pi has exactly one
 * agent. The resolved pi name is published first so OpenChamber chooses it for
 * new sessions; `build` remains a compatibility alias for existing sessions.
 * Both names run the same pi agent — the requested agent name is not forwarded
 * to pi. When pi's name already is `build` the list collapses to one.
 */
export function getExposedAgentNames(): string[] {
  const piName = getAgentName();
  return piName === "build" ? ["build"] : [piName, "build"];
}
