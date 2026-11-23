/**
 * bun contrib/history-benchmark.ts <session.jsonl>...
 * Rebuilds OpenCode history from pi JSONL files the way a dormant session's first /message read does.
 * Read-only: each file is read once, outside the timed runs.
 */
import { readFileSync } from "node:fs";
import { parsePiSessionText } from "../src/session-history.js";
import type { ManagedSession } from "../src/sessions.js";

const files = process.argv.slice(2);
if (files.length === 0) throw new Error("Usage: bun contrib/history-benchmark.ts <session.jsonl>...");
const runs = Number(process.env.HISTORY_BENCH_RUNS ?? 5);

function dormant(id: string): ManagedSession {
  return {
    info: {
      id,
      projectID: "/bench",
      directory: "/bench",
      title: "bench",
      version: "bench",
      time: { created: 0, updated: 0 },
    },
    pi: undefined,
    model: undefined,
    streaming: undefined,
    status: { type: "idle" },
    messages: undefined,
    toolByCallId: new Map(),
    tree: { messageEntries: {} },
    hasPendingInteraction: () => false,
    hasRunningChildren: () => false,
  };
}

for (const [index, file] of files.entries()) {
  const raw = readFileSync(file, "utf8");
  const timings: number[] = [];
  let messages = 0;
  for (let run = 0; run < runs; run++) {
    const start = performance.now();
    messages = parsePiSessionText(dormant(`ses_bench_${index}`), "OmO", raw).length;
    timings.push(performance.now() - start);
  }
  timings.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.versions.node}`,
      bytes: Buffer.byteLength(raw),
      lines: raw.split("\n").length,
      messages,
      runs,
      p50Ms: Number(timings[Math.floor(runs / 2)]!.toFixed(1)),
      minMs: Number(timings[0]!.toFixed(1)),
    }),
  );
}
