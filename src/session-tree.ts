import { RPC_COMMAND_TIMEOUT_MS, type PiRpcClient } from "./pi-rpc.js";
import { readFileSync, statSync } from "node:fs";
import type { ManagedSession } from "./sessions.js";
import type { OCMessageWithParts } from "./types.js";
import type { OCPromptPart } from "./types.js";
import { contextMessageID, nativePromptInput } from "./prompt-parts.js";

export interface SessionTreeState {
  messageEntries: Record<string, string>;
  /** Published part identities in native content order, keyed by durable message identity. */
  messageParts?: Record<string, string[]>;
  /** Original rich user input; native RPC stores only adapted text and images. */
  promptParts?: Record<string, OCPromptPart[]>;
  /** Client prompt metadata; native RPC does not store it. */
  promptMetadata?: Record<string, Record<string, unknown>>;
  /** Actual transport dispatch, not inferred from a card's terminal state. */
  shellDispatch?: Record<string, boolean>;
  /** Identity-only dispatched admissions; never rendered without a native entry. */
  localShellTurns?: Array<{ afterEntryId: string | null; messages: [OCMessageWithParts, OCMessageWithParts] }>;
  leafId?: string | null;
  /** Session file size when this connector last saved a live runtime; growth past it came from another client. */
  fileSize?: number;
  revert?: { messageID: string; previousLeafId: string | null; targetId: string | null };
}

export interface TreeEntry {
  type: string;
  id: string;
  parentId: string | null;
  customType?: string;
  details?: unknown;
  message?: {
    role: string;
    clientMessageId?: string;
    content?: string | Array<{ type: string; text?: string }>;
    command?: string;
    output?: string;
    exitCode?: number | null;
    cancelled?: boolean;
  };
}

export interface Entries {
  entries: TreeEntry[];
  leafId: string | null;
}

export class SessionTreeError extends Error {}

export function durableShellTree(tree: SessionTreeState): SessionTreeState {
  return {
    ...tree,
    shellDispatch: Object.fromEntries(Object.entries(tree.shellDispatch ?? {}).filter(([, dispatched]) => dispatched)),
    localShellTurns: (tree.localShellTurns ?? []).filter(
      (turn) => tree.shellDispatch?.[turn.messages[1].info.id] === true,
    ),
  };
}

export async function getEntries(pi: PiRpcClient, signal?: AbortSignal): Promise<Entries> {
  const response = await pi.command<Entries>({ type: "get_entries" }, RPC_COMMAND_TIMEOUT_MS, signal);
  if (!response.success || !response.data)
    throw new SessionTreeError(response.error ?? "OmO returned no session entries");
  return response.data;
}

export function readSessionTree(piPath: string): Entries {
  const lines = readFileSync(piPath, "utf8").trimEnd().split("\n");
  const entries: TreeEntry[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        !("type" in value) ||
        typeof value.type !== "string"
      )
        throw new SyntaxError("Invalid session entry");
      const entry = value as TreeEntry;
      if (entry.type !== "session" && typeof entry.id === "string") entries.push(entry);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      if (index !== lines.length - 1) {
        throw new SessionTreeError(`Malformed session line ${index + 1} in ${piPath}`, { cause: error });
      }
    }
  }
  return { entries, leafId: entries.at(-1)?.id ?? null };
}

/** Checkpoint persisted progress after agent_end, successful compaction, or process exit. */
export function recordTurn(s: ManagedSession): void {
  if (!s.piPath) return;
  const tree = readSessionTree(s.piPath);
  // Disk order is not navigation: only a descendant can advance a saved selection.
  // An ancestor, missing selection, or newer sibling must leave its bindings intact.
  if (
    !s.tree.revert &&
    s.tree.leafId !== undefined &&
    s.tree.leafId !== null &&
    !branchEntries(tree).some((entry) => entry.id === s.tree.leafId)
  )
    return;
  bindMessageEntries(s, tree);
}

/**
 * Another OmO client (e.g. the terminal) resumes at the file tail and appends there.
 * Follow that tail when it descends from the saved selection and was written after
 * this connector last saved, so a committed revert's abandoned branch stays hidden.
 * Registries saved before the size marker existed follow any descendant tail.
 */
