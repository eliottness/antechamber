import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Environment variable prefix for all antechamber settings. */
export const ENV_PREFIX = "ANTECHAMBER_";
/** Prefix used before the project was renamed; still honoured as a fallback. */
const LEGACY_ENV_PREFIX = "OCPI_";

/**
 * Reads `ANTECHAMBER_<name>`, falling back to the deprecated `OCPI_<name>`.
 * Blank values count as unset.
 */
export function envSetting(name: string): string | undefined {
  for (const key of [ENV_PREFIX + name, LEGACY_ENV_PREFIX + name]) {
    const value = process.env[key];
    if (value !== undefined && value.trim() !== "") return value;
  }
  return undefined;
}

/**
 * Default registry/state directory. Prefers `~/.config/antechamber`; when only
 * the pre-rename directory exists it keeps using that so existing session
 * mappings survive the upgrade.
 */
export function defaultStateDir(): string {
  const config = join(homedir(), ".config");
  const current = join(config, "antechamber");
  const legacy = join(config, "openchamber-pi-connector");
  if (!existsSync(current) && existsSync(legacy)) return legacy;
  return current;
}
