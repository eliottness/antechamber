import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultEnv, findBun, runtimePaths } from "./runtime/runtime.ts";
import { createService } from "./service.ts";

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
if (!port || !token) {
  console.error("OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required");
  process.exit(1);
}
const extensionDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(extensionDir, "package.json"), "utf8")) as { version: string };
const env = defaultEnv();
createService({
  token,
  extensionDir,
  paths: runtimePaths(version, env),
  bun: findBun(env),
  prewarm: true,
}).listen(port, "127.0.0.1");