export function followExternalAppends(s: ManagedSession, piPath: string): void {
  const saved = s.tree.leafId;
  if (s.tree.revert || saved === undefined || saved === null) return;
  const size = statSync(piPath, { throwIfNoEntry: false })?.size;
  if (size === undefined || (s.tree.fileSize !== undefined && size <= s.tree.fileSize)) return;
  let tree: Entries;
  try {
    tree = readSessionTree(piPath);
  } catch (error) {
    // History parsing skips malformed lines; keep the saved selection rather than guess a tail.
    if (error instanceof SessionTreeError) return;
    throw error;
  }
  if (tree.leafId === saved || !branchEntries(tree).some((entry) => entry.id === saved)) return;
  s.tree.leafId = tree.leafId;
}

export function branchEntries(tree: Entries, leafId = tree.leafId): TreeEntry[] {
  const byId = new Map(tree.entries.map((entry) => [entry.id, entry]));
  const branch: TreeEntry[] = [];
  const seen = new Set<string>();
  for (let entry = leafId === null ? undefined : byId.get(leafId); entry && !seen.has(entry.id); ) {
    seen.add(entry.id);
    branch.push(entry);
    entry = entry.parentId === null ? undefined : byId.get(entry.parentId);
  }
  return branch.reverse();
}

function selectedLeafId(s: ManagedSession, tree: Entries): string | null | undefined {
  let leafId = tree.leafId;
  if (!s.tree.revert && s.tree.leafId !== undefined && s.tree.leafId !== null) {
    const selected = branchEntries(tree, s.tree.leafId);
    // A stale snapshot cannot discard a selection or its identity candidates.
    if (selected.length === 0) return undefined;
    if (tree.leafId === null || selected.some((entry) => entry.id === tree.leafId)) leafId = s.tree.leafId;
  }
  return leafId;
}

function pruneStaleShellTurns(s: ManagedSession, positions: ReadonlyMap<string, number>): void {
  s.tree.localShellTurns = (s.tree.localShellTurns ?? []).filter((turn) => {
    if (turn.afterEntryId === null || positions.has(turn.afterEntryId)) return true;
    const ids = new Set(turn.messages.map((message) => message.info.id));
    s.messages = s.messages?.filter((message) => !ids.has(message.info.id));
    for (const message of turn.messages) s.localMessageIds?.delete(message.info.id);
    if (s.tree.shellDispatch) delete s.tree.shellDispatch[turn.messages[1].info.id];
    return false;
  });
}

function bindOrdinaryEntry(
  s: ManagedSession,
  entry: TreeEntry,
  messages: readonly OCMessageWithParts[],
  cursor: number,
): number {
  const content = entry.message?.content;
  // pi allows plain-string message content (extensions, append_user_message).
  const text =
    typeof content === "string"
      ? content
      : content
          ?.filter((part) => part.type === "text")
          .map((part) => part.text ?? "")
          .join("");
  const index = messages.findIndex(
    (message, position) =>
      position >= cursor &&
      !s.localMessageIds?.has(message.info.id) &&
      s.tree.messageEntries[message.info.id] === undefined &&
      message.info.role === entry.message?.role &&
      (message.info.role !== "user" ||
        (s.tree.promptParts?.[message.info.id]
          ? nativePromptInput(
              message.parts
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n"),
              s.tree.promptParts[message.info.id] ?? [],
            ).message
          : message.parts
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("")) === text),
  );
  const message = messages[index];
  if (message === undefined) return cursor;
  s.tree.messageEntries[message.info.id] = entry.id;
  return index + 1;
}

