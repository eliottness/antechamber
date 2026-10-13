#!/usr/bin/env node
/**
 * antechamber CLI.
 *
 * Default mode:
 *   antechamber [--port 4096] [--host 127.0.0.1] [--directory /path]
 *
 * OpenCode-compatible serve mode — OpenChamber spawns
 * `$OPENCODE_BINARY serve --hostname H --port P` and waits for the stdout
 * line "opencode server listening on <url>", then health-checks
 * GET /global/health:
 *   antechamber serve --hostname 127.0.0.1 --port 4096 [--directory /path]
 */

import { AdapterServer, isLoopbackHost, serverPassword } from "./server.js";
import { envSetting } from "./config.js";

function arg(name: string, fallback: string): string {
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === `--${name}` && argv[i + 1] !== undefined) return argv[i + 1]!;
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return fallback;
}

// OpenChamber >= 2.0.4 probes `<binary> --version` and requires opencode
// >= 2.0.15 (major 2); advertise the v2 API contract this adapter implements.
if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log("opencode v2.0.18");
  process.exit(0);
}

const serveMode = process.argv[2] === "serve";

const port = Number(arg("port", "4096"));
const host = arg("host", arg("hostname", "127.0.0.1"));
const directory = arg("directory", process.cwd());

if (!isLoopbackHost(host) && serverPassword() === undefined &&
    !process.argv.includes("--insecure-no-auth") && envSetting("ALLOW_INSECURE") !== "1") {
  console.error(`antechamber: refusing to bind ${host} without authentication. Set OPENCODE_SERVER_PASSWORD or ANTECHAMBER_SERVER_PASSWORD, or explicitly use --insecure-no-auth (ANTECHAMBER_ALLOW_INSECURE=1).`);
  process.exit(1);
}

const server = new AdapterServer({ port, host, defaultDirectory: directory });

await server.start();

if (serveMode) {
  console.log(`opencode server listening on ${server.url}`);
} else {
  console.log(`antechamber listening on ${server.url}`);
  console.log(`default directory: ${directory}`);
}

const shutdown = (): void => {
  void server.stop().then(() => process.exit(0), (error: unknown) => {
    console.error("antechamber: shutdown failed:", error);
    process.exit(1);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
