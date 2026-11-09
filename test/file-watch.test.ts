import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("B3 a repeated watch renews one lease for another 24 hours", (t) => {
  const { root, registry, watches } = registryFor(t);
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const file = join(root, "notes.txt");
  writeFileSync(file, "before");
  registry.watch(root, file, file);
  const watcher = watches.mock.calls[0]?.result;
  assert.ok(watcher);
  const close = t.mock.method(watcher, "close");

  t.mock.timers.tick(12 * 60 * 60 * 1000);
  registry.watch(root, file, file);
  t.mock.timers.tick(12 * 60 * 60 * 1000);
  assert.equal(watches.mock.callCount(), 1, "renewal must reuse the native watcher");
  assert.equal(close.mock.callCount(), 0, "the original expiry must not close a renewed lease");
  t.mock.timers.tick(12 * 60 * 60 * 1000);
  assert.equal(close.mock.callCount(), 1, "the renewed lease must expire 24 hours after renewal");
});

test("B3 an abandoned file lease expires and closes its native watcher", (t) => {
  const { root, registry, watches } = registryFor(t);
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const file = join(root, "notes.txt");
  writeFileSync(file, "before");
  registry.watch(root, file, file);
  const watcher = watches.mock.calls[0]?.result;
  assert.ok(watcher);
  const close = t.mock.method(watcher, "close");

  t.mock.timers.tick(24 * 60 * 60 * 1000 - 1);
  assert.equal(close.mock.callCount(), 0);
  t.mock.timers.tick(1);
  assert.equal(close.mock.callCount(), 1, "expiry must close the watcher without any further access");
  registry.watch(root, file, file);
  assert.equal(watches.mock.callCount(), 2, "expiry must also forget the registration");
});

test("B3 a full location evicts its soonest expiring lease without evicting another location", (t) => {
  const { root, registry, watches } = registryFor(t);
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const other = join(root, "other");
  mkdirSync(other);
  const otherFile = join(other, "notes.txt");
  writeFileSync(otherFile, "");
  registry.watch(other, otherFile, otherFile);
  const otherWatcher = watches.mock.calls[0]?.result;
  assert.ok(otherWatcher);
  const closeOther = t.mock.method(otherWatcher, "close");
  for (let i = 0; i < 256; i++) {
    const file = join(root, `${i}.txt`);
    writeFileSync(file, "");
    registry.watch(root, file, file);
  }
  const first = watches.mock.calls[1]?.result;
  const second = watches.mock.calls[2]?.result;
  assert.ok(first);
  assert.ok(second);
  const closeFirst = t.mock.method(first, "close");
  const closeSecond = t.mock.method(second, "close");
  t.mock.timers.tick(1);
  registry.watch(root, join(root, "0.txt"), join(root, "0.txt"));
  const extra = join(root, "256.txt");
  writeFileSync(extra, "");

  registry.watch(root, extra, extra);

  assert.equal(closeSecond.mock.callCount(), 1, "the soonest expiring lease must make room at 256");
  assert.equal(closeFirst.mock.callCount(), 0, "a renewed lease must survive capacity eviction");
  assert.equal(closeOther.mock.callCount(), 0, "each location has its own capacity");
});
