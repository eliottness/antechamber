import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import type { TestContext } from "node:test";
import { AdapterServer } from "../src/server.js";

export async function bounded<T>(promise: Promise<T>): Promise<T> {
  const deadline = AbortSignal.timeout(3_000);
  let onAbort = () => {};
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error("generation did not settle at its lifecycle boundary"));
        deadline.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    deadline.removeEventListener("abort", onAbort);
  }
}

/** Drive the actual operation timer callback without advancing RPC or teardown timers. */
export function generationTimer(t: TestContext) {
  const set = globalThis.setTimeout;
  const clear = globalThis.clearTimeout;
  const timers = new Map<ReturnType<typeof setTimeout>, { remaining: number; fire: () => void }>();
  t.mock.method(globalThis, "setTimeout", (callback: () => void, ms?: number) => {
    const timer = set(callback, ms);
    if (ms === 120_000) timers.set(timer, { remaining: ms, fire: callback });
    return timer;
  });
  t.mock.method(globalThis, "clearTimeout", (timer: Parameters<typeof clearTimeout>[0]) => {
    if (typeof timer === "object") timers.delete(timer);
    clear(timer);
  });
  return {
    advance(ms: number): void {
      for (const [timer, pending] of timers) {
        pending.remaining -= ms;
        if (pending.remaining > 0) continue;
        timers.delete(timer);
        clear(timer);
        pending.fire();
      }
    },
  };
}

export async function generationHarness(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "antechamber-generation-"));
  const log = join(root, "generations.jsonl");
  writeFileSync(log, "");
  const env = {
    ANTECHAMBER_PI_BINARY: resolve("test/fixtures/fake-omo-endpoints.mjs"),
    ANTECHAMBER_STATE_DIR: join(root, "state"),
    FAKE_OMO_GENERATION_LOG: log,
  };
  const saved = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const timer = generationTimer(t);
  const children = new Map<childProcess.ChildProcess, Promise<void>>();
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (...args: Parameters<typeof spawn>) => {
    const child = spawn(...args);
    children.set(child, new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())));
    return child;
  });
  syncBuiltinESMExports();
  const server = new AdapterServer({ host: "127.0.0.1", port: 0, defaultDirectory: root });
  await server.start();
  t.after(async () => {
    // Only our own children, and only after the assertions; red tests must leave no agents either.
    timer.advance(120_000);
    for (const child of children.keys())
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await bounded(Promise.all(children.values()));
    await server.stop();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const events = (): Array<{ event: string; pid: number }> =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line: string) => JSON.parse(line));
  return {
    root,
    server,
    url: server.url,
    events,
    timer,
    release: () => writeFileSync(join(root, "release-generation"), "release"),
    async wait(event: string, count = 1): Promise<void> {
      let changed = () => {};
      const watcher = watch(root, () => changed());
      try {
        await bounded(
          new Promise<void>((resolveEvent) => {
            changed = () => {
              if (events().filter((entry) => entry.event === event).length >= count) resolveEvent();
            };
            changed();
          }),
        );
      } finally {
        watcher.close();
      }
    },
    async gone(): Promise<void> {
      await bounded(Promise.all(children.values()));
      const spawned = events()
        .filter((entry) => entry.event === "spawn")
        .map((entry) => entry.pid);
      assert.notEqual(spawned.length, 0, "the test must have started a generation agent");
      assert.deepEqual(
        events()
          .filter((entry) => entry.event === "exit")
          .map((entry) => entry.pid)
          .sort(),
        [...spawned].sort(),
        "every generation spawn has an exit in the fixture log",
      );
      for (const pid of spawned) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    },
  };
}
