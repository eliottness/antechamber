import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The panel runs in a sandboxed iframe that cannot load ESM, so it is a browser IIFE.
// The service runs under OpenChamber's own Node runtime as plain ESM.
await build({
  entryPoints: [resolve(root, "src/panel.ts")],
  outfile: resolve(root, "panel/main.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: true,
  logLevel: "info",
});
await build({
  entryPoints: [resolve(root, "src/service-main.ts")],
  outfile: resolve(root, "service/main.js"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  logLevel: "info",
});
