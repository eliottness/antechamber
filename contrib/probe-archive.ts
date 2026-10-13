/**
 * Archive round-trip probe — no LLM turns, no OpenChamber required.
 *
 * Exercises exactly the OpenChamber archive flow against the HTTP surface:
 *
 *   create → PATCH { time: { archived: now } } → archived=true/false list
 *   filters → title must survive an archive-only PATCH → unarchive →
 *   restart → archived state must survive via the registry + pi JSONL scan.
 *
 *   npx tsx contrib/probe-archive.ts
 *   ANTECHAMBER_PI_BINARY=/path/to/pi npx tsx contrib/probe-archive.ts
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterServer } from "../src/server.js";
import { piSessionDir } from "../src/session-store.js";
import type { OCSession } from "../src/types.js";

const WORKSPACE = mkdtempSync(join(tmpdir(), "antechamber-archive-"));
const STATE_DIR = join(WORKSPACE, "state");
process.env.ANTECHAMBER_STATE_DIR = STATE_DIR;

let failures = 0;
let checks = 0;

function ok(name: string, cond: boolean, detail = ""): void {
  checks++;
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failures++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function api<T>(url: string, path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${url}${path}`, init);
  const text = await res.text();
  let body: T;
  try {
    body = text === "" ? (undefined as T) : (JSON.parse(text) as T);
  } catch {
    body = text as unknown as T;
  }
  return { status: res.status, body };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function startServer(): Promise<AdapterServer> {
  const server = new AdapterServer({ port: 0, host: "127.0.0.1", defaultDirectory: WORKSPACE });
  await server.start();
  return server;
}

/** Wait until the registry file knows the session (piPath bound, meta persisted). */
async function waitForRegistry(sessionId: string): Promise<boolean> {
  const file = join(STATE_DIR, "sessions.json");
  for (let i = 0; i < 40; i++) {
    try {
      if (existsSync(file) && readFileSync(file, "utf8").includes(`"${sessionId}"`)) return true;
    } catch {
      /* mid-write — retry */
    }
    await sleep(200);
  }
  return false;
}

async function main(): Promise<void> {
  console.log(`workspace: ${WORKSPACE}`);
  const server = await startServer();
  const url = server.url;
  console.log(`adapter: ${url}`);

  // 1. create a session (spawns pi --mode rpc; no prompt, no LLM turn)
  const created = await api<OCSession>(url, "/session", { method: "POST", body: JSON.stringify({}) });
  ok("POST /session", created.status === 200 && typeof created.body.id === "string");
  const sessionId = created.body.id;

  const bound = await waitForRegistry(sessionId);
  ok("registry entry bound (piPath persisted)", bound);

  const live0 = await api<OCSession[]>(
    url,
    `/experimental/session?directory=${encodeURIComponent(WORKSPACE)}&archived=false`,
  );
  ok(
    "new session in archived=false list",
    live0.body.some((s) => s.id === sessionId),
  );

  // 2. archive it the way OpenChamber does (SDK v2 session.update)
  const archivedAt = Date.now();
  const archived = await api<OCSession>(url, `/session/${sessionId}`, {
    method: "PATCH",
    body: JSON.stringify({ time: { archived: archivedAt } }),
  });
  ok(
    "PATCH archive returns time.archived",
    archived.status === 200 && archived.body.time.archived === archivedAt,
    JSON.stringify(archived.body.time),
  );
  ok("archive-only PATCH preserves title", archived.body.title === "New session", JSON.stringify(archived.body.title));

  const archList = await api<OCSession[]>(
    url,
    `/experimental/session?directory=${encodeURIComponent(WORKSPACE)}&archived=true`,
  );
  ok(
    "archived session in archived=true list",
    archList.body.some((s) => s.id === sessionId && s.time.archived === archivedAt),
  );
  const liveList = await api<OCSession[]>(
    url,
    `/experimental/session?directory=${encodeURIComponent(WORKSPACE)}&archived=false`,
  );
  ok("archived session gone from archived=false list", !liveList.body.some((s) => s.id === sessionId));

  // 3. unarchive (OpenChamber sends 0)
  const unarchived = await api<OCSession>(url, `/session/${sessionId}`, {
    method: "PATCH",
    body: JSON.stringify({ time: { archived: 0 } }),
  });
  ok(
    "PATCH unarchive clears time.archived",
    unarchived.status === 200 && unarchived.body.time.archived === undefined,
    JSON.stringify(unarchived.body.time),
  );
  const liveAgain = await api<OCSession[]>(
    url,
    `/experimental/session?directory=${encodeURIComponent(WORKSPACE)}&archived=false`,
  );
  ok(
    "unarchived session back in live list",
    liveAgain.body.some((s) => s.id === sessionId),
  );

  // 4. re-archive, restart the adapter — state must survive.
  //    pi persists lazily (no JSONL until the first prompt), so a promptless
  //    probe session has nothing on disk to scan. Fabricate the session file
  //    header exactly the way pi writes it — the restore path (scan + registry
  //    merge) is what's under test here, not pi's writer.
  const archivedAt2 = Date.now();
  await api<OCSession>(url, `/session/${sessionId}`, {
    method: "PATCH",
    body: JSON.stringify({ time: { archived: archivedAt2 } }),
  });
  const reg = JSON.parse(readFileSync(join(STATE_DIR, "sessions.json"), "utf8")) as Record<
    string,
    { piSessionId: string }
  >;
  const piSessionId = reg[sessionId]!.piSessionId;
  const piDir = piSessionDir(WORKSPACE);
  const piFile = join(piDir, `${Date.now()}_${piSessionId}.jsonl`);
  mkdirSync(piDir, { recursive: true });
  writeFileSync(
    piFile,
    `${JSON.stringify({ type: "session", id: piSessionId, timestamp: new Date().toISOString(), cwd: WORKSPACE })}\n`,
  );
  await server.stop();

  const server2 = await startServer();
  const url2 = server2.url;
  const afterRestart = await api<OCSession[]>(
    url2,
    `/experimental/session?directory=${encodeURIComponent(WORKSPACE)}&archived=true`,
  );
  ok(
    "archived state survives adapter restart",
    afterRestart.body.some((s) => s.id === sessionId && s.time.archived === archivedAt2),
    JSON.stringify(afterRestart.body).slice(0, 200),
  );

  // 5. cleanup (DELETE removes the pi session file + registry entry)
  const deleted = await api<unknown>(url2, `/session/${sessionId}`, { method: "DELETE" });
  ok("DELETE session", deleted.status === 200);
  await server2.stop();

  console.log(`\n${checks - failures}/${checks} checks passed`);
  rmSync(WORKSPACE, { recursive: true, force: true });
  try {
    rmSync(piSessionDir(WORKSPACE), { recursive: true, force: true }); // fabricated pi file
  } catch {
    /* already gone */
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("probe failed:", err);
  rmSync(WORKSPACE, { recursive: true, force: true });
  process.exit(1);
});
