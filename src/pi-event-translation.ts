/** Pi message/part translation and the live event bridge, with explicit manager services. */

import { randomUUID } from "node:crypto";
import type {
  OCAssistantMessage,
  OCMessageWithParts,
  OCModelRef,
  OCEvent,
  OCSessionStatus,
  OCPart,
  OCTextPart,
  OCReasoningPart,
  OCToolPart,
  OCToolStatePending,
} from "./types.js";
import type { ManagedSession } from "./sessions.js";
import type { PiFileMessage } from "./session-history.js";
import type { SessionStore } from "./session-store.js";
import type { SubagentBridge } from "./subagents.js";
import {
  applyProviderToolResults,
  finishProviderToolParts,
  mapTool,
  providerToolParts,
  resultMetadata,
  resultText,
} from "./tool-map.js";
import { TodoBridge, type TodoUpdated } from "./todo-bridge.js";
import { readSessionTree, recordTurn } from "./session-tree.js";
import { touchedFiles } from "./session-diff.js";
import { getAgentName } from "./agent-name.js";
import { debugLog } from "./misc-routes.js";
import { envSetting } from "./config.js";

export interface PiUsage {
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

export function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

/**
 * pi reports the requested `model` and, once the provider has answered, the
 * concrete `responseModel` it actually served. The latter is the truth.
 */
export function piModelId(responseModel: unknown, model: unknown): unknown {
  return typeof responseModel === "string" && responseModel !== "" ? responseModel : model;
}

export function piStopReason(
  stopReason: string | undefined,
  errorMessage?: string,
): Pick<OCAssistantMessage, "finish" | "error"> {
  switch (stopReason) {
    case "stop":
    case "length":
      return { finish: stopReason };
    case "toolUse":
      return { finish: "tool-calls" };
    case "error":
    case "aborted":
      return {
        finish: "error",
        error: {
          name: stopReason === "aborted" ? "MessageAbortedError" : "UnknownError",
          data: { message: errorMessage ?? (stopReason === "aborted" ? "Cancelled" : "Provider error") },
        },
      };
    default:
      return {};
  }
}

export function textOf(content: Array<Record<string, unknown>> | undefined): string {
  if (!Array.isArray(content)) return "";
  return content.map((b) => (b?.type === "text" && typeof b.text === "string" ? b.text : "")).join("");
}

function newPart(kind: "text" | "reasoning", sessionID: string, messageID: string): OCPart {
  const base = {
    id: id("prt"),
    sessionID,
    messageID,
    text: "",
    time: { start: Date.now() },
  };
  return kind === "text"
    ? ({ ...base, type: "text" } satisfies OCTextPart)
    : ({ ...base, type: "reasoning" } satisfies OCReasoningPart);
}

function applyUsage(msg: OCAssistantMessage, usage: PiUsage | undefined): void {
  if (!usage) return;
  msg.tokens = {
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    reasoning: usage.reasoning ?? 0,
    cache: { read: usage.cacheRead ?? 0, write: usage.cacheWrite ?? 0 },
  };
  if (usage.cost?.total !== undefined) msg.cost = usage.cost.total;
}

/**
 * Recompute the session's own spend from its loaded assistant messages. Subagent
 * spend stays on the child sessions: OpenChamber sums the parentID subtree, so
 * folding it in here would count it twice. Returns whether the value changed.
 */
export function syncSessionCost(s: ManagedSession): boolean {
  if (s.messages === undefined) return false;
  let cost = 0;
  const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  for (const message of s.messages)
    if (message.info.role === "assistant") {
      cost += message.info.cost;
      tokens.input += message.info.tokens.input;
      tokens.output += message.info.tokens.output;
      tokens.reasoning += message.info.tokens.reasoning;
      tokens.cache.read += message.info.tokens.cache.read;
      tokens.cache.write += message.info.tokens.cache.write;
    }
  s.info.tokens = tokens;
  if ((s.info.cost ?? 0) === cost) return false; // absent means zero; avoid no-op updates
  s.info.cost = cost;
  return true;
}

/**
 * An OmO compaction as OpenCode shows one: a user turn holding a `compaction`
 * part (OpenChamber renders it as `/compact`) answered by a `summary` message.
 * IDs derive from the native compaction entry, not its retained boundary:
 * multiple compactions can retain the same entry.
 */
export function compactionMessages(
  s: ManagedSession,
  key: string,
  summary: string,
  created: number,
  model: OCModelRef | undefined,
): [OCMessageWithParts, OCMessageWithParts] {
  const sessionID = s.info.id;
  const userID = `msg_compaction_${key}`;
  const summaryID = `${userID}_summary`;
  const served = model ?? { providerID: "unknown", modelID: "unknown" };
  return [
    {
      info: { id: userID, sessionID, role: "user", time: { created }, agent: getAgentName(), model: served },
      parts: [{ id: `prt_compaction_${key}`, sessionID, messageID: userID, type: "compaction", auto: false }],
    },
    {
      info: {
        id: summaryID,
        sessionID,
        role: "assistant",
        time: { created, completed: created },
        parentID: userID,
        modelID: served.modelID,
        providerID: served.providerID,
        mode: getAgentName(),
        path: { cwd: s.info.directory, root: s.info.directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
        summary: true,
      },
      parts: [
        {
          id: `prt_compaction_${key}_summary`,
          sessionID,
          messageID: summaryID,
          type: "text",
          text: summary,
          time: { start: created, end: created },
        },
      ],
    },
  ];
}

interface PiEventServices {
  readonly emit: (directory: string, event: OCEvent | TodoUpdated) => void;
  readonly subagents: SubagentBridge;
  readonly store: Pick<SessionStore, "update">;
  readonly dirtyDiffs: Set<string>;
  readonly ensureMessages: (s: ManagedSession) => OCMessageWithParts[];
  readonly applyNativeTitle: (s: ManagedSession, value: unknown) => void;
  readonly applyPiModel: (s: ManagedSession, provider: unknown, modelId: unknown) => boolean;
  readonly emitDiff: (s: ManagedSession) => void;
  readonly persistMeta: (s: ManagedSession) => void;
}

/** Translates per-session events; registry and lifecycle operations stay with SessionManager. */
export class PiEventTranslator {
  constructor(private services: PiEventServices) {}

  /** Close dead-runtime UI state before an error or idle event can reach the client. */
  finishInterruptedRun(s: ManagedSession, error: NonNullable<OCAssistantMessage["error"]>): void {
    const now = Date.now();
    s.approvals?.finishTurn();
    for (const part of s.streaming?.parts.values() ?? []) {
      if (part.type === "tool") s.toolByCallId.set(part.callID, part);
      else if (
        (part.type === "text" || part.type === "reasoning") &&
        part.time !== undefined &&
        part.time.end === undefined
      ) {
        part.time.end = now;
        this.emitPart(s, part);
      }
    }
    this.finalizeDanglingTools(s);
    this.services.subagents.finishCalls(s.info.id);
    if (s.streaming !== undefined) {
      const message = s.streaming.message;
      message.finish = "error";
      message.error = error;
      message.time.completed = now;
      this.services.emit(s.info.directory, { type: "message.updated", properties: { info: message } });
      this.finishStreaming(s);
    }
    delete s.compactingFromIdle;
    delete s.info.time.compacting;
  }

  setStatus(s: ManagedSession, status: OCSessionStatus): void {
    s.status = status;
    this.services.emit(s.info.directory, {
      type: "session.status",
      properties: { sessionID: s.info.id, status },
    });
    if (status.type === "idle") {
      s.info.time.idle = Date.now();
      const last = [...(s.messages ?? [])].reverse().find((message) => message.info.role === "assistant");
      s.info.outcome =
        s.interruptRequested || (last?.info.role === "assistant" && last.info.error?.name === "MessageAbortedError")
          ? "interrupted"
          : last?.info.role === "assistant" && last.info.finish === "error"
            ? "failed"
            : "succeeded";
      this.services.emit(s.info.directory, { type: "session.idle", properties: { sessionID: s.info.id } });
    }
  }

  emitPart(s: ManagedSession, part: OCPart, delta?: string): void {
    this.services.emit(s.info.directory, {
      type: "message.part.updated",
      properties: delta === undefined ? { part } : { part, delta },
    });
  }

  deliverInput(s: ManagedSession, messageID: string): void {
    this.services.emit(s.info.directory, {
      type: "session.inbox.delivered",
      properties: { sessionID: s.info.id, inboxID: messageID },
    });
    s.inputs?.delete(messageID);
  }

  private reconcileUser(s: ManagedSession, ev: Record<string, unknown>): boolean {
    const message = ev.message as PiFileMessage | undefined;
    if (message?.role !== "user") return false;
    const text = textOf(message.content);
    const correlated = typeof ev.clientMessageId === "string" ? ev.clientMessageId : message.clientMessageId;
    const pending =
      correlated ?? [...(s.inputs ?? [])].find(([, input]) => !input.delivered && input.text === text)?.[0];
    const messageID = pending ?? (ev.type === "message_end" ? s.activeUserMessageID : undefined) ?? id("msg");
    let user = this.services.ensureMessages(s).find((item) => item.info.id === messageID);
    if (user === undefined) {
      user = {
        info: {
          id: messageID,
          sessionID: s.info.id,
          role: "user",
          time: { created: message.timestamp ?? Date.now() },
          agent: getAgentName(),
          model: s.model ?? { providerID: "unknown", modelID: "unknown" },
        },
        parts: [{ id: id("prt"), sessionID: s.info.id, messageID, type: "text", text }],
      };
      s.messages?.push(user);
      this.services.emit(s.info.directory, { type: "message.updated", properties: { info: user.info } });
      for (const part of user.parts) this.emitPart(s, part);
      if (pending === undefined) {
        this.services.emit(s.info.directory, {
          type: "session.inbox.enqueued",
          properties: {
            sessionID: s.info.id,
            inboxID: messageID,
            item: { type: "user", delivery: "steer", payload: { text } },
          },
        });
        this.deliverInput(s, messageID);
      }
    }
    s.activeUserMessageID = messageID;
    const input = s.inputs?.get(messageID);
    if (input && !input.delivered) {
      input.delivered = true;
      if (input.accepted) this.deliverInput(s, messageID);
    }
    return true;
  }

  onPiEvent(s: ManagedSession, ev: Record<string, unknown>): void {
    this.services.subagents.wake(s, ev);
    if (envSetting("DEBUG")) {
      const ame = (ev.assistantMessageEvent as { type?: string } | undefined)?.type;
      debugLog(`[pi-event] ${String(ev.type)}${ame ? `/${ame}` : ""} ${JSON.stringify(ev).slice(0, 300)}`);
    }
    switch (ev.type) {
      case "entry_appended":
        this.onTodoEntry(s, ev);
        break;
      case "session_info_changed":
        this.services.applyNativeTitle(s, ev.name);
        break;
      case "agent_start":
      case "agent_idle":
      case "agent_end":
      case "auto_retry_start":
      case "turn_end":
      case "extension_error":
        this.onLifecycleEvent(s, ev);
        break;
      case "tool_execution_start":
      case "tool_execution_update":
      case "tool_execution_end":
        this.onToolEvent(s, ev);
        break;
      case "message_start":
      case "message_update":
      case "message_end":
        this.onMessageEvent(s, ev);
        break;
      case "compaction_start":
      case "compaction_end":
        this.onCompactionEvent(s, ev);
        break;
      default:
        break; // turn_start, queue_update — future milestones
    }
  }

  private onTodoEntry(s: ManagedSession, ev: Record<string, unknown>): void {
    s.todoBridge ??= new TodoBridge(s.info.id);
    const event = s.todoBridge.entry(ev.entry, (part) => this.emitPart(s, part));
    if (event !== undefined) this.services.emit(s.info.directory, event);
  }

  private onLifecycleEvent(s: ManagedSession, ev: Record<string, unknown>): void {
    switch (ev.type) {
      case "agent_start":
        this.setStatus(s, { type: "busy" });
        return;
      case "agent_end":
        if (ev.willRetry === true) return; // auto-retry keeps the session busy
        if (s.interruptRequested)
          this.finishInterruptedRun(s, { name: "MessageAbortedError", data: { message: "Cancelled" } });
        s.approvals?.finishTurn();
        this.finalizeDanglingTools(s);
        this.services.subagents.finishCalls(s.info.id);
        this.finishStreaming(s);
        this.services.emitDiff(s);
        s.info.time.updated = Date.now();
        this.services.persistMeta(s);
        this.services.emit(s.info.directory, { type: "session.updated", properties: { info: s.info } });
        if (s.piPath !== undefined) this.services.store.update(s.info.id, { updated: Date.now() });
        recordTurn(s);
        this.services.persistMeta(s);
        return;
      case "agent_idle":
        // agent_end closes one run, not the session: OmO may still retry or
        // start a deferred continuation. Only agent_idle settles that work.
        if (s.interruptRequested) {
          this.finishInterruptedRun(s, { name: "MessageAbortedError", data: { message: "Cancelled" } });
          this.services.emit(s.info.directory, {
            type: "session.error",
            properties: {
              sessionID: s.info.id,
              error: { name: "MessageAbortedError", data: { message: "Cancelled" } },
            },
          });
          delete s.interruptRequested;
        }
        this.setStatus(s, { type: "idle" });
        return;
      case "turn_end": {
        s.approvals?.finishTurn();
        // pi delivers tool results here, matched back to parts by toolCallId.
        const results = ev.toolResults as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(results)) this.applyToolResults(s, results);
        this.services.emitDiff(s);
        return;
      }
      case "auto_retry_start":
        this.setStatus(s, {
          type: "retry",
          attempt: Number(ev.attempt ?? 1),
          message: String(ev.errorMessage ?? "retrying"),
          next: Date.now() + Number(ev.delayMs ?? 0),
        });
        return;
      case "extension_error":
        this.services.emit(s.info.directory, {
          type: "session.error",
          properties: {
            sessionID: s.info.id,
            error: { name: "UnknownError", data: { message: String(ev.error ?? "pi extension error") } },
          },
        });
        return;
      default:
        return;
    }
  }

  private onToolEvent(s: ManagedSession, ev: Record<string, unknown>): void {
    switch (ev.type) {
      case "tool_execution_start": {
        if (typeof ev.toolCallId === "string" && typeof ev.toolName === "string") {
          s.approvals?.noteToolStart(ev.toolCallId, ev.toolName, ev.args);
        }
        if (ev.toolName === "task") return; // Expanded when the argument stream closes.
        const callID = typeof ev.toolCallId === "string" ? ev.toolCallId : undefined;
        const part = callID !== undefined ? s.toolByCallId.get(callID) : undefined;
        if (part === undefined) return;
        const name = typeof ev.toolName === "string" ? ev.toolName : part.tool;
        const mapped = mapTool(name, name === "todo" ? part.state.input : ev.args);
        part.tool = mapped.tool;
        part.state = {
          status: "running",
          input: mapped.input,
          title: mapped.title,
          ...(mapped.metadata !== undefined ? { metadata: mapped.metadata } : {}),
          time: { start: part.state.status !== "pending" ? part.state.time.start : Date.now() },
        };
        this.emitPart(s, part);
        return;
      }
      case "tool_execution_update": {
        if (
          typeof ev.toolCallId === "string" &&
          this.services.subagents.result(
            s,
            ev.toolCallId,
            ev.partialResult !== null && typeof ev.partialResult === "object" ? ev.partialResult : {},
            false,
          )
        )
          return;
        const part = typeof ev.toolCallId === "string" ? s.toolByCallId.get(ev.toolCallId) : undefined;
        if (part === undefined || part.state.status !== "running") return;
        this.emitPart(s, part);
        return;
      }
      case "tool_execution_end": {
        if (typeof ev.toolCallId === "string") s.approvals?.noteToolEnd(ev.toolCallId);
        const result = ev.result !== null && typeof ev.result === "object" ? ev.result : {};
        this.applyToolResults(s, [{ ...result, toolCallId: ev.toolCallId, isError: ev.isError }]);
        return;
      }
      default:
        return;
    }
  }

  private onMessageEvent(s: ManagedSession, ev: Record<string, unknown>): void {
    switch (ev.type) {
      case "message_start": {
        if (this.reconcileUser(s, ev)) return;
        const msg = ev.message as
          | { role?: string; provider?: unknown; model?: unknown; responseModel?: unknown }
          | undefined;
        if (msg?.role !== "assistant") return; // user message already recorded at prompt()
        // pi stamps the assistant message with the model really serving it.
        // Trust that over our snapshot, which goes stale whenever pi switches on
        // its own side (subagent routing, an in-session /model, a resumed file).
        this.services.applyPiModel(s, msg.provider, piModelId(msg.responseModel, msg.model));
        const parent = [...(s.messages ?? [])].reverse().find((m) => m.info.role === "user");
        const assistant: OCAssistantMessage = {
          id: id("msg"),
          sessionID: s.info.id,
          role: "assistant",
          time: { created: Date.now() },
          parentID:
            typeof ev.clientMessageId === "string"
              ? ev.clientMessageId
              : (s.activeUserMessageID ?? parent?.info.id ?? ""),
          modelID: s.model?.modelID ?? "unknown",
          providerID: s.model?.providerID ?? "unknown",
          mode: getAgentName(),
          path: { cwd: s.info.directory, root: s.info.directory },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        };
        s.streaming = { message: assistant, parts: new Map() };
        s.messages?.push({ info: assistant, parts: [] });
        this.services.emit(s.info.directory, { type: "message.updated", properties: { info: assistant } });
        return;
      }
      case "message_update":
        this.onMessageUpdate(s, ev);
        return;
      case "message_end": {
        if (this.reconcileUser(s, ev)) return;
        const ended = ev.message as
          | {
              role?: string;
              stopReason?: string;
              errorMessage?: string;
              usage?: PiUsage;
              provider?: unknown;
              model?: unknown;
              responseModel?: unknown;
            }
          | undefined;
        if (ended?.role !== "assistant" || !s.streaming) return;
        this.onProviderTools(s, ev.message);
        if (ended.stopReason === "aborted" || ended.stopReason === "error") {
          for (const part of finishProviderToolParts(
            s.toolByCallId.values(),
            Date.now(),
            ended.stopReason === "aborted" ? "Cancelled" : "No result",
          ))
            this.emitPart(s, part);
        }
        // Last chance to correct attribution: some providers only reveal the
        // concrete model once the stream has closed.
        if (
          this.services.applyPiModel(s, ended.provider, piModelId(ended.responseModel, ended.model)) &&
          s.model !== undefined
        ) {
          s.streaming.message.providerID = s.model.providerID;
          s.streaming.message.modelID = s.model.modelID;
        }
        applyUsage(s.streaming.message, ended.usage);
        Object.assign(s.streaming.message, piStopReason(ended.stopReason, ended.errorMessage));
        s.streaming.message.time.completed = Date.now();
        this.services.emit(s.info.directory, { type: "message.updated", properties: { info: s.streaming.message } });
        this.finishStreaming(s);
        if (syncSessionCost(s))
          this.services.emit(s.info.directory, { type: "session.updated", properties: { info: s.info } });
        return;
      }
      default:
        return;
    }
  }

  private onCompactionEvent(s: ManagedSession, ev: Record<string, unknown>): void {
    switch (ev.type) {
      case "compaction_start":
        s.compactionID = id("compaction");
        this.services.emit(s.info.directory, {
          type: "session.compaction.started",
          properties: {
            sessionID: s.info.id,
            inputID: s.compactionID,
            reason: typeof ev.reason === "string" ? ev.reason : "manual",
          },
        });
        s.info.time.compacting = Date.now();
        this.services.emit(s.info.directory, { type: "session.updated", properties: { info: s.info } });
        // A manual /compact runs no agent turn, so nothing else marks the session busy.
        if (s.status.type === "idle") {
          s.compactingFromIdle = true;
          this.setStatus(s, { type: "busy" });
        }
        return;
      case "compaction_end": {
        delete s.info.time.compacting;
        const result = ev.result as { summary?: unknown; firstKeptEntryId?: unknown } | undefined;
        const inputID = s.compactionID ?? id("compaction");
        delete s.compactionID;
        this.services.emit(
          s.info.directory,
          ev.aborted === true || typeof result?.summary !== "string"
            ? {
                type: "session.compaction.failed",
                properties: {
                  sessionID: s.info.id,
                  inputID,
                  reason: typeof ev.reason === "string" ? ev.reason : "manual",
                  error: {
                    name: "CompactionError",
                    data: { message: ev.aborted === true ? "Compaction cancelled" : "Compaction failed" },
                  },
                },
              }
            : {
                type: "session.compaction.ended",
                properties: {
                  sessionID: s.info.id,
                  inputID,
                  reason: typeof ev.reason === "string" ? ev.reason : "manual",
                  text: result.summary,
                  recent: "",
                },
              },
        );
        if (ev.aborted !== true && typeof result?.summary === "string" && typeof result.firstKeptEntryId === "string") {
          const messages = this.services.ensureMessages(s);
          let key: string | undefined;
          // compaction_end follows persistence, but its result omits the entry ID.
          if (s.piPath !== undefined) {
            for (const entry of readSessionTree(s.piPath).entries) {
              if (entry.type === "compaction") key = entry.id;
            }
          }
          for (const message of compactionMessages(s, key ?? id("compaction"), result.summary, Date.now(), s.model)) {
            if (messages.some((item) => item.info.id === message.info.id)) continue;
            // Keep a hidden redo branch after the new turn, as appendMessage does.
            const boundary = messages.findIndex((item) => item.info.id === s.tree.revert?.messageID);
            messages.splice(boundary < 0 ? messages.length : boundary, 0, message);
            this.services.emit(s.info.directory, { type: "message.updated", properties: { info: message.info } });
            for (const part of message.parts) this.emitPart(s, part);
          }
        }
        this.services.emit(s.info.directory, { type: "session.updated", properties: { info: s.info } });
        if (s.compactingFromIdle) {
          delete s.compactingFromIdle;
          this.setStatus(s, { type: "idle" });
        }
        return;
      }
      default:
        return;
    }
  }

  private finishStreaming(s: ManagedSession): void {
    if (s.streaming) s.streaming = undefined;
  }

  private onMessageUpdate(s: ManagedSession, ev: Record<string, unknown>): void {
    const streaming = s.streaming;
    if (!streaming) return;
    const ame = ev.assistantMessageEvent as
      | {
          type: string;
          partial?: unknown;
          contentIndex?: number;
          delta?: string;
          content?: string;
          id?: string;
          toolName?: string;
          toolCall?: { id?: string; name?: string; arguments?: Record<string, unknown> };
        }
      | undefined;
    this.onProviderTools(s, ev.message ?? ame?.partial);
    if (!ame || ame.contentIndex === undefined) return;

    if (ame.type.startsWith("toolcall_")) {
      this.onToolcallEvent(s, ame);
      return;
    }

    const dir = s.info.directory;
    // `wire` is pi's content-block name (thinking_* / text_*); `kind` is the
    // OpenCode part type we translate it into. Keep the two separate: deriving
    // the delta/end event names from `kind` produced "reasoning_delta"/"reasoning_end",
    // which pi never emits, so thinking content was silently dropped.
    const wire = ame.type.startsWith("thinking") ? "thinking" : ame.type.startsWith("text") ? "text" : null;
    if (!wire) return; // start / done / error wrappers — no part content
    const kind: "text" | "reasoning" = wire === "thinking" ? "reasoning" : "text";

    let part = streaming.parts.get(ame.contentIndex);
    if (part !== undefined && part.type === "tool") return; // defensive: slot holds a tool part
    if (!part) {
      part = newPart(kind, s.info.id, streaming.message.id);
      streaming.parts.set(ame.contentIndex, part);
      const record = s.messages?.find((m) => m.info.id === streaming.message.id);
      record?.parts.push(part);
      this.emitPart(s, part);
    }
    const textPart = part as OCTextPart | OCReasoningPart;

    if (ame.type === `${wire}_delta` && typeof ame.delta === "string") {
      textPart.text += ame.delta;
      this.services.emit(dir, {
        type: "message.part.delta",
        properties: {
          sessionID: s.info.id,
          messageID: textPart.messageID,
          partID: textPart.id,
          field: "text",
          delta: ame.delta,
        },
      });
      // Append before publishing the authoritative snapshot. Sending another
      // append delta on the snapshot would duplicate text in streaming clients.
      this.emitPart(s, textPart);
    } else if (ame.type === `${wire}_end`) {
      if (typeof ame.content === "string") textPart.text = ame.content;
      if (textPart.time) textPart.time.end = Date.now();
      this.emitPart(s, textPart);
    }
    this.services.emit(dir, { type: "message.updated", properties: { info: streaming.message } });
  }

  private onProviderTools(s: ManagedSession, message: unknown): void {
    const streaming = s.streaming;
    if (!streaming || message === null || typeof message !== "object") return;
    const snapshot = message as { content?: unknown; timestamp?: unknown };
    const timestamp = typeof snapshot.timestamp === "number" ? snapshot.timestamp : streaming.message.time.created;
    const mapped = providerToolParts(snapshot.content, s.info.id, streaming.message.id, timestamp);
    for (const [index, part] of mapped) {
      streaming.parts.set(index, part);
      s.toolByCallId.set(part.callID, part);
      this.emitPart(s, part);
    }
    for (const part of applyProviderToolResults(snapshot.content, s.toolByCallId.values(), timestamp)) {
      this.emitPart(s, part);
    }
    const owner = s.messages?.find((m) => m.info.id === streaming.message.id);
    if (owner && mapped.size > 0) {
      for (const part of mapped.values()) {
        const index = owner.parts.findIndex((existing) => existing.id === part.id);
        if (index < 0) owner.parts.push(part);
        else owner.parts[index] = part;
      }
      // Task expansion replaces the streaming placeholder with one or more
      // cards sharing its callID. Order those cards without reconstructing it.
      const indices = new Map(
        [...streaming.parts].map(([index, part]) => [part.type === "tool" ? part.callID : part.id, index]),
      );
      owner.parts.sort(
        (a, b) =>
          (indices.get(a.type === "tool" ? a.callID : a.id) ?? Infinity) -
          (indices.get(b.type === "tool" ? b.callID : b.id) ?? Infinity),
      );
    }
  }

  /**
   * pi toolcall events → OpenCode tool parts (M2). Live-observed shapes
   * (probe, 2026-09-21):
   *   toolcall_start {contentIndex, id, toolName}
   *   toolcall_delta {contentIndex, delta}          — JSON argument fragments
   *   toolcall_end   {contentIndex, toolCall:{id, name, arguments}}
   * Results arrive separately in turn_end.toolResults
   * [{toolCallId, toolName, content:[{type:"text",text}], isError}].
   */
  private onToolcallEvent(
    s: ManagedSession,
    ame: {
      type: string;
      contentIndex?: number;
      delta?: string;
      id?: string;
      toolName?: string;
      toolCall?: { id?: string; name?: string; arguments?: Record<string, unknown> };
    },
  ): void {
    const streaming = s.streaming;
    if (!streaming || ame.contentIndex === undefined) return;
    const contentIndex = ame.contentIndex;
    const dir = s.info.directory;

    let part = streaming.parts.get(contentIndex) as OCToolPart | undefined;
    if (!part) {
      const callID = ame.toolCall?.id ?? ame.id ?? `call_${contentIndex}`;
      part = {
        id: id("prt"),
        sessionID: s.info.id,
        messageID: streaming.message.id,
        type: "tool",
        callID,
        tool: ame.toolCall?.name ?? ame.toolName ?? "unknown",
        state: { status: "pending", input: {}, raw: "" },
      };
      streaming.parts.set(contentIndex, part);
      const record = s.messages?.find((m) => m.info.id === streaming.message.id);
      record?.parts.push(part);
    }

    if (ame.type === "toolcall_start") {
      if (part.tool === "task") return;
      this.emitPart(s, part);
      return;
    }

    if (ame.type === "toolcall_delta") {
      // Arguments stream as JSON fragments — accumulate in state.raw (the
      // OpenCode pending state is designed exactly for this).
      if (part.state.status === "pending" && typeof ame.delta === "string") {
        (part.state as OCToolStatePending).raw += ame.delta;
        if (part.tool !== "task") this.emitPart(s, part);
      }
      return;
    }

    if (ame.type === "toolcall_end") {
      const args = ame.toolCall?.arguments ?? {};
      const callID = ame.toolCall?.id ?? part.callID;
      const name = ame.toolCall?.name ?? part.tool;
      if (name === "task") {
        part.callID = callID;
        this.services.subagents.start(s, part, args);
        return;
      }
      const mapped = mapTool(name, args);
      part.callID = callID;
      part.tool = mapped.tool;
      part.state = {
        status: "running",
        input: mapped.input,
        title: mapped.title,
        ...(mapped.metadata !== undefined ? { metadata: mapped.metadata } : {}),
        time: { start: Date.now() },
      };
      s.toolByCallId.set(callID, part);
      s.todoBridge ??= new TodoBridge(s.info.id);
      s.todoBridge.track(part, args);
      this.emitPart(s, part);
      this.services.emit(dir, { type: "message.updated", properties: { info: streaming.message } });
      return;
    }

    if (ame.type === "toolcall_error") {
      part.state = {
        status: "error",
        input: part.state.input ?? {},
        error: ame.delta ?? "tool call errored",
        time: { start: Date.now(), end: Date.now() },
      };
      this.emitPart(s, part);
    }
  }

  /** turn_end.toolResults → finalize tool parts (completed / error). */
  private applyToolResults(s: ManagedSession, results: Array<Record<string, unknown>>): void {
    for (const tr of results) {
      const callID = typeof tr.toolCallId === "string" ? tr.toolCallId : undefined;
      if (callID !== undefined && this.services.subagents.result(s, callID, tr, true)) continue;
      const part = callID !== undefined ? s.toolByCallId.get(callID) : undefined;
      if (!part || callID === undefined) continue;
      s.toolByCallId.delete(callID);
      s.todoBridge?.finish(part, tr.isError === true);
      const text = resultText(tr.content);
      const startedAt = part.state.status !== "pending" ? part.state.time.start : Date.now();
      const input = part.state.input ?? {};
      const metadata = {
        ...(part.state.status !== "pending" ? part.state.metadata : {}),
        ...resultMetadata(part.tool, tr),
      };
      const title =
        part.state.status === "running" || part.state.status === "completed"
          ? (part.state.title ?? part.tool)
          : part.tool;
      if (tr.isError === true) {
        part.state = {
          status: "error",
          input,
          error: text || `tool ${part.tool} failed`,
          metadata,
          time: { start: startedAt, end: Date.now() },
        };
      } else {
        part.state = {
          status: "completed",
          input,
          output: text,
          title,
          metadata,
          time: { start: startedAt, end: Date.now() },
        };
      }
      if (touchedFiles([part]).length > 0) this.services.dirtyDiffs.add(s.info.id);
      this.emitPart(s, part);
      const owner = s.messages?.find((m) => m.info.id === part.messageID);
      if (owner) this.services.emit(s.info.directory, { type: "message.updated", properties: { info: owner.info } });
    }
  }

  /** Tool parts that never received a result (abort, crash) must not spin forever. */
  private finalizeDanglingTools(s: ManagedSession): void {
    for (const part of finishProviderToolParts(s.toolByCallId.values(), Date.now())) this.emitPart(s, part);
    for (const part of s.toolByCallId.values()) {
      if (part.state.status === "completed" || part.state.status === "error") continue;
      const startedAt = part.state.status !== "pending" ? part.state.time.start : Date.now();
      part.state = {
        status: "error",
        input: part.state.input ?? {},
        error: "run ended without a tool result",
        time: { start: startedAt, end: Date.now() },
      };
      this.emitPart(s, part);
    }
    s.toolByCallId.clear();
  }
}
