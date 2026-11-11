/**
 * Durable session registry + pi session-file discovery.
 *
 * pi already persists every session as JSONL under
 * `<agent dir>/sessions/--<cwd with / \ : replaced by ->--/<ts>_<id>.jsonl`,
 * so the adapter never needs its own transcript store — only:
 *
 *   1. a scan of that directory to rebuild the sidebar after a restart, and
 *   2. a SQLite registry for adapter-owned metadata that pi does not
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
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
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

/** The model and thinking level OmO resumes a session file with. */
export interface SessionSelection {
  model?: { providerID: string; modelID: string };
  thinkingLevel?: string;
}

/** One *.jsonl discovered on disk, not (yet) backed by a live pi process. */
export interface ScannedSession extends SessionSelection {
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

export interface InstructionEntryState {
  value: unknown;
  removed?: true;
}

/** Adapter-owned metadata that pi's files do not carry. */
export interface SessionRegistryEntry {
  /** Created by this connector, rather than discovered from another OmO client. */
  connectorOwned?: true;
  /** A child the user deleted; kept so its task record or parent history cannot list it again. */
  deleted?: true;
  tree?: SessionTreeState;
  parentID?: string | undefined;
  parentMessageID?: string;
  agent?: string;
  metadata?: Record<string, unknown>;
  instructions?: Record<string, InstructionEntryState>;
  task?: ChildTask;
  piSessionId: string;
  piPath: string;
  directory: string;
  title?: string;
  titleSource?: TitleSource;
  /** Archive timestamp (absent/0 = live) — OpenChamber's archive toggle. */
  archived?: number;
  /** Last idle watermark acknowledged by a viewer. */
  viewed?: number;
  /**
   * Last model pi was known to run. pi's JSONL header does not carry it, so
   * without this a dormant session would advertise no model at all until it is
   * revived — and the UI picker would fall back to its own default.
   */
  model?: { providerID: string; modelID: string; variant?: string };
  /** Why the agent last stopped on its own, shown again after a restart until the session runs again. */
  lastStop?: { message: string; at: number };
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
    let entry: {
      type?: string;
      message?: { role?: string; content?: string | Array<{ type?: string; text?: string }> };
    };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue; // partial trailing line or corrupt entry — keep scanning
    }
    if (entry.type !== "message" || entry.message?.role !== "user") continue;
    const content = entry.message.content ?? [];
    // pi allows plain-string message content (extensions, append_user_message).
    const text = (
      typeof content === "string"
        ? content
        : content
            .filter((b) => b?.type === "text" && typeof b.text === "string")
            .map((b) => b.text as string)
            .join("\n")
    ).trim();
    if (text !== "") return text.slice(0, TITLE_MAX_CHARS);
  }
  return `pi session ${piSessionId.slice(0, 8)}`;
}

interface SessionFileMeta extends SessionSelection {
  title: string;
  fallbackTitle: string;
  titleSource: TitleSource;
}

type ModelRef = { providerID: string; modelID: string };
type SelectionStep =
  | { kind: "thinking"; level: string | undefined }
  | { kind: "model"; reason: unknown; model: ModelRef | undefined; original: ModelRef | undefined }
  | { kind: "reply"; model: ModelRef };

function modelRef(provider: unknown, modelID: unknown): ModelRef | undefined {
  return typeof provider === "string" && provider !== "" && typeof modelID === "string" && modelID !== ""
    ? { providerID: provider, modelID }
    : undefined;
}

function selectionStep(entry: Record<string, unknown>): SelectionStep | undefined {
  if (entry.type === "thinking_level_change")
    return { kind: "thinking", level: typeof entry.thinkingLevel === "string" ? entry.thinkingLevel : undefined };
  if (entry.type === "model_change")
    return {
      kind: "model",
      reason: entry.reason,
      model: modelRef(entry.provider, entry.modelId),
      original: modelRef(entry.originalProvider, entry.originalModelId),
    };
  const message = entry.message as Record<string, unknown> | undefined;
  // A failed routing attempt names the virtual model; no model answered it.
  if (entry.type !== "message" || message?.role !== "assistant" || message.api === "pi-virtual") return undefined;
  const model = modelRef(message.provider, message.model);
  return model === undefined ? undefined : { kind: "reply", model };
}

