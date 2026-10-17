import { createHash } from "node:crypto";
import type { ManagedSession } from "./sessions.js";
import type { OCMessageWithParts, OCModelRef, OCToolPart } from "./types.js";
import { resultText, type ToolResult } from "./tool-map.js";

export interface BackgroundResult {
  /** Content hash; identical notifications are told apart by `backgroundID`'s occurrence index. */
  readonly key: string;
  readonly kind: "terminal" | "eval";
  readonly callID: string;
  readonly title: string;
  readonly output: string;
  readonly failed: boolean;
}

/** Raw RPC capture of installed omo-ai 5.1.33 / senpi runtime, 2026-10-17. */
export function backgroundResult(customType: unknown, content: unknown): BackgroundResult | undefined {
  if (customType !== "senpi-terminal:notification" && customType !== "senpi-codemode:notification") return undefined;
  const raw = typeof content === "string" ? content : resultText(content);
  const key = createHash("sha256").update(`${customType}\n${raw}`).digest("hex").slice(0, 16);
  const text = raw.replaceAll(/<\/?system-reminder>/g, "").replace(/^\n/, "");
  const newline = text.indexOf("\n");
  const header = newline < 0 ? text : text.slice(0, newline);
  const body = newline < 0 ? "" : text.slice(newline + 1);
  if (customType === "senpi-terminal:notification") {
    const match = /^Background terminal session (\S+) finished: (.+?)\.?$/.exec(header);
    if (match?.[1] === undefined || match[2] === undefined) return undefined;
    return {
      key,
      kind: "terminal",
      callID: match[1],
      title: `${match[1]} finished: ${match[2]}`,
      output: body.replace(/^Final output:\r?\n?/, ""),
      failed: false,
    };
  }
  const match = /^Detached eval cell (\S+)(?: \([^)]+\))? (completed|failed|error)\b.*$/i.exec(header);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return {
    key,
    kind: "eval",
    callID: match[1],
    title: header.replace(/^Detached eval cell /, "").replace(/\.$/, ""),
    output: body,
    failed: match[2].toLowerCase() !== "completed",
  };
}

/** Retain only the command needed to label a later terminal completion. */
export function backgroundCommands(result: ToolResult): Record<string, unknown> {
  const details = result.details;
  if (details === null || typeof details !== "object" || !("toolCalls" in details)) return {};
  if (!Array.isArray(details.toolCalls)) return {};
  const commands: Record<string, string> = {};
  for (const call of details.toolCalls) {
    if (call?.name !== "bash" || typeof call.resultPreview !== "string" || typeof call.args?.command !== "string")
      continue;
    const id = /\bID:\s*(bash_\d+)\b/.exec(call.resultPreview)?.[1];
    if (id !== undefined) commands[id] = call.args.command;
  }
  return Object.keys(commands).length === 0 ? {} : { backgroundCommands: commands };
}

export function completeBackgroundEval(
  messages: readonly OCMessageWithParts[],
  result: BackgroundResult,
  completed: number,
): OCToolPart | undefined {
  if (result.kind !== "eval") return undefined;
  for (const message of messages) {
    const part = message.parts.find(
      (part): part is OCToolPart => part.type === "tool" && part.callID === result.callID,
    );
    if (part === undefined) continue;
    const state = part.state;
    const time = { start: state.status === "pending" ? completed : state.time.start, end: completed };
    const metadata = state.status === "pending" ? {} : (state.metadata ?? {});
    part.state = result.failed
      ? { status: "error", input: state.input, error: result.output, metadata, time }
      : {
          status: "completed",
          input: state.input,
          output: result.output,
          title: "title" in state ? (state.title ?? "eval") : "eval",
          metadata,
          time,
        };
    return part;
  }
  return undefined;
}

/**
 * OmO persists these notifications but sends no entry_appended frame for them, so the live
 * path never learns the native entry ID (raw RPC capture of installed omo-ai 5.1.33 / senpi
 * runtime, 2026-10-17). Live, history and entry binding all derive the same ID from the
 * content and its occurrence count in conversation order instead.
 */
export function backgroundID(messages: readonly OCMessageWithParts[], result: BackgroundResult): string {
  const prefix = `msg_background_${result.key}_`;
  return `${result.key}_${messages.filter((message) => message.info.id.startsWith(prefix)).length}`;
}

export function backgroundMessage(
  s: Pick<ManagedSession, "info" | "messages">,
  result: BackgroundResult,
  entry: { id: string; created: number; model: OCModelRef; agent: string },
): OCMessageWithParts {
  const messages = s.messages ?? [];
  let command = result.callID;
  if (result.kind === "terminal") {
    for (const message of messages.toReversed()) {
      for (const part of message.parts) {
        if (part.type !== "tool" || part.state.status === "pending") continue;
        const commands = part.state.metadata?.backgroundCommands;
        const nested =
          commands !== null && typeof commands === "object" && result.callID in commands
            ? Reflect.get(commands, result.callID)
            : undefined;
        const output =
          part.state.status === "completed" ? part.state.output : part.state.status === "error" ? part.state.error : "";
        const original =
          typeof nested === "string"
            ? nested
            : /\bID:\s*(bash_\d+)\b/.exec(output)?.[1] === result.callID
              ? part.state.input.command
              : undefined;
        if (typeof original === "string") {
          command += `\n${original}`;
          break;
        }
      }
      if (command !== result.callID) break;
    }
  }
  const sessionID = s.info.id;
  const messageID = `msg_background_${entry.id}`;
  return {
    info: {
      id: messageID,
      sessionID,
      role: "assistant",
      parentID: messages.findLast((message) => message.info.role === "user")?.info.id ?? "",
      time: { created: entry.created, completed: entry.created },
      modelID: entry.model.modelID,
      providerID: entry.model.providerID,
      mode: entry.agent,
      path: { cwd: s.info.directory, root: s.info.directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "stop",
    },
    parts: [
      {
        id: `prt_background_${entry.id}`,
        sessionID,
        messageID,
        type: "tool",
        tool: "bash",
        callID: `call_background_${entry.id}`,
        state: {
          status: "completed",
          input: { command },
          output: result.output,
          title: result.title,
          metadata: {},
          time: { start: entry.created, end: entry.created },
        },
      },
    ],
  };
}
