import { envSetting } from "../config.js";
import { AdapterServer, isLoopbackHost, serverPassword } from "../server.js";

export interface ServeOptions {
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
  const shutdown = (): void => {
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
  if (compatible) console.log(`opencode server listening on ${server.url}`);
  else {
    console.log(`antechamber listening on ${server.url}`);
    console.log(`default directory: ${directory}`);
  }
}
