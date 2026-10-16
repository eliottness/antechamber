import { spawnSync } from "node:child_process";
import { delimiter, resolve } from "node:path";

// biome-ignore lint/complexity/noUselessStringRaw: embedded Python must keep any backslashes verbatim.
const pidfdProbe = String.raw`
import os, selectors, signal
fd = os.pidfd_open(os.getpid())
try:
    signal.pidfd_send_signal(fd, 0)
    with selectors.DefaultSelector() as selector:
        selector.register(fd, selectors.EVENT_READ)
finally:
    os.close(fd)
`;

/** Shared by private-host teardown and doctor; no probing at module import. */
export function findPidfdPython(
  env: NodeJS.ProcessEnv = process.env,
  probe: (binary: string, args: readonly string[]) => boolean = (binary, args) => {
    const result = spawnSync(binary, args, { stdio: "ignore", timeout: 1_000, killSignal: "SIGKILL", env });
    return !result.error && result.status === 0;
  },
): string | undefined {
  const candidates = new Set([
    ...(env.PATH ?? "").split(delimiter).map((directory) => resolve(directory, "python3")),
    "/bin/python3",
    "/usr/bin/python3",
  ]);
  for (const binary of candidates) {
    if (probe(binary, ["-I", "-c", pidfdProbe])) return binary;
  }
  return undefined;
}
