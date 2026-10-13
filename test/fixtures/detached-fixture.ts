import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import type { TestContext } from "node:test";

/** Only test-owned, detached groups may use numeric process-group signals. */
export function trackDetachedFixture(t: TestContext, child: ChildProcess) {
  const exited = once(child, "exit");
  const closed = once(child, "close");
  t.after(async () => {
    const signalGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
    };
    const escalation = setTimeout(() => signalGroup("SIGKILL"), 5_000);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      signalGroup("SIGTERM");
      await Promise.race([
        closed,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`fixture group ${child.pid} did not close`)), 10_000);
        }),
      ]);
    } finally {
      clearTimeout(escalation);
      clearTimeout(timeout);
      // Also kill surviving members if the group leader exited before cleanup.
      signalGroup("SIGKILL");
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
  });
  return exited;
}
