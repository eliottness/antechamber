/** Reconstruct OpenCode history from pi JSONL session files. */

import { readFileSync } from "node:fs";
import type { ManagedSession } from "./sessions.js";
import type { OCAssistantMessage, OCMessageWithParts, OCModelRef, OCPart, OCToolPart, OCUserMessage } from "./types.js";
import {
  applyProviderToolResults,
  finishProviderToolParts,
  mapTool,
  providerToolParts,
  resultMetadata,
  resultText,
} from "./tool-map.js";
import { TodoBridge } from "./todo-bridge.js";
import { bindMessageEntries, type Entries, type TreeEntry } from "./session-tree.js";
import { taskParts, updateTaskParts, taskCompletions } from "./subagents.js";
import { shellTitle, shellUserMessage } from "./session-commands.js";
import { piModelId, piStopReason, textOf, type PiUsage } from "./pi-event-translation.js";

// ----------------------------------------------------------------------
// Restored-session history: pi JSONL file → OpenCode messages + parts
// ----------------------------------------------------------------------

interface PiFileEntry {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string | number;
  provider?: string;
  modelId?: string;
  message?: PiFileMessage;
  customType?: string;
  details?: unknown;
  data?: {
    durableSessionId?: string;
    clientMessageId?: string;
    state?: string;
    prepared?: { text?: string; mode?: string; enqueueOrder?: number };
  };
}

export interface PiFileMessage {
  clientMessageId?: string;
  role?: string;
  content?: Array<Record<string, unknown>>;
  usage?: PiUsage;
  provider?: string;
  model?: string;
  responseModel?: string;
  stopReason?: string;
  errorMessage?: string;
  timestamp?: number;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  details?: unknown;
  command?: string;
  output?: string;
  exitCode?: number | null;
  cancelled?: boolean;
  truncated?: boolean;
  fullOutputPath?: string;
}

function entryTime(e: PiFileEntry): number {
  if (typeof e.timestamp === "number") return e.timestamp;
  if (typeof e.timestamp === "string") {
    const t = Date.parse(e.timestamp);
    if (!Number.isNaN(t)) return t;
  }
  if (typeof e.message?.timestamp === "number") return e.message.timestamp;
  return 0;
}

/**
 * Rebuild OpenCode messages from a pi session file for a dormant session.
 * pi entries form a tree (id/parentId); the active branch is the walk from
 * the newest message entry up to the root. Part ids are deterministic
 * (`prt_r<entry>_<block>`) so re-parsing reconciles in the UI instead of
 * duplicating. Never throws: unreadable/corrupt input degrades to [].
 */
export function parsePiSessionFile(s: ManagedSession, agentName: string): OCMessageWithParts[] {
  const piPath = s.piPath ?? s.restored?.piPath;
  if (piPath === undefined) return [];
  let raw: string;
  try {
    raw = readFileSync(piPath, "utf8");
  } catch {
    return [];
  }
  return parsePiSessionText(s, agentName, raw);
}

