import { readFileSync } from "node:fs";

// Both src/version.ts (tsx) and dist/version.js are one directory below package.json.
const manifest: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
if (
  typeof manifest !== "object" ||
  manifest === null ||
  !("version" in manifest) ||
  typeof manifest.version !== "string"
) {
  throw new Error("antechamber package.json has no version");
}
export const ADAPTER_VERSION = manifest.version;

// OpenChamber parses --version as an OpenCode version and requires major 2.
// This API contract version must not follow the npm package version.
export const OPENCODE_API_VERSION = "2.0.18";