/**
 * OmO resumes at the file's last entry and resolves the model and level along its path, restoring the
 * pre-fallback model and level across a fallback window. Mirrors senpi's getSessionContextSettings
 * (dist/core/session-manager.js), except that legacy provider ids are not normalized.
 */
function resumeSelection(
  byId: Map<string, { parentId: string | null; step?: SelectionStep }>,
  leafId: string | undefined,
): SessionSelection {
  const path: SelectionStep[] = [];
  const seen = new Set<string>();
  for (let id = leafId; id !== undefined && !seen.has(id); ) {
    const entry = byId.get(id);
    if (entry === undefined) break;
    seen.add(id);
    if (entry.step !== undefined) path.push(entry.step);
    id = entry.parentId ?? undefined;
  }
  let model: ModelRef | undefined;
  let explicit = false;
  let inFallback = false;
  let level: string | undefined;
  let preFallbackLevel: string | undefined;
  for (const step of path.reverse()) {
    if (step.kind === "thinking") level = step.level;
    else if (step.kind === "model" && step.reason === "fallback") {
      if (!inFallback) {
        preFallbackLevel = level;
        if (step.original !== undefined) {
          model = step.original;
          explicit = true;
        }
      }
      inFallback = true;
    } else if (step.kind === "model" && step.reason === "fallback-revert") {
      if (inFallback) level = preFallbackLevel;
      inFallback = false;
    } else if (step.kind === "model") {
      inFallback = false;
      if (step.model !== undefined) {
        model = step.model;
        explicit = true;
      }
    } else if (!inFallback && !(explicit && model?.providerID === step.model.providerID)) {
      // A reply echoes the wire id; only a reply from another provider overrides an explicit pick.
      model = step.model;
      explicit = false;
    }
  }
  if (inFallback) level = preFallbackLevel;
  return { ...(model !== undefined ? { model } : {}), ...(level !== undefined ? { thinkingLevel: level } : {}) };
}

const fileMetaCache = new Map<string, SessionFileMeta & { mtimeMs: number; size: number }>();

