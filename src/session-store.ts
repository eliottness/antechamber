/**
 * Durable session registry + pi session-file discovery.
 *
 * pi already persists every session as JSONL under
 * `<agent dir>/sessions/--<cwd with / \ : replaced by ->--/<ts>_<id>.jsonl`,
 * so the adapter never needs its own transcript store — only:
 *
 *   1. a scan of that directory to rebuild the sidebar after a restart, and
 *   2. a small registry JSON for adapter-owned metadata that pi does not
 *      keep (titles, conversation cursors and child-task metadata).
 *
 * OpenChamber session ids for restored sessions are derived deterministically
 * (`ses_` + md5 of the pi session id) so the same pi session always maps to
 * the same OpenChamber id, even if the registry file is lost.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { piAgentDir } from "./agent-dir.js";
import type { SessionTreeState } from "./session-tree.js";
import { isPromptPart } from "./prompt-parts.js";
import type { ChildTask } from "./subagents.js";
import { defaultStateDir, envSetting } from "./config.js";

/** pi's session directory for a given cwd (see pi docs/session-format.md). */
export function piSessionDir(cwd: string): string {
  const sanitized = cwd.replace(/^[/\\]+/, "").replace(/[\\/:\u0000]/g, "-");
  return join(piSessionsRoot(), `--${sanitized}--`);
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
  titleSource?: TitleSource;
  fallbackTitle?: string;
  created: number;
  updated: number;
}

export type TitleSource = "user" | "native" | "fallback" | "generated";

/** Adapter-owned metadata that pi's files do not carry. */
export interface SessionRegistryEntry {
  /** Created by this connector, rather than discovered from another OmO client. */
  connectorOwned?: true;
  tree?: SessionTreeState;
  parentID?: string | undefined;
  parentMessageID?: string;
  agent?: string;
  metadata?: Record<string, unknown>;
  task?: ChildTask;
  piSessionId: string;
  piPath: string;
  directory: string;
  title?: string;
  titleSource?: TitleSource;
  /** Archive timestamp (absent/0 = live) — OpenChamber's archive toggle. */
  archived?: number;
  /**
   * Last model pi was known to run. pi's JSONL header does not carry it, so
   * without this a dormant session would advertise no model at all until it is
   * revived — and the UI picker would fall back to its own default.
   */
  model?: { providerID: string; modelID: string; variant?: string };
  created: number;
  updated: number;
}

