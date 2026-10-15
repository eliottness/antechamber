#!/usr/bin/env node
/** CLI parsing and dispatch. Server code is loaded only for serve/default mode. */
import { parseArgs } from "node:util";
import { ADAPTER_VERSION, OPENCODE_API_VERSION } from "./version.js";

try {
  const argv = process.argv.slice(2);
  // Keep this probe byte-identical: OpenChamber expects an OpenCode 2.x version.
  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(`opencode v${OPENCODE_API_VERSION}`);
  } else {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h" },
        port: { type: "string" },
        host: { type: "string" },
        hostname: { type: "string" },
        directory: { type: "string" },
        "insecure-no-auth": { type: "boolean" },
        settings: { type: "string" },
        profile: { type: "string" },
        binary: { type: "string" },
        "dry-run": { type: "boolean" },
        systemd: { type: "boolean" },
        "pi-binary": { type: "string" },
        restart: { type: "boolean" },
        "auto-update": { type: "boolean" },
        json: { type: "boolean" },
      },
    });
    const command = values.help ? "help" : (positionals[0] ?? "serve");
    if (command === "help") {
      const { help } = await import("./commands/help.js");
      console.log(help);
    } else if (command === "version") {
      console.log(`antechamber ${ADAPTER_VERSION} (OpenCode API v${OPENCODE_API_VERSION})`);
    } else if (command === "setup") {
      if (positionals.length > (values.systemd ? 2 : 1)) throw new Error("Unexpected setup argument");
      const { setup } = await import("./commands/setup.js");
      setup({
        ...(values.settings !== undefined ? { settings: values.settings } : {}),
        ...(values.profile !== undefined ? { profile: values.profile } : {}),
        ...(values.binary !== undefined ? { binary: values.binary } : {}),
        ...(values["pi-binary"] !== undefined ? { piBinary: values["pi-binary"] } : {}),
        ...(values.systemd ? { systemd: positionals[1] ?? "openchamber.service" } : {}),
        dryRun: values["dry-run"] ?? false,
        restart: values.restart ?? false,
        autoUpdate: values["auto-update"] ?? false,
      });
    } else if (command === "upgrade") {
      if (positionals.length > 1) throw new Error("Unexpected upgrade argument");
      const { upgrade } = await import("./commands/upgrade.js");
      await upgrade();
    } else if (command === "doctor") {
      const { doctor, formatDoctor } = await import("./commands/doctor.js");
      const report = doctor({
        ...(values.settings !== undefined ? { settings: values.settings } : {}),
        ...(values.profile !== undefined ? { profile: values.profile } : {}),
      });
      console.log(formatDoctor(report, values.json ?? false));
      process.exitCode = report.exitCode;
    } else if (command === "serve") {
      if (positionals.length > 1) throw new Error("Unexpected serve argument");
      const { serve } = await import("./commands/serve.js");
      const port = Number(values.port ?? "4096");
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid --port: expected 0-65535");
      await serve({
        port,
        host: values.host ?? values.hostname ?? "127.0.0.1",
        directory: values.directory ?? process.cwd(),
        insecureNoAuth: values["insecure-no-auth"] ?? false,
        compatible: positionals[0] === "serve",
      });
    } else {
      throw new Error(`Unknown command: ${command}. Run antechamber help.`);
    }
  }
} catch (error) {
  console.error(`antechamber: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