/** Native renames and model/thinking changes append anywhere in the transcript; directory mtimes do not change. */
export function readSessionFileMeta(piPath: string, piSessionId: string): SessionFileMeta {
  const stat = statSync(piPath);
  const cached = fileMetaCache.get(piPath);
  if (cached?.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached;
  const raw = readFileSync(piPath, "utf8");
  const fallbackTitle = titleFromHead(raw, piSessionId);
  let native: string | undefined;
  const byId = new Map<string, { parentId: string | null; step?: SelectionStep }>();
  let leafId: string | undefined;
  for (const line of raw.split("\n")) {
    try {
      const entry = JSON.parse(line);
      if (entry?.type === "session_info" && typeof entry.name === "string") {
        const name = entry.name.trim().replace(/\s+/g, " ");
        if (name !== "") native = name;
      }
      if (entry?.type !== "session" && typeof entry?.id === "string") {
        const step = selectionStep(entry);
        byId.set(entry.id, {
          parentId: typeof entry.parentId === "string" ? entry.parentId : null,
          ...(step !== undefined ? { step } : {}),
        });
        leafId = entry.id;
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
    ...resumeSelection(byId, leafId),
  };
  fileMetaCache.set(piPath, metadata);
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
    ...readSessionFileMeta(piPath, piSessionId),
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
 * paths). Legacy JSON records are validated at migration; SQLite writes are atomic.
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
  if (value.promptDescriptions !== undefined && !stringRecord(value.promptDescriptions)) return false;
  if (
    value.compactionReasons !== undefined &&
    (!stringRecord(value.compactionReasons) ||
      !Object.values(value.compactionReasons).every((reason) => reason === "manual" || reason === "auto"))
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
  const finite = (item: unknown) => typeof item === "number" && Number.isFinite(item);
  if (value.lastIdle !== undefined && !finite(value.lastIdle)) return false;
  if (
    value.compactionAdmissions !== undefined &&
    (!record(value.compactionAdmissions) || !Object.values(value.compactionAdmissions).every(finite))
  )
    return false;
  if (
    value.idleBoundaries !== undefined &&
    (!record(value.idleBoundaries) ||
      !Object.values(value.idleBoundaries).every(
        (boundary) =>
          record(boundary) &&
          finite(boundary.at) &&
          ["succeeded", "failed", "interrupted"].includes(boundary.outcome as string) &&
          (boundary.error === undefined || record(boundary.error)),
      ))
  )
    return false;
  if (value.leafId !== undefined && value.leafId !== null && typeof value.leafId !== "string") return false;
  if (value.fileSize !== undefined && (typeof value.fileSize !== "number" || !Number.isFinite(value.fileSize)))
    return false;
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
  if (value.deleted !== undefined && value.deleted !== true) return false;
  if (value.tree !== undefined && !sessionTreeState(value.tree)) return false;
  if (value.parentID !== undefined && typeof value.parentID !== "string") return false;
  if (value.parentMessageID !== undefined && typeof value.parentMessageID !== "string") return false;
  if (value.agent !== undefined && typeof value.agent !== "string") return false;
  if (value.metadata !== undefined && !record(value.metadata)) return false;
  if (
    value.instructions !== undefined &&
    (!record(value.instructions) ||
      !Object.entries(value.instructions).every(
        ([key, entry]) =>
          /^[a-z0-9][a-z0-9._-]*$/.test(key) &&
          record(entry) &&
          "value" in entry &&
          (entry.removed === undefined || entry.removed === true),
      ))
  )
    return false;
  if (value.task !== undefined && !childTask(value.task)) return false;
  if (value.title !== undefined && typeof value.title !== "string") return false;
  if (value.titleSource !== undefined && !titleSource(value.titleSource)) return false;
  if (value.archived !== undefined && (typeof value.archived !== "number" || !Number.isFinite(value.archived)))
    return false;
  if (value.viewed !== undefined && (typeof value.viewed !== "number" || !Number.isFinite(value.viewed))) return false;
  if (
    value.model !== undefined &&
    (!record(value.model) || typeof value.model.providerID !== "string" || typeof value.model.modelID !== "string")
  )
    return false;
  if (
    value.lastStop !== undefined &&
    (!record(value.lastStop) ||
      typeof value.lastStop.message !== "string" ||
      typeof value.lastStop.at !== "number" ||
      !Number.isFinite(value.lastStop.at))
  )
    return false;
  return true;
}

/**
 * OmO keeps a task's spawn spec in its own task record, which is where the adapter reads it
 * (adoption, eval-agent matching). The registry copy was never read back and made up about a third
 * of the file in sessions with hundreds of children.
 */
function persistedEntry(entry: SessionRegistryEntry): SessionRegistryEntry {
  if (entry.task === undefined || !("spawn_spec" in entry.task.details)) return entry;
  const { spawn_spec: _spec, ...details } = entry.task.details;
  return { ...entry, task: { ...entry.task, details } };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String(error.code) : undefined;
}

export class SessionStore {
  readonly stateDir: string;
  private readonly file: string;
  private db: DatabaseSync | undefined;
  private version: number | bigint | undefined;
  private readonly entries = new Map<string, SessionRegistryEntry>();
  private batchState:
    | {
        entries: Map<string, SessionRegistryEntry | undefined>;
        changes: Array<{
          id: string;
          apply: (previous: SessionRegistryEntry | undefined) => SessionRegistryEntry | undefined;
        }>;
      }
    | undefined;

  constructor(stateDir?: string) {
    const dir = stateDir ?? envSetting("STATE_DIR") ?? defaultStateDir();
    this.stateDir = dir;
    this.file = join(dir, "sessions.sqlite");
  }

  private database(write = false): DatabaseSync | undefined {
    if (this.db !== undefined) return this.db;
    const legacy = join(this.stateDir, "sessions.json");
    if (!write && !existsSync(this.file) && !existsSync(legacy)) return undefined;
    let db: DatabaseSync | undefined;
    try {
      mkdirSync(this.stateDir, { recursive: true, mode: REGISTRY_DIRECTORY_MODE });
      chmodSync(this.stateDir, REGISTRY_DIRECTORY_MODE);
      // SQLite inherits the database mode for WAL/SHM; set it before enabling WAL.
      closeSync(openSync(this.file, "a", REGISTRY_FILE_MODE));
      chmodSync(this.file, REGISTRY_FILE_MODE);
      db = new DatabaseSync(this.file);
      db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
      db.exec(`CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, payload TEXT NOT NULL, pi_session_id TEXT NOT NULL,
        directory TEXT NOT NULL, parent_id TEXT, has_task INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_pi ON sessions(pi_session_id);
      CREATE INDEX IF NOT EXISTS sessions_directory ON sessions(directory);
      CREATE INDEX IF NOT EXISTS sessions_children ON sessions(parent_id) WHERE has_task = 1;
      CREATE TABLE IF NOT EXISTS registry_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
      this.migrate(db, legacy);
      for (const suffix of ["-wal", "-shm"]) {
        const path = this.file + suffix;
        if (existsSync(path)) chmodSync(path, REGISTRY_FILE_MODE);
      }
      this.db = db;
      return db;
    } catch (error) {
      db?.close();
      throw new SessionPersistenceError(this.file, error);
    }
  }

  private migrate(db: DatabaseSync, legacy: string): void {
    const meta = (key: string) => db.prepare("SELECT value FROM registry_meta WHERE key = ?").get(key)?.value;
    const setMeta = (key: string, value: string) =>
      db
        .prepare("INSERT INTO registry_meta VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(key, value);
    db.prepare("INSERT OR IGNORE INTO registry_meta VALUES ('created_at', ?)").run(String(Date.now()));
    if (!existsSync(legacy)) return;
    db.exec("BEGIN IMMEDIATE");
    let backup: string | undefined;
    let merged = 0;
    try {
      const imported = meta("legacy_backup");
      const parse = (): Record<string, unknown> | undefined => {
        try {
          const parsed: unknown = JSON.parse(readFileSync(legacy, "utf8"));
          return record(parsed) ? parsed : undefined;
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          // Preserve malformed JSON untouched; a later repair can still be imported.
          return undefined;
        }
      };
      if (typeof imported === "string" && !existsSync(imported)) backup = imported;
      else if (imported === undefined && db.prepare("SELECT 1 FROM sessions LIMIT 1").get() === undefined) {
        const parsed = parse();
        if (parsed !== undefined) {
          const upsert = this.upsert(db);
          for (const [id, entry] of Object.entries(parsed)) if (registryEntry(entry)) this.writeRow(upsert, id, entry);
          backup = `${legacy}.migrated-${Date.now()}-${process.pid}`;
          setMeta("legacy_backup", backup);
          setMeta("reconciled_at", String(Date.now()));
        }
      } else {
        // A sessions.json next to a populated registry was written by an older antechamber after the migration (a
        // rollback). Sessions it changed since then are newer than the rows here; older entries, including ones
        // deleted since, stay as the registry has them.
        const since = Number(
          meta("reconciled_at") ?? /\.migrated-(\d+)-/.exec(String(imported))?.[1] ?? meta("created_at") ?? Infinity,
        );
        const parsed = parse();
        if (parsed !== undefined) {
          const upsert = this.upsert(db);
          for (const [id, entry] of Object.entries(parsed)) {
            if (!registryEntry(entry) || !(entry.updated > since)) continue;
            const current = this.read(db, id);
            if (current !== undefined && current.updated >= entry.updated) continue;
            this.writeRow(upsert, id, entry);
            merged += 1;
          }
          if (merged > 0) {
            backup = `${legacy}.merged-${Date.now()}-${process.pid}`;
            setMeta("reconciled_at", String(Date.now()));
          }
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    if (merged > 0) this.entries.clear();
    if (merged > 0) console.warn(`[session-store] merged ${merged} sessions an older antechamber wrote to ${legacy}`);
    // The durable marker handles a crash after COMMIT but before rename, including an empty import.
    // Never overwrite an existing backup or import the same legacy file after sessions are deleted.
    if (backup !== undefined && !existsSync(backup)) {
      try {
        chmodSync(legacy, REGISTRY_FILE_MODE);
        renameSync(legacy, backup);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
    }
  }

  private upsert(db: DatabaseSync) {
    return db.prepare(`INSERT INTO sessions (id, payload, pi_session_id, directory, parent_id, has_task)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
      payload=excluded.payload, pi_session_id=excluded.pi_session_id, directory=excluded.directory,
      parent_id=excluded.parent_id, has_task=excluded.has_task`);
  }

  private writeRow(statement: ReturnType<SessionStore["upsert"]>, id: string, entry: SessionRegistryEntry): void {
    statement.run(
      id,
      JSON.stringify(persistedEntry(entry)),
      entry.piSessionId,
      entry.directory,
      entry.parentID ?? null,
      entry.task === undefined ? 0 : 1,
    );
  }

  private refresh(db: DatabaseSync): void {
    const version = db.prepare("PRAGMA data_version").get()?.data_version;
    if (typeof version !== "number" && typeof version !== "bigint") throw new Error("Invalid SQLite data_version");
    if (this.version !== version) {
      this.entries.clear();
      this.version = version;
    }
  }

  private read(db: DatabaseSync, id: string): SessionRegistryEntry | undefined {
    const cached = this.entries.get(id);
    if (cached !== undefined) return cached;
    const payload = db.prepare("SELECT payload FROM sessions WHERE id = ?").get(id)?.payload;
    if (typeof payload !== "string") return undefined;
    const entry: unknown = JSON.parse(payload);
    if (!registryEntry(entry)) return undefined;
    this.entries.set(id, entry);
    return entry;
  }

  private persist(changes: NonNullable<SessionStore["batchState"]>["changes"]): void {
    try {
      mkdirSync(this.stateDir, { recursive: true, mode: REGISTRY_DIRECTORY_MODE });
      chmodSync(this.stateDir, REGISTRY_DIRECTORY_MODE);
      const db = this.database(true)!;
      db.exec("BEGIN IMMEDIATE");
      const changed = new Map<string, SessionRegistryEntry | undefined>();
      try {
        this.refresh(db);
        for (const { id, apply } of changes) {
          const previous = changed.has(id) ? changed.get(id) : this.read(db, id);
          const next = apply(previous);
          if (next !== undefined || previous !== undefined) changed.set(id, next);
        }
        const upsert = this.upsert(db);
        const remove = db.prepare("DELETE FROM sessions WHERE id = ?");
        for (const [id, entry] of changed) {
          if (entry === undefined) remove.run(id);
          else this.writeRow(upsert, id, entry);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      for (const [id, entry] of changed) {
        if (entry === undefined) this.entries.delete(id);
        else this.entries.set(id, entry);
      }
    } catch (error) {
      if (error instanceof SessionPersistenceError) throw error;
      throw new SessionPersistenceError(this.file, error);
    }
  }

  private mutate(
    id: string,
    apply: (previous: SessionRegistryEntry | undefined) => SessionRegistryEntry | undefined,
  ): void {
    const batch = this.batchState;
    if (batch === undefined) this.persist([{ id, apply }]);
    else {
      const previous = this.get(id);
      batch.changes.push({ id, apply });
      batch.entries.set(id, apply(previous));
    }
  }

  /** Stage only touched rows; replay partial updates against the latest rows under SQLite's write lock. */
  batch<T>(action: () => T): T {
    if (this.batchState !== undefined) return action();
    const batch: NonNullable<SessionStore["batchState"]> = { entries: new Map(), changes: [] };
    this.batchState = batch;
    try {
      const result = action();
      this.batchState = undefined;
      if (batch.changes.length !== 0) this.persist(batch.changes);
      return result;
    } finally {
      this.batchState = undefined;
    }
  }

  get(ocSessionId: string): SessionRegistryEntry | undefined {
    const batch = this.batchState;
    if (batch?.entries.has(ocSessionId)) return batch.entries.get(ocSessionId);
    const db = this.database();
    if (db === undefined) return undefined;
    this.refresh(db);
    const entry = this.read(db, ocSessionId);
    if (batch === undefined) return entry;
    const staged = entry === undefined ? undefined : structuredClone(entry);
    batch.entries.set(ocSessionId, staged);
    return staged;
  }

  idFor(piSessionId: string): string | undefined {
    return this.matching(
      "SELECT id FROM sessions WHERE pi_session_id = ? ORDER BY rowid",
      [piSessionId],
      (entry) => entry.piSessionId === piSessionId,
    )[0];
  }

  childIds(): string[] {
    return this.matching(
      "SELECT id FROM sessions WHERE has_task = 1 AND parent_id IS NOT NULL ORDER BY rowid",
      [],
      (entry) => entry.task !== undefined && entry.parentID !== undefined,
    );
  }

  private matching(
    query: string,
    parameters: SQLInputValue[],
    matches: (entry: SessionRegistryEntry) => boolean,
  ): string[] {
    const db = this.database();
    if (db !== undefined) this.refresh(db);
    const ids = new Set<string>();
    for (const row of db?.prepare(query).all(...parameters) ?? []) if (typeof row.id === "string") ids.add(row.id);
    if (this.batchState === undefined) return [...ids];
    for (const id of this.batchState?.entries.keys() ?? []) ids.add(id);
    return [...ids].filter((id) => {
      const entry = this.get(id);
      return entry !== undefined && matches(entry);
    });
  }

  set(ocSessionId: string, entry: SessionRegistryEntry): void {
    const saved = this.batchState === undefined ? entry : structuredClone(entry);
    this.mutate(ocSessionId, () => (this.batchState === undefined ? saved : structuredClone(saved)));
  }

  /** Merge a partial update (e.g. title override, updated timestamp). */
  update(ocSessionId: string, patch: Partial<SessionRegistryEntry>): void {
    const saved = this.batchState === undefined ? patch : structuredClone(patch);
    this.mutate(ocSessionId, (previous) =>
      previous === undefined
        ? undefined
        : {
            ...previous,
            ...(this.batchState === undefined ? saved : structuredClone(saved)),
          },
    );
  }

  remove(ocSessionId: string): void {
    this.mutate(ocSessionId, () => undefined);
  }

  /** Every directory the registry knows about — used to resolve bare session ids. */
  directories(): string[] {
    const db = this.database();
    const directories = new Set<string>();
    for (const row of db?.prepare("SELECT DISTINCT directory FROM sessions").all() ?? [])
      if (typeof row.directory === "string") directories.add(row.directory);
    if (this.batchState === undefined) return [...directories];
    const ids = this.matching("SELECT id FROM sessions", [], () => true);
    return [...new Set(ids.map((id) => this.get(id)!.directory))];
  }
}
