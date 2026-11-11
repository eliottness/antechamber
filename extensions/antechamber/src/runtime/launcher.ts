// Run by bin/opencode-antechamber under Bun.
//   resolve  installs the pinned runtime when it is missing and prints antechamber's CLI path
//   version  prints the OpenCode API version antechamber reports, without installing anything
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultEnv, ensureRuntime, findBun, runtimePaths } from "./runtime.ts";

declare const __OPENCODE_API_VERSION__: string;

const extensionDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2];

if (command === "version") {
  console.log(`opencode v${__OPENCODE_API_VERSION__}`);
} else if (command === "resolve") {
  const { version } = JSON.parse(readFileSync(join(extensionDir, "package.json"), "utf8")) as { version: string };
  const env = defaultEnv();
  try {
    const runtime = await ensureRuntime(runtimePaths(version, env), findBun(env) ?? process.execPath);
    console.log(runtime.cli);
  } catch (error) {
    console.error(`opencode-antechamber: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
} else {
  console.error(`opencode-antechamber: unknown launcher command '${command ?? ""}'`);
  process.exit(2);
}