/** Live ids belong to the UI; restored ids belong to JSONL offsets. Save both. */
export function bindMessageEntries(s: ManagedSession, tree: Entries): void {
  const leafId = selectedLeafId(s, tree);
  if (leafId === undefined) return;
  const branch = branchEntries(tree, s.tree.revert ? s.tree.revert.previousLeafId : leafId);
  const positions = new Map(branch.map((entry, index) => [entry.id, index]));
  pruneStaleShellTurns(s, positions);
  // Admitted context carries its OpenChamber id in the native custom message.
  for (const entry of branch) {
    const messageID = contextMessageID(entry);
    if (messageID !== undefined && s.messages?.some((message) => message.info.id === messageID))
      s.tree.messageEntries[messageID] = entry.id;
  }
  const entries = branch.filter(
    (entry) =>
      entry.type === "message" &&
      (entry.message?.role === "user" ||
        entry.message?.role === "assistant" ||
        entry.message?.role === "bashExecution"),
  );
  const localShellTurns = s.tree.localShellTurns ?? [];
  const visible = s.messages ?? [];
  const visibleIds = new Set(visible.map((message) => message.info.id));
  const candidates = localShellTurns
    .flatMap((turn) => turn.messages)
    .filter((message) => !visibleIds.has(message.info.id));
  for (const message of candidates) (s.localMessageIds ??= new Set()).add(message.info.id);
  const messages = [...visible, ...candidates];
  let cursor = 0;
  for (const entry of entries) {
    const shell = entry.message?.role === "bashExecution";
    const known = messages.findIndex(
      (message) => (!shell || message.info.role === "assistant") && s.tree.messageEntries[message.info.id] === entry.id,
    );
    if (known >= 0) {
      if (known < visible.length) cursor = known + 1;
      continue;
    }
    if (entry.message?.role === "user" && entry.message.clientMessageId !== undefined) {
      const identity = messages.findIndex((message) => message.info.id === entry.message?.clientMessageId);
      if (identity >= 0) {
        s.tree.messageEntries[entry.message.clientMessageId] = entry.id;
        // Queue order can differ from delivery order; identity takes priority over the text cursor.
        continue;
      }
    }
    if (shell) {
      if (Object.values(s.tree.messageEntries).includes(entry.id)) continue;
      const index = messages.findIndex((message, i) => {
        if (
          i < cursor ||
          message.info.role !== "assistant" ||
          s.tree.shellDispatch?.[message.info.id] !== true ||
          s.tree.messageEntries[message.info.id] !== undefined
        )
          return false;
        const parentEntry = s.tree.messageEntries[message.info.parentID];
        if (parentEntry !== undefined && parentEntry !== entry.id) return false;
        const attempt = s.tree.localShellTurns?.find((turn) => turn.messages[1].info.id === message.info.id);
        if (
          attempt?.afterEntryId !== undefined &&
          attempt.afterEntryId !== null &&
          (!positions.has(attempt.afterEntryId) ||
            (positions.get(attempt.afterEntryId) ?? 0) >= (positions.get(entry.id) ?? 0))
        )
          return false;
        const part = message.parts.find(
          (part) => part.type === "tool" && part.tool === "bash" && part.state.input.command === entry.message?.command,
        );
        if (part?.type !== "tool" || part.state.status === "pending") return false;
        const state = part.state;
        if (
          state.status === "error" &&
          state.metadata?.interrupted !== true &&
          (state.metadata?.cancelled !== true || entry.message?.cancelled !== true)
        )
          return false;
        if (state.status === "completed" && entry.message?.cancelled === true) return false;
        if (state.metadata?.cancelled !== undefined && state.metadata.cancelled !== (entry.message?.cancelled === true))
          return false;
        if (
          entry.message?.exitCode !== undefined &&
          state.metadata?.exitCode !== undefined &&
          state.metadata.exitCode !== entry.message.exitCode
        )
          return false;
        if (
          state.status === "completed" &&
          entry.message?.output !== undefined &&
          state.output !== entry.message.output
        )
          return false;
        return true;
      });
      const assistant = messages[index];
      if (assistant?.info.role === "assistant") {
        const parentID = assistant.info.parentID;
        const user = messages.find(
          (message) =>
            message.info.id === parentID &&
            message.info.role === "user" &&
            message.parts.some((part) => part.type === "text" && part.synthetic),
        );
        for (const message of user ? [user, assistant] : [assistant]) {
          s.tree.messageEntries[message.info.id] = entry.id;
          s.localMessageIds?.delete(message.info.id);
        }
        if (index < visible.length) cursor = index + 1;
      }
      continue;
    }
    cursor = bindOrdinaryEntry(s, entry, messages, cursor);
  }
  // Syncs/agent events preserve an active revert's navigation pin. Only
  // revert/unrevert select it explicitly; prompt clears the pin before branching.
  if (!s.tree.revert) s.tree.leafId = leafId;
  s.tree.localShellTurns = localShellTurns.filter(
    (turn) => s.tree.messageEntries[turn.messages[1].info.id] === undefined,
  );
}

function entryForMessage(s: ManagedSession, tree: Entries, messageID: string): TreeEntry {
  const entryId = s.tree.messageEntries[messageID];
  const entry = tree.entries.find((candidate) => candidate.id === entryId);
  if (!entry || !s.messages?.some((message) => message.info.id === messageID)) {
    throw new SessionTreeError(`Unknown messageID: ${messageID}`);
  }
  return entry;
}

