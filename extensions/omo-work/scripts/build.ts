import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The status frame is a sandboxed iframe that cannot load ESM; the service runs on OpenChamber's Node.
await build({
  entryPoints: [resolve(root, "src/status.ts")],
  outfile: resolve(root, "status/main.js"),
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
