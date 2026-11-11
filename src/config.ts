import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/** Environment variable prefix for all antechamber settings. */
export const ENV_PREFIX = "ANTECHAMBER_";
/** Prefix used before the project was renamed; still honoured as a fallback. */
const LEGACY_ENV_PREFIX = "OCPI_";

/**
 * Reads `ANTECHAMBER_<name>`, falling back to the deprecated `OCPI_<name>`.
 * Blank values count as unset.
 */
export function envSetting(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const key of [ENV_PREFIX + name, LEGACY_ENV_PREFIX + name]) {
    const value = env[key];
    if (value !== undefined && value.trim() !== "") return value;
  }
  return undefined;
}

/**
 * Default registry/state directory. Prefers `~/.config/antechamber`; when only
 * the pre-rename directory exists it keeps using that so existing session
 * mappings survive the upgrade.
 */
export function defaultStateDir(home: string = homedir(), exists: typeof existsSync = existsSync): string {
  const config = join(home, ".config");
  const current = join(config, "antechamber");
  const legacy = join(config, "openchamber-pi-connector");
  if (!exists(current) && exists(legacy)) return legacy;
  return current;
}

/** The OmO that antechamber's package.json pins, when it is installed beside antechamber. */
export function bundledOmo(): string | undefined {
  try {
    return join(dirname(createRequire(import.meta.url).resolve("omo-ai/package.json")), "bin", "omo.js");
  } catch {
    return undefined;
  }
}

/** Agent executable spawned per session: the pinned OmO by default, else `omo` on PATH, plain pi when configured. */
export function agentBinary(
  env: NodeJS.ProcessEnv = process.env,
  bundled: () => string | undefined = bundledOmo,
): string {
  return envSetting("PI_BINARY", env) ?? bundled() ?? "omo";
}

/** Set by the OpenChamber extension's launcher: the extension, not npm, installs and updates antechamber. */
export function managedByExtension(env: NodeJS.ProcessEnv = process.env): boolean {
  return envSetting("MANAGED", env) === "openchamber-extension";
}

/** True when the configured backend is upstream pi rather than OmO. */
export function isPlainPi(env: NodeJS.ProcessEnv = process.env): boolean {
  return basename(agentBinary(env)).replace(/\.(exe|cmd)$/i, "") === "pi";
}
