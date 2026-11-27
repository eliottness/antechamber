// Run by bin/opencode-antechamber under Bun.
//   resolve  installs the pinned runtime when it is missing and prints antechamber's CLI path
//   version  prints the OpenCode API version antechamber reports, without installing anything
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launcherPath } from "./activate.ts";
import { defaultEnv, ensureRuntime, findBun, launchStampPath, recordLaunch, runtimePaths } from "./runtime.ts";

declare const __OPENCODE_API_VERSION__: string;

const extensionDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2];

if (command === "version") {
  console.log(`opencode v${__OPENCODE_API_VERSION__}`);
} else if (command === "resolve") {
  const { version } = JSON.parse(readFileSync(join(extensionDir, "package.json"), "utf8")) as { version: string };
  const env = defaultEnv();
  try {
    const paths = runtimePaths(version, env);
    const runtime = await ensureRuntime(paths, findBun(env) ?? process.execPath);
    // Tells the extension's service that OpenChamber now runs antechamber, so it stops asking for a reload.
    try {
      recordLaunch(launchStampPath(env.home, launcherPath(extensionDir)));
    } catch (error) {
      console.error(
        `opencode-antechamber: could not record the launch: ${error instanceof Error ? error.message : error}`,
      );
    }
    console.log(runtime.cli);
  } catch (error) {
    console.error(`opencode-antechamber: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
} else {
  console.error(`opencode-antechamber: unknown launcher command '${command ?? ""}'`);
  process.exit(2);
}
