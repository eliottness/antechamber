import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { rootManifest } from "./root-manifest.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apiVersion = /OPENCODE_API_VERSION = "([^"]+)"/.exec(
  readFileSync(resolve(root, "../../src/version.ts"), "utf8"),
)?.[1];
if (!apiVersion) throw new Error("OPENCODE_API_VERSION not found in src/version.ts");

// The panel and the status section run in sandboxed iframes that cannot load ESM, so they are browser IIFEs.
// The service runs on OpenChamber's own runtime and the launcher on Bun, both as plain ESM.
for (const [entry, outfile] of [
  ["src/graph/panel.ts", "panel/main.js"],
  ["src/work/status.ts", "status/main.js"],
] as const) {
  await build({
    entryPoints: [resolve(root, entry)],
    outfile: resolve(root, outfile),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    minify: true,
    logLevel: "info",
  });
}
await build({
  entryPoints: [resolve(root, "src/service-main.ts")],
  outfile: resolve(root, "service/main.js"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  logLevel: "info",
});
await build({
  entryPoints: [resolve(root, "src/runtime/launcher.ts")],
  outfile: resolve(root, "runtime/launcher.js"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  define: { __OPENCODE_API_VERSION__: JSON.stringify(apiVersion) },
  logLevel: "info",
});
chmodSync(resolve(root, "bin/opencode-antechamber"), 0o755);

// OpenChamber installs a Git URL by cloning the repository root, so the root package.json carries the same
// manifest with every package path pointing into this folder: https://github.com/eliottness/antechamber installs it.
const repoPackagePath = resolve(root, "../../package.json");
const repoPackage = JSON.parse(readFileSync(repoPackagePath, "utf8"));
const synced = rootManifest(JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).openchamber);
if (JSON.stringify(repoPackage.openchamber) !== JSON.stringify(synced)) {
  repoPackage.openchamber = synced;
  writeFileSync(repoPackagePath, `${JSON.stringify(repoPackage, null, 2)}\n`);
  console.log("synced the openchamber manifest into package.json");
}
