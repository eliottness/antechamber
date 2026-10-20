import * as fs from "node:fs";
import { homedir } from "node:os";
import { defaultStateDir, envSetting } from "../config.js";
import { recordRunningServer } from "../running-servers.js";
import { selfUpdate } from "../self-update.js";
import { AdapterServer, isLoopbackHost, serverPassword } from "../server.js";
import { ADAPTER_VERSION } from "../version.js";

interface ServeOptions {
  readonly port: number;
  readonly host: string;
  readonly directory: string;
  readonly insecureNoAuth: boolean;
  readonly compatible: boolean;
}

export async function serve(options: ServeOptions): Promise<void> {
  const { port, host, directory, insecureNoAuth, compatible } = options;
  if (
    !isLoopbackHost(host) &&
    serverPassword() === undefined &&
    !insecureNoAuth &&
    envSetting("ALLOW_INSECURE") !== "1"
  ) {
    throw new Error(
      `refusing to bind ${host} without authentication. Set OPENCODE_SERVER_PASSWORD or ANTECHAMBER_SERVER_PASSWORD, or explicitly use --insecure-no-auth (ANTECHAMBER_ALLOW_INSECURE=1).`,
    );
  }
  const server = new AdapterServer({ port, host, defaultDirectory: directory });
  let forget = (): void => {};
  const shutdown = (): void => {
    forget();
    void server.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error("antechamber: shutdown failed:", error);
        process.exit(1);
      },
    );
  };
  // Install handlers before announcing readiness: a supervisor may signal as
  // soon as it reads the listening line, before this process runs again.
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await server.start();
  try {
    forget = recordRunningServer(
      envSetting("STATE_DIR") ?? defaultStateDir(homedir(), fs.existsSync),
      {
        pid: process.pid,
        version: ADAPTER_VERSION,
        url: server.url,
        started: new Date().toISOString(),
        token: server.extensionToken,
      },
      fs,
    );
  } catch (error) {
    // Doctor and the OmO Work extension read the record; serving must not depend on it.
    console.error(
      `antechamber: cannot record the running version: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (compatible) console.log(`opencode server listening on ${server.url}`);
  else {
    console.log(`antechamber listening on ${server.url}`);
    console.log(`default directory: ${directory}`);
  }
  // After the listening line: OpenChamber's startup timeout must not wait on the registry.
  if (envSetting("AUTO_UPDATE") === "1") void autoUpdate();
}

async function autoUpdate(): Promise<void> {
  try {
    const result = await selfUpdate();
    if (result.updated)
      console.error(`antechamber: auto-update installed ${result.to} (running ${result.from}); it starts next time`);
  } catch (error) {
    console.error(`antechamber: auto-update skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}
