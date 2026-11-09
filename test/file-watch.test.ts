import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { FileWatchRegistry } from "../src/file-watch.js";

function registryFor(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "antechamber-watch-"));
  const registry = new FileWatchRegistry(() => undefined);
  const watches = t.mock.method(fs, "watch");
  syncBuiltinESMExports();
  t.after(() => {
    registry.close();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, registry, watches };
}

/** The native watchers one registry call opened, each with its close() counted. */
function opened(t: TestContext, watches: ReturnType<typeof registryFor>["watches"], call: () => void) {
  const before = watches.mock.callCount();
  call();
  return watches.mock.calls.slice(before).map((entry) => {
    assert.ok(entry.result);
    return t.mock.method(entry.result, "close");
  });
}

const closes = (lease: ReturnType<typeof opened>) => lease.map((close) => close.mock.callCount());

test("a repeated watch renews one lease for another 24 hours", (t) => {
  const { root, registry, watches } = registryFor(t);
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const file = join(root, "notes.txt");
  writeFileSync(file, "before");
  const lease = opened(t, watches, () => registry.watch(root, file, file));
  assert.ok(lease.length > 0);

  t.mock.timers.tick(12 * 60 * 60 * 1000);
  assert.equal(opened(t, watches, () => registry.watch(root, file, file)).length, 0, "renewal must reuse the lease");
  t.mock.timers.tick(12 * 60 * 60 * 1000);
  assert.ok(
    closes(lease).every((count) => count === 0),
    "the original expiry must not close a renewed lease",
  );
  t.mock.timers.tick(12 * 60 * 60 * 1000);
  assert.ok(
    closes(lease).every((count) => count === 1),
    "the renewed lease must expire 24 hours after renewal",
  );
});

test("an abandoned file lease expires and closes its native watcher", (t) => {
  const { root, registry, watches } = registryFor(t);
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const file = join(root, "notes.txt");
  writeFileSync(file, "before");
  const lease = opened(t, watches, () => registry.watch(root, file, file));

  t.mock.timers.tick(24 * 60 * 60 * 1000 - 1);
  assert.ok(closes(lease).every((count) => count === 0));
  t.mock.timers.tick(1);
  assert.ok(
    closes(lease).every((count) => count === 1),
    "expiry must close the watchers without further access",
  );
  assert.equal(
    opened(t, watches, () => registry.watch(root, file, file)).length,
    lease.length,
    "expiry must also forget the registration",
  );
});

test("a full location evicts its soonest expiring lease without evicting another location", (t) => {
  const { root, registry, watches } = registryFor(t);
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const other = join(root, "other");
  mkdirSync(other);
  const otherFile = join(other, "notes.txt");
  writeFileSync(otherFile, "");
  const otherLease = opened(t, watches, () => registry.watch(other, otherFile, otherFile));
  const leases: Array<ReturnType<typeof opened>> = [];
  for (let i = 0; i < 256; i++) {
    const file = join(root, `${i}.txt`);
    writeFileSync(file, "");
    leases.push(opened(t, watches, () => registry.watch(root, file, file)));
  }
  t.mock.timers.tick(1);
  registry.watch(root, join(root, "0.txt"), join(root, "0.txt"));
  const extra = join(root, "256.txt");
  writeFileSync(extra, "");

  registry.watch(root, extra, extra);

  assert.ok(
    closes(leases[1] ?? []).every((count) => count === 1),
    "the soonest expiring lease must make room at 256",
  );
  assert.ok(
    closes(leases[0] ?? []).every((count) => count === 0),
    "a renewed lease must survive capacity eviction",
  );
  assert.ok(
    closes(otherLease).every((count) => count === 0),
    "each location has its own capacity",
  );
});

test("a re-arm that fs.watch refuses releases the lease instead of throwing", (t) => {
  const { root, registry, watches } = registryFor(t);
  t.mock.method(console, "error", () => undefined);
  const file = join(root, "notes.txt");
  writeFileSync(file, "before");
  const lease = opened(t, watches, () => registry.watch(root, file, file));
  const watcher = watches.mock.calls[0]?.result;
  assert.ok(watcher);
  // A replacement the watch cannot open, e.g. a mode-000 file renamed over it.
  watches.mock.mockImplementationOnce(() => {
    throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
  }, watches.mock.callCount());

  assert.doesNotThrow(() => watcher.emit("change", "rename", "notes.txt"));

  assert.ok(
    closes(lease).every((count) => count === 1),
    "the refused lease must be released",
  );
  assert.ok(opened(t, watches, () => registry.watch(root, file, file)).length > 0, "a new POST starts a fresh lease");
});

test("a file deleted under a coalesced change event keeps its lease and is reported when it returns", (t) => {
  const root = mkdtempSync(join(tmpdir(), "antechamber-watch-"));
  const events: Array<{ file: string; event: string }> = [];
  const registry = new FileWatchRegistry((_directory, event) => {
    if (event.type === "filesystem.changed") events.push(event.properties as { file: string; event: string });
  });
  const watches = t.mock.method(fs, "watch");
  syncBuiltinESMExports();
  t.mock.timers.enable({ apis: ["setInterval"] });
  t.after(() => {
    registry.close();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  });
  const file = join(root, "notes.txt");
  writeFileSync(file, "before");
  registry.watch(root, file, file);
  const watcher = watches.mock.calls[0]?.result;
  assert.ok(watcher);
  const close = t.mock.method(watcher, "close");

  // macOS can report a write and a delete arriving together as a single "change".
  unlinkSync(file);
  watcher.emit("change", "change", "notes.txt");
  assert.deepEqual(events.at(-1), { file, event: "unlink" });
  assert.equal(close.mock.callCount(), 1, "the dead native watch is closed");

  writeFileSync(file, "recreated");
  t.mock.timers.tick(1000);

  assert.deepEqual(events.at(-1), { file, event: "change" });
  assert.equal(watches.mock.callCount(), 2, "the recreated file is watched again");
});