export async function forkConversation(s: ManagedSession, pi: PiRpcClient, tree: Entries, messageID?: string) {
  const entry = messageID === undefined ? branchEntries(tree).at(-1) : entryForMessage(s, tree, messageID);
  if (!entry) throw new SessionTreeError("Cannot fork an empty conversation");
  const shellUser =
    entry.message?.role === "bashExecution" &&
    s.messages?.find((message) => message.info.id === messageID)?.info.role === "user";
  // OpenCode forks strictly before any selected message. OmO's default "before"
  // position only accepts user entries, so other boundaries (an assistant reply,
  // as /btw sends) fork "at" the entry preceding them.
  const beforeOther =
    messageID !== undefined && entry.message?.role !== "user" && entry.message?.role !== "bashExecution";
  const forkEntryId = shellUser || beforeOther ? entry.parentId : entry.id;
  if (forkEntryId === null) {
    throw new SessionTreeError(
      shellUser ? "Cannot fork before a root shell entry" : "Cannot fork before the first entry",
    );
  }
  const response = await pi.command<{ cancelled?: boolean }>({
    type: "fork",
    entryId: forkEntryId,
    ...(messageID === undefined || beforeOther || entry.message?.role === "bashExecution" ? { position: "at" } : {}),
  });
  if (!response.success) throw new SessionTreeError(response.error ?? "OmO fork failed");
  if (response.data?.cancelled) throw new SessionTreeError("Conversation fork was cancelled");
  // Fork switches the process; detach it before any new-identity events arrive.
  s.unwirePi?.();
  s.pi = undefined;
  if (s.piPath && s.piSessionId) s.restored = { piPath: s.piPath, piSessionId: s.piSessionId };
  try {
    const state = await pi.command<{ sessionId: string; sessionFile?: string }>({ type: "get_state" });
    if (!state.success || !state.data?.sessionFile) {
      throw new SessionTreeError(state.error ?? "OmO fork did not return a session file");
    }
    return { sessionId: state.data.sessionId, sessionFile: state.data.sessionFile };
  } catch (error) {
    await pi.dispose();
    throw error;
  }
}

export async function revertConversation(
  s: ManagedSession,
  pi: PiRpcClient,
  tree: Entries,
  messageID: string,
): Promise<boolean> {
  const entry = entryForMessage(s, tree, messageID);
  if (s.messages?.find((message) => message.info.id === messageID)?.info.role !== "user")
    throw new SessionTreeError("Revert requires a user messageID");
  if (s.tree.revert?.messageID === messageID) return false;
  const previousLeafId = s.tree.revert ? s.tree.revert.previousLeafId : tree.leafId;
  const leafId = await navigate(pi, entry.parentId);
  s.tree.revert = { messageID, previousLeafId, targetId: entry.parentId };
  s.tree.leafId = leafId;
  s.info.revert = { messageID };
  s.info.time.updated = Date.now();
  return true;
}

export async function unrevertConversation(s: ManagedSession, pi: PiRpcClient): Promise<boolean> {
  if (!s.tree.revert) return false;
  s.tree.leafId = await navigate(pi, s.tree.revert.previousLeafId);
  delete s.tree.revert;
  delete s.info.revert;
  s.info.time.updated = Date.now();
  return true;
}

export async function navigate(pi: PiRpcClient, targetId: string | null, signal?: AbortSignal): Promise<string | null> {
  // The protocol cannot address null. Selecting a root user resets its leaf.
  if (targetId === null) {
    const tree = await getEntries(pi, signal);
    if (tree.leafId === null) return null;
    const root = tree.entries.find((entry) => entry.parentId === null && entry.message?.role === "user");
    if (!root) throw new SessionTreeError("Cannot locate the root conversation message");
    const response = await pi.command<{ cancelled?: boolean; leafId: string | null }>(
      { type: "navigate_tree", targetId: root.id },
      RPC_COMMAND_TIMEOUT_MS,
      signal,
    );
    if (!response.success || !response.data || response.data.cancelled) {
      throw new SessionTreeError(response.error ?? "Root conversation navigation was cancelled");
    }
    return response.data.leafId;
  }
  // Resume selects the exact parent, even when it is a user/custom message.
  const response = await pi.command<{ cancelled?: boolean; leafId: string | null }>(
    {
      type: "navigate_tree",
      targetId,
      intent: "resume",
    },
    RPC_COMMAND_TIMEOUT_MS,
    signal,
  );
  if (!response.success || !response.data)
    throw new SessionTreeError(response.error ?? "OmO returned no navigation result");
  if (response.data.cancelled) throw new SessionTreeError("Conversation navigation was cancelled");
  return response.data.leafId;
}
