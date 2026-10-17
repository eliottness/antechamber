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
    for (const id of launchedShells(call.resultPreview)) commands[id] = call.args.command;
  }
  return Object.keys(commands).length === 0 ? {} : { backgroundCommands: commands };
}

/**
 * Background shells a result says it left running (raw RPC captures, 2026-10-17). A cell's output is
 * trimmed to its tail, which can cut the "with ID" line and leave only the bash_output hint.
 */
const LAUNCHED =
  /\b(?:running in background|auto-detached to background) with ID:\s*(bash_\d+)\b|Use bash_output\(\{ bash_id: "(bash_\d+)" \}\) only to peek/g;

export function launchedShells(text: string): string[] {
  return [...new Set([...text.matchAll(LAUNCHED)].map((match) => match[1] ?? match[2] ?? "").filter(Boolean))];
}

/**
 * What a tool result leaves running: the background shells it started, and the eval cell
 * itself when it detached. The card keeps running until each one reports finishing.
 */
export function backgroundWaits(callID: string, text: string, result?: ToolResult): string[] {
  const waits = new Set<string>();
  for (const id of launchedShells(text)) waits.add(id);
  const commands = result === undefined ? undefined : backgroundCommands(result).backgroundCommands;
  if (commands !== null && typeof commands === "object") for (const id of Object.keys(commands)) waits.add(id);
  if (/^Eval cell \S+ detached and is running/.test(text)) waits.add(callID);
  return [...waits];
}

interface Final {
  output: string;
  failed: boolean;
}

function waitsOf(part: OCToolPart): string[] {
  const waits = part.state.status === "running" ? part.state.metadata?.backgroundWaits : undefined;
  return Array.isArray(waits) ? waits.filter((id): id is string => typeof id === "string") : [];
}

/** Keep a finished card running, with its result already shown, until `waits` report finishing. */
export function holdForBackground(part: OCToolPart, waits: string[], final: Final): void {
  const state = part.state;
  if (state.status === "pending" || waits.length === 0) return;
  const title = state.status === "running" || state.status === "completed" ? state.title : undefined;
  part.state = {
    status: "running",
    input: state.input,
    ...(title !== undefined ? { title } : {}),
    metadata: { ...state.metadata, output: final.output, backgroundWaits: waits, backgroundFinal: final },
    time: { start: state.time.start },
  };
}

function finish(part: OCToolPart, final: Final, at: number): void {
  const state = part.state;
  if (state.status === "pending") return;
  const { backgroundWaits: _waits, backgroundFinal: _final, output: _output, ...metadata } = state.metadata ?? {};
  const time = { start: state.time.start, end: Math.max(at, state.time.start) };
  const title = state.status === "running" || state.status === "completed" ? (state.title ?? part.tool) : part.tool;
  part.state = final.failed
    ? { status: "error", input: state.input, error: final.output || `tool ${part.tool} failed`, metadata, time }
    : { status: "completed", input: state.input, output: final.output, title, metadata, time };
}

function finalOf(part: OCToolPart): Final | undefined {
  const final = part.state.status === "running" ? part.state.metadata?.backgroundFinal : undefined;
  if (final === null || typeof final !== "object" || !("output" in final) || !("failed" in final)) return undefined;
  return { output: String(final.output), failed: final.failed === true };
}

/** `id` finished at `at`: drop it from every card waiting on it; cards left with nothing to wait on end. */
export function releaseBackground(messages: readonly OCMessageWithParts[], id: string, at: number): OCToolPart[] {
  const changed: OCToolPart[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool" || part.state.status !== "running") continue;
      const waits = waitsOf(part);
      if (!waits.includes(id)) continue;
      const left = waits.filter((wait) => wait !== id);
      const final = finalOf(part);
      if (left.length > 0 || final === undefined)
        part.state.metadata = { ...part.state.metadata, backgroundWaits: left };
      else finish(part, final, at);
      changed.push(part);
    }
  }
  return changed;
}

/** Nothing can still be running (the agent exited, or history is rebuilt): end every waiting card. */
export function settleBackground(messages: readonly OCMessageWithParts[], at: number): OCToolPart[] {
  const changed: OCToolPart[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool") continue;
      const final = finalOf(part);
      if (final === undefined) continue;
      finish(part, final, at);
      changed.push(part);
    }
  }
  return changed;
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
    const final = { output: result.output, failed: result.failed };
    // The cell is done; shells it moved to the background may still run.
    const waits = [
      ...waitsOf(part).filter((wait) => wait !== result.callID),
      ...backgroundWaits(result.callID, result.output),
    ];
    const remaining = [...new Set(waits)];
    if (part.state.status !== "pending" && remaining.length > 0) {
      holdForBackground(part, remaining, final);
      if (part.state.status === "running") part.state.metadata = { ...part.state.metadata, backgroundWaits: remaining };
    } else finish(part, final, completed);
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
  // The card that launched the command started it, so the finished card shows the real run time.
  let started = entry.created;
  if (result.kind === "terminal") {
    // Newest first, stopping at an earlier finish of the same id: OmO numbers shells from bash_1 again
    // after its process restarts, so an older launch of that id is not this command's.
    search: for (const message of messages.toReversed()) {
      for (const part of message.parts.toReversed()) {
        if (part.type !== "tool" || part.state.status === "pending") continue;
        if (
          part.callID.startsWith("call_background_") &&
          part.state.input.command?.toString().split("\n")[0] === result.callID
        )
          break search;
        const commands = part.state.metadata?.backgroundCommands;
        const nested =
          commands !== null && typeof commands === "object" && result.callID in commands
            ? Reflect.get(commands, result.callID)
            : undefined;
        const held = part.state.metadata?.output;
        const output =
          part.state.status === "completed"
            ? part.state.output
            : part.state.status === "error"
              ? part.state.error
              : typeof held === "string"
                ? held
                : "";
        const original =
          typeof nested === "string"
            ? nested
            : launchedShells(output).includes(result.callID)
              ? (part.state.input.command ?? part.state.input.code)
              : undefined;
        if (typeof original === "string") {
          command += `\n${original}`;
          started = Math.min(part.state.time.start, entry.created);
          break search;
        }
      }
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
          time: { start: started, end: entry.created },
        },
      },
    ],
  };
}
