import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * OpenChamber's settings.json for an extension it copied into `<data dir>/extensions/<id>` (Git and ZIP installs;
 * a repository-URL install nests this folder one level deeper). Folder installs have no such parent and get none.
 */
export function openchamberSettingsPath(extensionDir: string): string | undefined {
  for (let dir = extensionDir; dirname(dir) !== dir; dir = dirname(dir)) {
    if (basename(dirname(dir)) !== "extensions") continue;
    const settings = join(dirname(dirname(dir)), "settings.json");
    if (existsSync(settings)) return settings;
  }
  return undefined;
}

export function configuredBinary(settings: string): string | undefined {
  const value = (JSON.parse(readFileSync(settings, "utf8")) as { opencodeBinary?: unknown }).opencodeBinary;
  return typeof value === "string" ? value : undefined;
}

/**
 * Points OpenChamber's OpenCode CLI at `launcher`, as Settings -> OpenCode CLI would: OpenChamber reads
 * `opencodeBinary` from settings.json each time it starts OpenCode, so Reload OpenCode applies it. The previous file
 * is kept beside it; every other setting is preserved.
 */
export function activateLauncher(settings: string, launcher: string, now: Date = new Date()): { backup?: string } {
  const data = JSON.parse(readFileSync(settings, "utf8")) as Record<string, unknown>;
  if (data.opencodeBinary === launcher) return {};
  const backup = `${settings}.bak-antechamber-${now.toISOString().replace(/\D/g, "").slice(0, 14)}`;
  if (!existsSync(backup)) copyFileSync(settings, backup);
  const mode = statSync(settings).mode & 0o777;
  const temporary = `${settings}.antechamber-${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ ...data, opencodeBinary: launcher }, null, 2)}\n`, { mode });
  chmodSync(temporary, mode);
  renameSync(temporary, settings);
  return { backup };
}
