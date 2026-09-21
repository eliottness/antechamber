/**
 * Durable session registry + pi session-file discovery.
 *
 * pi already persists every session as JSONL under
 * `~/.pi/agent/sessions/--<cwd with / \ : replaced by ->--/<ts>_<id>.jsonl`,
 * so the adapter never needs its own transcript store — only:
 *
 *   1. a scan of that directory to rebuild the sidebar after a restart, and
 *   2. a small registry JSON for adapter-owned metadata that pi does not
 *      keep (the OpenChamber title override from `rename`).
 *
 * OpenChamber session ids for restored sessions are derived deterministically
 * (`ses_` + md5 of the pi session id) so the same pi session always maps to
 * the same OpenChamber id, even if the registry file is lost.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** pi's session directory for a given cwd (see pi docs/session-format.md). */
export function piSessionDir(cwd: string): string {
  const sanitized = cwd.replace(/^[/\\]+/, "").replace(/[\\/:\u0000]/g, "-");
  return join(homedir(), ".pi", "agent", "sessions", `--${sanitized}--`);
}

/** Deterministic OpenChamber session id for a pi session id. */
export function ocIdFor(piSessionId: string): string {
  return `ses_${createHash("md5").update(piSessionId).digest("hex")}`;
}

/** One *.jsonl discovered on disk, not (yet) backed by a live pi process. */
export interface ScannedSession {
  piSessionId: string;
  piPath: string;
  directory: string;
  title: string;
  created: number;
  updated: number;
}

/** Adapter-owned metadata that pi's files do not carry. */
export interface SessionRegistryEntry {
  piSessionId: string;
  piPath: string;
  directory: string;
  title?: string;
  created: number;
  updated: number;
}

/** Read at most this many leading bytes when sniffing headers/titles. */
const SNIFF_BYTES = 256 * 1024;
const TITLE_MAX_LINES = 200;

function readHead(path: string, bytes = SNIFF_BYTES): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(Math.min(bytes, Math.max(statSync(path).size, 1)));
    const read = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

interface SessionHeader {
  type?: string;
  id?: unknown;
  timestamp?: unknown;
  cwd?: unknown;
}

/** First user text within the head of the file — used as the sidebar title. */
function titleFromHead(head: string, piSessionId: string): string {
  const lines = head.split("\n").slice(0, TITLE_MAX_LINES);
  for (const line of lines) {
    if (line.length === 0) continue;
    let entry: { type?: string; message?: { role?: string; content?: Array<{ type?: string; text?: string }> } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue; // partial trailing line or corrupt entry — keep scanning
    }
    if (entry.type !== "message" || entry.message?.role !== "user") continue;
    const text = (entry.message.content ?? [])
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n")
      .trim();
    if (text !== "") return text.slice(0, 60);
  }
  return `pi session ${piSessionId.slice(0, 8)}`;
}

function scanOne(piPath: string, directory: string): ScannedSession | undefined {
  const head = readHead(piPath);
  const firstLine = head.split("\n", 1)[0] ?? "";
  let header: SessionHeader;
  try {
    header = JSON.parse(firstLine) as SessionHeader;
  } catch {
    return undefined; // not a session file we can trust
  }
  if (header.type !== "session") return undefined;
  if (typeof header.id !== "string" || header.id === "") return undefined;
  // The directory-name sanitization is lossy; the header cwd is authoritative.
  if (typeof header.cwd === "string" && header.cwd !== directory) return undefined;
  const created = typeof header.timestamp === "string" ? Date.parse(header.timestamp) : NaN;
  let updated = created;
  try {
    updated = statSync(piPath).mtimeMs;
  } catch {
    /* fall back to created */
  }
  return {
    piSessionId: header.id,
    piPath,
    directory,
    title: titleFromHead(head, header.id),
    created: Number.isNaN(created) ? Math.floor(updated) : created,
    updated: Math.floor(updated),
  };
}

/** All restorable pi sessions recorded for `directory`. Corrupt files are skipped. */
export function scanPiSessions(directory: string): ScannedSession[] {
  const dir = piSessionDir(directory);
  if (!existsSync(dir)) return [];
  const out: ScannedSession[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    try {
      const scanned = scanOne(join(dir, name), directory);
      if (scanned !== undefined) out.push(scanned);
    } catch {
      /* unreadable file — skip it, never take the server down */
    }
  }
  out.sort((a, b) => b.updated - a.updated);
  return out;
}

/**
 * Persistent oc-session-id → metadata registry (title overrides, known pi
 * paths). Atomic writes, lazy load, corrupt file degrades to an empty map.
 */
export class SessionStore {
  private readonly file: string;
  private entries: Map<string, SessionRegistryEntry> | undefined;

  constructor(stateDir?: string) {
    const dir = stateDir ?? process.env.OCPI_STATE_DIR ?? join(homedir(), ".config", "openchamber-pi-connector");
    this.file = join(dir, "sessions.json");
  }

  private load(): Map<string, SessionRegistryEntry> {
    if (this.entries !== undefined) return this.entries;
    this.entries = new Map();
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, SessionRegistryEntry>;
      for (const [k, v] of Object.entries(raw)) {
        if (v && typeof v.piPath === "string" && typeof v.piSessionId === "string") this.entries.set(k, v);
      }
    } catch {
      /* missing or corrupt — start empty */
    }
    return this.entries;
  }

  private persist(): void {
    const obj = Object.fromEntries(this.load());
    try {
      mkdirSync(join(this.file, ".."), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(obj, null, 2));
      renameSync(tmp, this.file);
    } catch {
      /* best-effort: titles are cosmetic, session scan is the source of truth */
    }
  }

  get(ocSessionId: string): SessionRegistryEntry | undefined {
    return this.load().get(ocSessionId);
  }

  set(ocSessionId: string, entry: SessionRegistryEntry): void {
    this.load().set(ocSessionId, entry);
    this.persist();
  }

  /** Merge a partial update (e.g. title override, updated timestamp). */
  update(ocSessionId: string, patch: Partial<SessionRegistryEntry>): void {
    const map = this.load();
    const prev = map.get(ocSessionId);
    if (prev === undefined) return;
    map.set(ocSessionId, { ...prev, ...patch });
    this.persist();
  }

  remove(ocSessionId: string): void {
    if (this.load().delete(ocSessionId)) this.persist();
  }

  /** Every directory the registry knows about — used to resolve bare session ids. */
  directories(): string[] {
    return [...new Set([...this.load().values()].map((e) => e.directory))];
  }
}