export class SessionPersistenceError extends Error {
  constructor(file: string, cause: unknown) {
    super(`Failed to persist session registry ${file}: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
    this.name = "SessionPersistenceError";
  }
}

/** Read at most this many leading bytes when sniffing headers/titles. */
const SNIFF_BYTES = 256 * 1024;
const TITLE_MAX_LINES = 200;
const TITLE_MAX_CHARS = 60;
const REGISTRY_DIRECTORY_MODE = 0o700;
const REGISTRY_FILE_MODE = 0o600;
const REGISTRY_LOCK_RETRY_MS = 10;
const REGISTRY_LOCK_STALE_MS = 5_000;
const registryLockWaiter = new Int32Array(new SharedArrayBuffer(4));

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
    if (text !== "") return text.slice(0, TITLE_MAX_CHARS);
  }
  return `pi session ${piSessionId.slice(0, 8)}`;
}

const titleCache = new Map<
  string,
  { mtimeMs: number; size: number; title: string; fallbackTitle: string; titleSource: TitleSource }
>();

/** Native renames append anywhere in the transcript; directory mtimes do not change. */
export function readSessionTitle(
  piPath: string,
  piSessionId: string,
): { title: string; fallbackTitle: string; titleSource: TitleSource } {
  const stat = statSync(piPath);
  const cached = titleCache.get(piPath);
  if (cached?.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached;
  const raw = readFileSync(piPath, "utf8");
  const fallbackTitle = titleFromHead(raw, piSessionId);
  let native: string | undefined;
  for (const line of raw.split("\n")) {
    try {
      const entry = JSON.parse(line);
      if (entry?.type === "session_info" && typeof entry.name === "string") {
        const name = entry.name.trim().replace(/\s+/g, " ");
        if (name !== "") native = name;
      }
    } catch {
      // Partial trailing writes do not erase the last valid title.
    }
  }
  const metadata = {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    title: native ?? fallbackTitle,
    fallbackTitle,
    titleSource: native === undefined ? ("fallback" as const) : ("native" as const),
  };
  titleCache.set(piPath, metadata);
  return metadata;
}

function parseSessionHeader(head: string): SessionHeader | undefined {
  const firstLine = head.split("\n", 1)[0] ?? "";
  let header: SessionHeader;
  try {
    header = JSON.parse(firstLine) as SessionHeader;
  } catch {
    return undefined; // not a session file we can trust
  }
  if (header.type !== "session") return undefined;
  if (typeof header.id !== "string" || header.id === "") return undefined;
  return header;
}

function buildScanned(piPath: string, directory: string, header: SessionHeader): ScannedSession {
  const piSessionId = header.id as string;
  const created = typeof header.timestamp === "string" ? Date.parse(header.timestamp) : NaN;
  let updated = created;
  try {
    updated = statSync(piPath).mtimeMs;
  } catch {
    /* fall back to created */
  }
  return {
    piSessionId,
    piPath,
    directory,
    ...readSessionTitle(piPath, piSessionId),
    created: Number.isNaN(created) ? Math.floor(updated) : created,
    updated: Math.floor(updated),
  };
}

function scanOne(piPath: string, directory: string): ScannedSession | undefined {
  const head = readHead(piPath);
  const header = parseSessionHeader(head);
  if (header === undefined) return undefined;
  // The directory-name sanitization is lossy; the header cwd is authoritative.
  if (typeof header.cwd === "string" && header.cwd !== directory) return undefined;
  return buildScanned(piPath, directory, header);
}

/** Like scanOne, but the true cwd comes from the file header (global enumeration). */
function scanOneAnyDirectory(piPath: string): ScannedSession | undefined {
  const head = readHead(piPath);
  const header = parseSessionHeader(head);
  if (header === undefined) return undefined;
  if (typeof header.cwd !== "string" || header.cwd === "") return undefined;
  return buildScanned(piPath, header.cwd, header);
}

/** Root of pi's session storage: one subdirectory per cwd. */
function piSessionsRoot(): string {
  return join(piAgentDir(), "sessions");
}

/**
 * Newest mtime across the sessions root and its per-cwd subdirectories. Cache
 * key for {@link scanAllPiSessions}: a new session file bumps its own cwd
 * subdirectory, not the root, so the root alone is not enough.
 */
export function piSessionsRootMtime(): number | undefined {
  const root = piSessionsRoot();
  let newest: number;
  try {
    newest = statSync(root).mtimeMs;
  } catch {
    return undefined; // no sessions recorded yet
  }
  try {
    for (const name of readdirSync(root)) {
      try {
        newest = Math.max(newest, statSync(join(root, name)).mtimeMs);
      } catch {
        /* entry vanished mid-scan — keep the previous max */
      }
    }
  } catch {
    /* unreadable root listing — the root mtime still gives us a cache key */
  }
  return newest;
}

/**
 * Every restorable pi session on disk, regardless of directory. Used for the
 * global (directory-less) session list. A file is only trusted when its
 * header carries an authoritative `cwd`, since the directory-name
 * sanitization is lossy and cannot be reversed.
 */
export function scanAllPiSessions(): ScannedSession[] {
  const root = piSessionsRoot();
  if (!existsSync(root)) return [];
  const out: ScannedSession[] = [];
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return [];
  }
  for (const dirName of dirs) {
    let names: string[];
    try {
      names = readdirSync(join(root, dirName));
    } catch {
      continue; // not a directory we can read
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      try {
        const scanned = scanOneAnyDirectory(join(root, dirName, name));
        if (scanned !== undefined) out.push(scanned);
      } catch {
        /* unreadable file — skip it, never take the server down */
      }
    }
  }
  out.sort((a, b) => b.updated - a.updated);
  return out;
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
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringRecord(value: unknown): value is Record<string, string> {
  return record(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function booleanRecord(value: unknown): value is Record<string, boolean> {
  return record(value) && Object.values(value).every((entry) => typeof entry === "boolean");
}

function persistedMessage(value: unknown): boolean {
  return (
    record(value) &&
    record(value.info) &&
    typeof value.info.id === "string" &&
    typeof value.info.role === "string" &&
    Array.isArray(value.parts)
  );
}

function sessionTreeState(value: unknown): value is SessionTreeState {
  if (!record(value) || !stringRecord(value.messageEntries)) return false;
  if (
    value.promptParts !== undefined &&
    (!record(value.promptParts) ||
      !Object.values(value.promptParts).every((parts) => Array.isArray(parts) && parts.every(isPromptPart)))
  )
    return false;
  if (
    value.promptMetadata !== undefined &&
    (!record(value.promptMetadata) || !Object.values(value.promptMetadata).every((metadata) => record(metadata)))
  )
    return false;
  if (
    value.messageParts !== undefined &&
    (!record(value.messageParts) ||
      !Object.values(value.messageParts).every(
        (parts) => Array.isArray(parts) && parts.every((part) => typeof part === "string"),
      ))
  )
    return false;
  if (value.shellDispatch !== undefined && !booleanRecord(value.shellDispatch)) return false;
  if (value.leafId !== undefined && value.leafId !== null && typeof value.leafId !== "string") return false;
  if (value.revert !== undefined) {
    if (
      !record(value.revert) ||
      typeof value.revert.messageID !== "string" ||
      (value.revert.previousLeafId !== null && typeof value.revert.previousLeafId !== "string") ||
      (value.revert.targetId !== null && typeof value.revert.targetId !== "string")
    )
      return false;
  }
  return (
    value.localShellTurns === undefined ||
    (Array.isArray(value.localShellTurns) &&
      value.localShellTurns.every(
        (turn) =>
          record(turn) &&
          (turn.afterEntryId === null || typeof turn.afterEntryId === "string") &&
          Array.isArray(turn.messages) &&
          turn.messages.length === 2 &&
          persistedMessage(turn.messages[0]) &&
          persistedMessage(turn.messages[1]),
      ))
  );
}

function childTask(value: unknown): value is ChildTask {
  return (
    record(value) &&
    typeof value.id === "string" &&
    typeof value.parentPiId === "string" &&
    record(value.input) &&
    record(value.details) &&
    (value.terminalAt === undefined || (typeof value.terminalAt === "number" && Number.isFinite(value.terminalAt)))
  );
}

function titleSource(value: unknown): value is TitleSource {
  return value === "user" || value === "native" || value === "fallback" || value === "generated";
}

function registryEntry(value: unknown): value is SessionRegistryEntry {
  if (
    !record(value) ||
    typeof value.piPath !== "string" ||
    typeof value.piSessionId !== "string" ||
    typeof value.directory !== "string" ||
    typeof value.created !== "number" ||
    !Number.isFinite(value.created) ||
    typeof value.updated !== "number" ||
    !Number.isFinite(value.updated)
  )
    return false;
  if (value.connectorOwned !== undefined && value.connectorOwned !== true) return false;
  if (value.tree !== undefined && !sessionTreeState(value.tree)) return false;
  if (value.parentID !== undefined && typeof value.parentID !== "string") return false;
  if (value.parentMessageID !== undefined && typeof value.parentMessageID !== "string") return false;
  if (value.agent !== undefined && typeof value.agent !== "string") return false;
  if (value.metadata !== undefined && !record(value.metadata)) return false;
  if (value.task !== undefined && !childTask(value.task)) return false;
  if (value.title !== undefined && typeof value.title !== "string") return false;
  if (value.titleSource !== undefined && !titleSource(value.titleSource)) return false;
  if (value.archived !== undefined && (typeof value.archived !== "number" || !Number.isFinite(value.archived)))
    return false;
  if (
    value.model !== undefined &&
    (!record(value.model) || typeof value.model.providerID !== "string" || typeof value.model.modelID !== "string")
  )
    return false;
  return true;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String(error.code) : undefined;
}

export class SessionStore {
  readonly stateDir: string;
  private readonly file: string;
  private entries: Map<string, SessionRegistryEntry> | undefined;

  constructor(stateDir?: string) {
    const dir = stateDir ?? envSetting("STATE_DIR") ?? defaultStateDir();
    this.stateDir = dir;
    this.file = join(dir, "sessions.json");
  }

  private load(): Map<string, SessionRegistryEntry> {
    if (this.entries !== undefined) return this.entries;
    this.entries = this.readEntries();
    return this.entries;
  }

  private readEntries(): Map<string, SessionRegistryEntry> {
    const entries = new Map<string, SessionRegistryEntry>();
    try {
      const raw: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      if (!record(raw)) return entries;
      for (const [id, value] of Object.entries(raw)) if (registryEntry(value)) entries.set(id, value);
    } catch {
      /* missing or corrupt — start empty */
    }
    return entries;
  }

  private withRegistryLock<T>(action: () => T): T {
    const lock = `${this.file}.lock`;
    let fd: number | undefined;
    try {
      mkdirSync(this.stateDir, { recursive: true, mode: REGISTRY_DIRECTORY_MODE });
      chmodSync(this.stateDir, REGISTRY_DIRECTORY_MODE);
      for (;;) {
        try {
          fd = openSync(lock, "wx", REGISTRY_FILE_MODE);
          break;
        } catch (error) {
          if (errorCode(error) !== "EEXIST") throw error;
          try {
            if (Date.now() - statSync(lock).mtimeMs >= REGISTRY_LOCK_STALE_MS) {
              unlinkSync(lock);
              continue;
            }
          } catch (staleLockError) {
            if (errorCode(staleLockError) !== "ENOENT") throw staleLockError;
            continue;
          }
          Atomics.wait(registryLockWaiter, 0, 0, REGISTRY_LOCK_RETRY_MS);
        }
      }
      return action();
    } catch (error) {
      throw new SessionPersistenceError(this.file, error);
    } finally {
      if (fd !== undefined) {
        closeSync(fd);
        unlinkSync(lock);
      }
    }
  }

  private persist(entries: Map<string, SessionRegistryEntry>): void {
    const obj = Object.fromEntries(entries);
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: REGISTRY_FILE_MODE });
    chmodSync(tmp, REGISTRY_FILE_MODE);
    renameSync(tmp, this.file);
  }

  private mutate(change: (entries: Map<string, SessionRegistryEntry>) => boolean): void {
    this.withRegistryLock(() => {
      const entries = this.readEntries();
      if (change(entries)) this.persist(entries);
      this.entries = entries;
    });
  }

  get(ocSessionId: string): SessionRegistryEntry | undefined {
    return this.load().get(ocSessionId);
  }

  idFor(piSessionId: string): string | undefined {
    return [...this.load()].find(([, entry]) => entry.piSessionId === piSessionId)?.[0];
  }

  childIds(): string[] {
    return [...this.load()]
      .filter(([, entry]) => entry.task !== undefined && entry.parentID !== undefined)
      .map(([id]) => id);
  }

  set(ocSessionId: string, entry: SessionRegistryEntry): void {
    this.mutate((entries) => {
      entries.set(ocSessionId, entry);
      return true;
    });
  }

  /** Merge a partial update (e.g. title override, updated timestamp). */
  update(ocSessionId: string, patch: Partial<SessionRegistryEntry>): void {
    this.mutate((entries) => {
      const previous = entries.get(ocSessionId);
      if (previous === undefined) return false;
      entries.set(ocSessionId, { ...previous, ...patch });
      return true;
    });
  }

  remove(ocSessionId: string): void {
    this.mutate((entries) => entries.delete(ocSessionId));
  }

  /** Every directory the registry knows about — used to resolve bare session ids. */
  directories(): string[] {
    return [...new Set([...this.load().values()].map((e) => e.directory))];
  }
}
