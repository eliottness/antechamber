import assert from "node:assert/strict";
import { once } from "node:events";
import { execFileSync, spawnSync } from "node:child_process";
import fs, { mkdtempSync, rmSync } from "node:fs";
import { get, type IncomingMessage } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { AdapterServer } from "../src/server.js";
import { SessionManager } from "../src/sessions.js";

async function branchServer(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "antechamber-branch-stop-"));
  const keys = ["ANTECHAMBER_STATE_DIR", "OMO_CODING_AGENT_DIR", "SENPI_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR"];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.ANTECHAMBER_STATE_DIR = join(root, "state");
  for (const key of keys.slice(1)) process.env[key] = join(root, "agent");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  const watches = t.mock.method(fs, "watch");
  syncBuiltinESMExports();
  const server = new AdapterServer({ host: "127.0.0.1", port: 0, defaultDirectory: root });
  await server.start();
  const release = Promise.withResolvers<void>();
  let stopping: Promise<void> | undefined;
  t.after(async () => {
    release.resolve();
    await (stopping ?? server.stop());
    // Close a leaked real watcher even when the regression fails.
    for (const call of watches.mock.calls) call.result?.close();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    server,
    watches,
    release,
    stop: () => (stopping ??= server.stop()),
  };
}

test("B9 shutdown leaves no Git HEAD watcher from a queued branch read", { timeout: 5_000 }, async (t) => {
  const { root, server, watches, release, stop } = await branchServer(t);
  assert.equal((await fetch(`${server.url}/api/vcs`)).status, 200);
  const watcher = watches.mock.calls[0]?.result;
  assert.ok(watcher);
  const close = t.mock.method(watcher, "close");
  // Gate the existing queue at the review probe's actual shutdown clear boundary.
  server["branchChecks"].set(root, release.promise);
  const queued = server["vcsBranch"](root);
  const watchers = server["branchWatchers"];
  const clear = watchers.clear.bind(watchers);
  t.mock.method(watchers, "clear", () => {
    clear();
    release.resolve();
  });

  await stop();
  await queued;

  assert.equal(watchers.size, 0, "stop leaked a branch watcher created by an already-queued read");
  assert.equal(close.mock.callCount(), 1, "stop must close the existing native watcher");
  assert.equal(watches.mock.callCount(), 1, "the queued read must not allocate a watcher while stopping");
});

test("B9 a pending Git HEAD lookup cannot allocate a watcher after stopping", { timeout: 5_000 }, async (t) => {
  const { root, server, watches, stop } = await branchServer(t);
  const lookup = server["watchBranch"](root);

  await stop();
  await lookup;

  assert.equal(watches.mock.callCount(), 0, "a Git lookup started before stop must not allocate after it");
  assert.equal(server["branchWatchers"].size, 0);
});

test("busy shutdown completes while the SSE client tries to reconnect during disposal", {
  timeout: 15_000,
}, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "antechamber-shutdown-"));
  const previousBinary = process.env.ANTECHAMBER_PI_BINARY;
  const previousState = process.env.ANTECHAMBER_STATE_DIR;
  process.env.ANTECHAMBER_PI_BINARY = resolve("test/fixtures/fake-omo.mjs");
  process.env.ANTECHAMBER_STATE_DIR = join(dir, "state");
  const server = new AdapterServer({ host: "127.0.0.1", port: 0, defaultDirectory: dir });
  let releaseDisposal: () => void = () => undefined;
  let stopping: Promise<void> | undefined;
  const clients: IncomingMessage[] = [];
  t.after(async () => {
    releaseDisposal();
    for (const client of clients) client.destroy();
    await (stopping ?? server.stop());
    if (previousBinary === undefined) delete process.env.ANTECHAMBER_PI_BINARY;
    else process.env.ANTECHAMBER_PI_BINARY = previousBinary;
    if (previousState === undefined) delete process.env.ANTECHAMBER_STATE_DIR;
    else process.env.ANTECHAMBER_STATE_DIR = previousState;
    rmSync(dir, { recursive: true, force: true });
  });

  // Given a busy real RPC fixture and a connected, consuming SSE client.
  await server.start();
  const info: { id: string } = (await fetch(`${server.url}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }).then((response) => response.json())) as { id: string };
  const prompt = await fetch(`${server.url}/session/${info.id}/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parts: [{ type: "text", text: "pending-turn" }] }),
  });
  await prompt.json();
  const statuses = (await fetch(`${server.url}/session/status`).then((response) => response.json())) as Record<
    string,
    { type: string }
  >;
  assert.equal(statuses[info.id]!.type, "busy");
  const connect = (): Promise<IncomingMessage> =>
    new Promise((resolveClient, reject) => {
      const request = get(`${server.url}/event`, { agent: false }, (response) => {
        clients.push(response);
        response.resume();
        resolveClient(response);
      });
      request.once("error", reject);
    });
  const originalClient = await connect();
  const ended = once(originalClient, "end", { signal: AbortSignal.timeout(5_000) });

  // Hold the real disposal at its boundary, not on a timing-dependent sleep.
  // This reproduces the interval while OmO and its private hosts are exiting.
  let disposalEntered: () => void = () => undefined;
  const entered = new Promise<void>((resolveEntered) => {
    disposalEntered = resolveEntered;
  });
  const disposalGate = new Promise<void>((resolveGate) => {
    releaseDisposal = resolveGate;
  });
  const disposeAll = SessionManager.prototype.disposeAll;
  t.mock.method(SessionManager.prototype, "disposeAll", async function (this: SessionManager) {
    disposalEntered();
    await disposalGate;
    await disposeAll.call(this);
  });

  // When shutdown ends SSE, reconnect exactly as an SSE proxy would.
  stopping = server.stop();
  await Promise.all([entered, ended]);
  await connect().catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "ECONNREFUSED")) throw error;
  });
  releaseDisposal();

  // Then shutdown must resolve without requiring the replacement client to close.
  const deadline = AbortSignal.timeout(2_000);
  const completed = await Promise.race([
    stopping.then(() => true),
    new Promise<boolean>((resolveDeadline) =>
      deadline.addEventListener("abort", () => resolveDeadline(false), { once: true }),
    ),
  ]);
  assert.equal(completed, true, "server.stop hung on the SSE connection admitted during disposal");
});

for (const scenario of ["stop", "ended", "destroyed"]) {
  test(`pending approval shutdown never broadcasts to ${scenario} SSE responses`, { timeout: 6000 }, () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "test/fixtures/pending-sse-shutdown.mjs", scenario],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 4000,
      },
    );
    assert.equal(result.error, undefined, result.error?.message ?? "shutdown probe failed");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /SHUTDOWN_PASS/);
  });
}
