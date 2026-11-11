/**
 * bun contrib/registry-benchmark.ts [registry.json]
 * Copies the supplied legacy registry, or generates 800 synthetic entries.
 * Never opens the default state directory. Import/startup is outside the timed batches.
 */
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, type SessionRegistryEntry } from "../src/session-store.js";

const root = mkdtempSync(join(tmpdir(), "antechamber-registry-bench-"));
try {
  const file = join(root, "sessions.json");
  if (process.argv[2] !== undefined) copyFileSync(process.argv[2], file);
  else {
    const entries: Record<string, SessionRegistryEntry> = {};
    for (let i = 0; i < 800; i++) {
      entries[`ses_${i}`] = {
        piSessionId: `child-${i}`,
        piPath: "/synthetic/child.jsonl",
        directory: "/synthetic",
        parentID: "ses_parent",
        task: {
          id: `st_${i}`,
          parentPiId: "parent",
          input: { prompt: "p".repeat(12_000) },
          details: { status: "completed", final_response: "r".repeat(17_000) },
        },
        created: 1,
        updated: 2,
      };
    }
    writeFileSync(file, JSON.stringify(entries), { mode: 0o600 });
  }
  const sourceBytes = readFileSync(file).length;
  const store = new SessionStore(root);
  const ids = store.childIds();
  if (ids.length < 4) throw new Error("Registry must contain at least four child entries");
  const timings: number[] = [];
  for (let batch = 0; batch < 30; batch++) {
    const start = performance.now();
    store.batch(() => {
      for (let child = 0; child < 4; child++) {
        const id = ids[(batch * 4 + child) % ids.length];
        if (id === undefined) throw new Error("Missing benchmark child");
        store.update(id, { updated: batch + 3 });
      }
    });
    timings.push(performance.now() - start);
  }
  timings.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.versions.node}`,
      entries: ids.length,
      sourceBytes,
      batches: 30,
      childrenPerBatch: 4,
      p50Ms: Number(((timings[14]! + timings[15]!) / 2).toFixed(3)),
      maxMs: Number(timings[29]!.toFixed(3)),
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