export function parsePiSessionText(s: ManagedSession, agentName: string, raw: string): OCMessageWithParts[] {
  const sessionID = s.info.id;
  const directory = s.info.directory;

  const entries: PiFileEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    try {
      const value = JSON.parse(line) as PiFileEntry | null;
      if (value !== null && typeof value === "object") entries.push(value);
    } catch {
      /* torn trailing write — ignore */
    }
  }

  const indexOf = new Map<PiFileEntry, number>();
  entries.forEach((e, i) => indexOf.set(e, i));
  const byId = new Map<string, PiFileEntry>();
  for (const e of entries) if (typeof e.id === "string") byId.set(e.id, e);

  let leaf = [...entries].reverse().find((entry) => entry.type !== "session" && typeof entry.id === "string");
  let selectedLeaf = s.tree.revert ? s.tree.revert.previousLeafId : s.tree.leafId;
  if (!s.tree.revert && s.tree.localShellTurns?.length) {
    // Follow a newly recorded descendant, never a sibling of the selected native branch.
    if (selectedLeaf === null) selectedLeaf = undefined;
    for (
      let entry = leaf;
      entry !== undefined;
      entry = typeof entry.parentId === "string" ? byId.get(entry.parentId) : undefined
    ) {
      if (entry.id === selectedLeaf) {
        selectedLeaf = undefined;
        break;
      }
    }
  }
  if (selectedLeaf !== undefined) leaf = selectedLeaf === null ? undefined : byId.get(selectedLeaf);
  const chain: PiFileEntry[] = [];
  const seen = new Set<PiFileEntry>();
  for (let cur = leaf; cur !== undefined && !seen.has(cur); ) {
    seen.add(cur);
    chain.push(cur);
    cur = typeof cur.parentId === "string" ? byId.get(cur.parentId) : undefined;
  }
  chain.reverse();
  const nativeTree: Entries = {
    leafId: leaf?.id ?? null,
    entries: entries.flatMap((entry): TreeEntry[] => {
      if (entry.id === undefined || entry.type === undefined) return [];
      const m = entry.message;
      return [
        {
          type: entry.type,
          id: entry.id,
          parentId: entry.parentId ?? null,
          ...(m?.role === undefined
            ? {}
            : {
                message: {
                  role: m.role,
                  ...(m.clientMessageId === undefined ? {} : { clientMessageId: m.clientMessageId }),
                  ...(m.role === "user" ? { content: [{ type: "text", text: textOf(m.content) }] } : {}),
                  ...(m.command === undefined ? {} : { command: m.command }),
                  ...(m.output === undefined ? {} : { output: m.output }),
                  ...(m.exitCode === undefined ? {} : { exitCode: m.exitCode }),
                  ...(m.cancelled === undefined ? {} : { cancelled: m.cancelled }),
                },
              }),
        },
      ];
    }),
  };
  if (s.tree.localShellTurns?.length) bindMessageEntries(s, nativeTree);

  const out: OCMessageWithParts[] = [];
  const toolParts = new Map<string, OCToolPart[]>();
  let currentModel: OCModelRef = { providerID: "unknown", modelID: "unknown" };
  let lastUserId = "";
  // Like live agent_end, a new user turn closes the previous run: its own
  // unresolved provider cards end with that run's stop reason.
  let runAssistant: PiFileEntry | undefined;
  const endRun = (): void => {
    if (runAssistant === undefined) return;
    finishProviderToolParts(
      [...toolParts.values()].flat(),
      entryTime(runAssistant),
      runAssistant.message?.stopReason === "aborted" ? "Cancelled" : "No result",
    );
    runAssistant = undefined;
  };

  for (const e of chain) {
    if (e.type === "model_change" && typeof e.provider === "string" && typeof e.modelId === "string") {
      currentModel = { providerID: e.provider, modelID: e.modelId };
      continue;
    }
    if (e.type !== "message") continue;
    const m = e.message;
    if (m === undefined) continue;
    const idx = indexOf.get(e) ?? 0;
    const created = entryTime(e);

    if (m.role === "user") {
      endRun();
      const text = textOf(m.content);
      if (text === "") continue;
      const msgId =
        m.clientMessageId ??
        Object.keys(s.tree.messageEntries).find((key) => s.tree.messageEntries[key] === e.id) ??
        `msg_${sessionID}_r${idx}`;
      if (e.id) s.tree.messageEntries[msgId] = e.id;
      lastUserId = msgId;
      const info: OCUserMessage = {
        id: msgId,
        sessionID,
        role: "user",
        time: { created },
        agent: agentName,
        model: currentModel,
      };
      const parts: OCPart[] = [
        {
          id: `prt_${sessionID}_r${idx}_0`,
          sessionID,
          messageID: msgId,
          type: "text",
          text,
          time: { start: created, end: created },
        },
      ];
      out.push({ info, parts });
      continue;
    }

    if (m.role === "bashExecution") {
      const mappedIds = Object.keys(s.tree.messageEntries).filter((key) => s.tree.messageEntries[key] === e.id);
      const userId = mappedIds.find((key) => key.endsWith("u"));
      const stem = userId?.slice(0, -1) ?? mappedIds[0] ?? `msg_${sessionID}_r${idx}`;
      const msgId = `${stem}z`;
      lastUserId = `${stem}u`;
      if (e.id) {
        s.tree.messageEntries[msgId] = e.id;
        s.tree.messageEntries[lastUserId] = e.id;
      }
      const command = m.command ?? "";
      const input = { command, description: command };
      const metadata = {
        exitCode: m.exitCode ?? null,
        cancelled: m.cancelled === true,
        truncated: m.truncated === true,
        ...(m.fullOutputPath !== undefined ? { fullOutputPath: m.fullOutputPath } : {}),
      };
      const info: OCAssistantMessage = {
        id: msgId,
        sessionID,
        role: "assistant",
        time: { created, completed: created },
        parentID: lastUserId,
        modelID: currentModel.modelID,
        providerID: currentModel.providerID,
        mode: agentName,
        path: { cwd: directory, root: directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      };
      const part: OCToolPart = {
        id: `prt_${sessionID}_r${idx}_0`,
        sessionID,
        messageID: msgId,
        type: "tool",
        tool: "bash",
        callID: `call_${sessionID}_r${idx}_0`,
        state:
          m.cancelled === true
            ? { status: "error", input, error: "Command cancelled", metadata, time: { start: created, end: created } }
            : {
                status: "completed",
                input,
                output: m.output ?? "",
                title: shellTitle(command),
                metadata,
                time: { start: created, end: created },
              },
      };
      const message = { info, parts: [part] } satisfies import("./session-commands.js").ShellMessage;
      out.push(shellUserMessage(message), message);
      continue;
    }

    if (m.role === "assistant") {
      runAssistant = e;
      const responseModel = piModelId(m.responseModel, m.model);
      if (typeof m.provider === "string" && typeof responseModel === "string") {
        currentModel = { providerID: m.provider, modelID: responseModel };
      }
      const msgId =
        Object.keys(s.tree.messageEntries).find((key) => s.tree.messageEntries[key] === e.id) ??
        `msg_${sessionID}_r${idx}`;
      if (e.id) s.tree.messageEntries[msgId] = e.id;
      const info: OCAssistantMessage = {
        id: msgId,
        sessionID,
        role: "assistant",
        time: {
          created:
            typeof m.timestamp === "number" && Number.isFinite(m.timestamp) && m.timestamp <= created
              ? m.timestamp
              : created,
          completed: created,
        },
        parentID: lastUserId,
        modelID: currentModel.modelID,
        providerID: currentModel.providerID,
        mode: agentName,
        path: { cwd: directory, root: directory },
        cost: m.usage?.cost?.total ?? 0,
        tokens: {
          input: m.usage?.input ?? 0,
          output: m.usage?.output ?? 0,
          reasoning: m.usage?.reasoning ?? 0,
          cache: { read: m.usage?.cacheRead ?? 0, write: m.usage?.cacheWrite ?? 0 },
        },
        ...piStopReason(m.stopReason, m.errorMessage),
      };
      const parts: OCPart[] = [];
      const blocks = Array.isArray(m.content) ? m.content : [];
      const providerParts = providerToolParts(
        blocks,
        sessionID,
        msgId,
        typeof m.timestamp === "number" ? m.timestamp : created,
      );
      blocks.forEach((block, b) => {
        const partId = `prt_${sessionID}_r${idx}_${b}`;
        const kind = block?.type;
        if (kind === "text" && typeof block.text === "string") {
          parts.push({
            id: partId,
            sessionID,
            messageID: msgId,
            type: "text",
            text: block.text,
            time: { start: created, end: created },
          });
        } else if (kind === "thinking" && typeof block.thinking === "string") {
          parts.push({
            id: partId,
            sessionID,
            messageID: msgId,
            type: "reasoning",
            text: block.thinking,
            time: { start: created, end: created },
          });
        } else if (kind === "providerNative") {
          const part = providerParts.get(b);
          if (part !== undefined) {
            parts.push(part);
            toolParts.set(part.callID, [part]);
          }
        } else if (kind === "toolCall") {
          const callID = typeof block.id === "string" ? block.id : `call_r${idx}_${b}`;
          const tool = typeof block.name === "string" ? block.name : "unknown";
          const args = block.arguments;
          const input = args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {};
          const mapped = mapTool(tool, input);
          const part: OCToolPart = {
            id: partId,
            sessionID,
            messageID: msgId,
            type: "tool",
            callID,
            tool: mapped.tool,
            state: {
              status: "running",
              input: mapped.input,
              title: mapped.title,
              ...(mapped.metadata !== undefined ? { metadata: mapped.metadata } : {}),
              time: { start: created },
            },
          };
          const mappedParts = tool === "task" ? taskParts(part, input) : [part];
          toolParts.set(callID, mappedParts);
          parts.push(...mappedParts);
        }
      });
      applyProviderToolResults(
        blocks,
        [...toolParts.values()].flat(),
        typeof m.timestamp === "number" ? m.timestamp : created,
      );
      out.push({ info, parts });
      continue;
    }

    if (m.role === "toolResult") {
      const callID = typeof m.toolCallId === "string" ? m.toolCallId : undefined;
      const matching = callID !== undefined ? toolParts.get(callID) : undefined;
      const part = matching?.[0];
      if (part === undefined) continue; // result without a visible call (abandoned branch)
      if (part.tool === "task" && matching !== undefined) {
        updateTaskParts(matching, m, true, created);
        continue;
      }
      const text = resultText(m.content) ?? "";
      const startedAt = part.state.status !== "pending" ? part.state.time.start : created;
      const input = part.state.input ?? {};
      const metadata = {
        ...(part.state.status !== "pending" ? part.state.metadata : {}),
        ...resultMetadata(part.tool, m),
      };
      const title =
        part.state.status === "running" || part.state.status === "completed"
          ? (part.state.title ?? part.tool)
          : part.tool;
      part.state =
        m.isError === true
          ? {
              status: "error",
              input,
              error: text !== "" ? text : `tool ${part.tool} failed`,
              metadata,
              time: { start: startedAt, end: created },
            }
          : {
              status: "completed",
              input,
              output: text,
              title,
              metadata,
              time: { start: startedAt, end: created },
            };
      continue;
    }
    // system / custom entries are not rendered
  }
  const lastAssistant = [...chain].reverse().find((entry) => entry.message?.role === "assistant");
  const stopReason = lastAssistant?.message?.stopReason;
  if (lastAssistant !== undefined && ["stop", "length", "error", "aborted"].includes(stopReason ?? "")) {
    finishProviderToolParts(
      [...toolParts.values()].flat(),
      entryTime(lastAssistant),
      stopReason === "aborted" ? "Cancelled" : "No result",
    );
  }
  s.todoBridge = new TodoBridge(sessionID);
  s.todoBridge.restore(
    entries,
    new Map([...toolParts].flatMap(([callID, parts]) => (parts[0] ? [[callID, parts[0]] as const] : []))),
  );
  // Completions can be appended after the newest message, outside its ancestor chain.
  for (const entry of entries) {
    if (entry.customType !== "omo-senpi:wake") continue;
    for (const data of taskCompletions(entry.details)) {
      for (const parts of toolParts.values()) {
        for (const part of parts) {
          if (part.tool === "task" && part.state.status !== "pending" && part.state.metadata?.taskID === data.task_id) {
            updateTaskParts([part], { details: data }, true, entryTime(entry));
          }
        }
      }
    }
  }
  const admissions = new Map<string, PiFileEntry>();
  for (const entry of entries) {
    if (
      entry.type === "custom" &&
      entry.customType === "rpc_client_message_admission" &&
      entry.data !== undefined &&
      entry.data?.durableSessionId === (s.piSessionId ?? s.restored?.piSessionId) &&
      typeof entry.data.clientMessageId === "string"
    )
      admissions.set(entry.data.clientMessageId, entry);
  }
  for (const [messageID, entry] of [...admissions].sort(
    (a, b) => (a[1].data?.prepared?.enqueueOrder ?? 0) - (b[1].data?.prepared?.enqueueOrder ?? 0),
  )) {
    const data = entry.data;
    if (
      data?.state !== "queued" ||
      typeof data.prepared?.text !== "string" ||
      out.some((message) => message.info.id === messageID)
    )
      continue;
    const text = data.prepared.text;
    const delivery = data.prepared.mode === "followUp" ? "queue" : "steer";
    out.push({
      info: {
        id: messageID,
        sessionID,
        role: "user",
        time: { created: entryTime(entry) },
        agent: agentName,
        model: currentModel,
      },
      parts: [{ id: `prt_${messageID}_pending`, sessionID, messageID, type: "text", text }],
    });
    (s.inputs ??= new Map()).set(messageID, { text, delivery, accepted: true, delivered: false });
  }
  return out;
}
