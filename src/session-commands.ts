import { randomUUID } from "node:crypto";
import { PiRpcClient, UpstreamProtocolError } from "./pi-rpc.js";
import { getAgentName } from "./agent-name.js";
import { nativePromptInput, parsePromptParts } from "./prompt-parts.js";
import type { OCPromptPart } from "./types.js";
import type { ManagedSession, SessionManager } from "./sessions.js";
import type {
  OCAssistantMessage,
  OCEvent,
  OCMessageWithParts,
  OCToolPart,
  OCTextPart,
  OCUserMessage,
} from "./types.js";

type CommandDescriptor = { name: string; description: string; template: "" };
type SlashCommandInput = { command: string; arguments: string; messageID?: string; parts?: OCPromptPart[] };
type ShellResult = { output: string; exitCode: number | null; cancelled: boolean; truncated: boolean };
export type ShellMessage = OCMessageWithParts & { info: OCAssistantMessage; parts: [OCToolPart] };
type ShellUserMessage = OCMessageWithParts & { info: OCUserMessage; parts: [OCTextPart] };

type ShareNoticeMessage = OCMessageWithParts & { info: OCAssistantMessage; parts: [OCTextPart] };

type ShellExecution = { kind: "completed"; message: ShellMessage } | { kind: "error"; message: string };

interface ShellCommandContext {
  sessions: SessionManager;
  session: ManagedSession;
  command: string;
  emit: (directory: string, event: OCEvent) => void;
}

interface ShareNoticeContext {
  sessions: SessionManager;
  session: ManagedSession;
  emit: (directory: string, event: OCEvent) => void;
}

type CompactResult = { kind: "compacted" } | { kind: "error"; message: string };

/**
 * Live output kept on a running shell card: the newest part. Every snapshot carries all of it, so it is kept small;
 * the finished card gets OmO's full output.
 */
const LIVE_SHELL_OUTPUT_CHARS = 64 * 1024;
/** Output chunks arriving within this window reach clients as one card snapshot. */
const LIVE_SHELL_OUTPUT_FLUSH_MS = 100;

/** Appends a chunk and keeps the newest `limit` chars, starting at a line boundary when one leaves anything. */
export function appendLiveOutput(previous: string, delta: string, limit = LIVE_SHELL_OUTPUT_CHARS): string {
  const output = previous + delta;
  if (output.length <= limit) return output;
  const tail = output.slice(output.length - limit);
  const lineStart = tail.indexOf("\n") + 1;
  return lineStart > 0 && lineStart < tail.length ? tail.slice(lineStart) : tail;
}

// OpenChamber drops rejected Share actions, so emit a visible session notice too.
export const unsupportedShare = {
  name: "UnsupportedError",
  data: { message: "Sharing is not available with OmO" },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

const SHELL_TITLE_MAX_CHARS = 60;
const SHELL_TITLE_TRUNCATED_CHARS = 57;

export function shellTitle(command: string): string {
  const short = command.length > SHELL_TITLE_MAX_CHARS ? `${command.slice(0, SHELL_TITLE_TRUNCATED_CHARS)}…` : command;
  return `bash: ${short}`;
}

function assistantMessage(session: ManagedSession): OCAssistantMessage {
  const created = Date.now();
  const messages = session.messages ?? [];
  const boundary = messages.findIndex((message) => message.info.id === session.tree.revert?.messageID);
  const visible = boundary < 0 ? messages : messages.slice(0, boundary);
  const parentID = visible.findLast((message) => message.info.role === "user")?.info.id ?? "";
  return {
    id: id("msg"),
    sessionID: session.info.id,
    role: "assistant",
    time: { created },
    parentID,
    modelID: session.model?.modelID ?? "unknown",
    providerID: session.model?.providerID ?? "unknown",
    mode: getAgentName(),
    path: { cwd: session.info.directory, root: session.info.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

function shellEvent(context: ShellCommandContext, event: OCEvent): void {
  context.emit(context.session.info.directory, event);
}

function setShellStatus(context: ShellCommandContext, type: "busy" | "idle"): void {
  const { session, sessions } = context;
  session.status = { type };
  sessions.lifecycle.touch(session);
  shellEvent(context, {
    type: "session.status",
    properties: { sessionID: session.info.id, status: session.status },
  });
  if (type === "idle") {
    shellEvent(context, { type: "session.idle", properties: { sessionID: session.info.id } });
  }
}

function emitShellMessage(context: ShellCommandContext, message: ShellMessage): void {
  shellEvent(context, { type: "message.updated", properties: { info: message.info } });
  shellEvent(context, { type: "message.part.updated", properties: { part: message.parts[0] } });
}

function mapCommands(data: unknown): CommandDescriptor[] {
  if (!isRecord(data) || !Array.isArray(data.commands)) {
    throw new Error("OmO get_commands returned an invalid command list");
  }
  return data.commands.map((command: unknown) => {
    if (!isRecord(command) || typeof command.name !== "string") {
      throw new Error("OmO get_commands returned a command without a name");
    }
    return {
      name: command.name,
      description: typeof command.description === "string" ? command.description : "",
      template: "",
    };
  });
}

const COMMAND_CACHE_TTL_MS = 5_000;
const commandCache = new Map<string, { expiresAt: number; promise: Promise<CommandDescriptor[]> }>();

export function getCommands(directory: string): Promise<CommandDescriptor[]> {
  const now = Date.now();
  for (const [key, entry] of commandCache) {
    if (entry.expiresAt <= now) commandCache.delete(key);
  }
  const existing = commandCache.get(directory);
  if (existing) return existing.promise;
  const entry = {
    expiresAt: Infinity,
    promise: (async () => {
      const pi = new PiRpcClient({ cwd: directory, args: ["--no-session"] });
      try {
        const response = await pi.command<unknown>({ type: "get_commands" });
        if (!response.success) throw new Error(response.error ?? "OmO get_commands failed");
        return mapCommands(response.data);
      } finally {
        await pi.dispose();
      }
    })().then(
      (commands) => {
        entry.expiresAt = Date.now() + COMMAND_CACHE_TTL_MS;
        return commands;
      },
      (error: unknown) => {
        commandCache.delete(directory);
        throw error;
      },
    ),
  };
  commandCache.set(directory, entry);
  return entry.promise;
}

export function parseSlashCommand(value: unknown): SlashCommandInput | undefined {
  if (!isRecord(value) || typeof value.command !== "string" || value.command.trim() === "") return undefined;
  if (typeof value.arguments !== "string") return undefined;
  // OpenChamber inserts the command's user message optimistically under this id.
  const messageID = typeof value.messageID === "string" && value.messageID !== "" ? value.messageID : undefined;
  const parts = parsePromptParts(value.parts);
  nativePromptInput("", parts);
  return {
    command: value.command,
    arguments: value.arguments,
    ...(messageID ? { messageID } : {}),
    ...(parts.length > 0 ? { parts } : {}),
  };
}

/**
 * OmO never auto-titles a first prompt that starts with "/", so a session opened
 * with `/skill:plan Build the importer` kept its first-message title. Title from
 * the command's arguments instead; a bare command has nothing to title from.
 */
export function slashTitlePrompt(text: string): { sessionTitlePrompt?: string } {
  const match = /^\s*\/\S+\s+([\s\S]*\S)/.exec(text);
  return match?.[1] !== undefined && !match[1].startsWith("/") ? { sessionTitlePrompt: match[1] } : {};
}

/**
 * OpenCode clients invoke skills as `/<name>`, but OmO only knows them as `/skill:<name>` and rejects
 * the bare form with `unknown_command`. Return the rewritten prompt when OmO suggests that exact skill.
 */
export function skillCommandText(
  text: string,
  failure: { errorCode?: string; errorData?: unknown },
): string | undefined {
  if (failure.errorCode !== "unknown_command" || !isRecord(failure.errorData)) return undefined;
  const { command, suggestions } = failure.errorData;
  if (typeof command !== "string" || !Array.isArray(suggestions) || !suggestions.includes(`skill:${command}`)) {
    return undefined;
  }
  const match = /^\/(\S+)([\s\S]*)$/.exec(text);
  return match?.[1] === command ? `/skill:${command}${match[2]}` : undefined;
}

function slashCommandPrompt(input: SlashCommandInput): string {
  return input.arguments === "" ? `/${input.command}` : `/${input.command} ${input.arguments}`;
}

export async function runSlashCommand(
  sessions: SessionManager,
  sessionId: string,
  input: SlashCommandInput,
): Promise<OCMessageWithParts | undefined> {
  const text = slashCommandPrompt(input);
  await sessions.prompt(
    sessionId,
    text,
    undefined,
    false,
    input.messageID,
    "steer",
    input.parts ? [{ type: "text", text }, ...input.parts] : undefined,
  );
  await sessions.reloadMessages(sessionId);
  const messages = sessions.messages(sessionId) ?? [];
  return messages.findLast((message) => message.info.role === "assistant") ?? messages[messages.length - 1];
}

export function parseShellCommand(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.command !== "string" || value.command.trim() === "") return undefined;
  return value.command;
}

function parseShellResult(value: unknown): ShellResult {
  if (
    !isRecord(value) ||
    typeof value.output !== "string" ||
    (typeof value.exitCode !== "number" &&
      value.exitCode !== null &&
      !(value.cancelled === true && value.exitCode === undefined)) ||
    typeof value.cancelled !== "boolean" ||
    typeof value.truncated !== "boolean"
  ) {
    throw new UpstreamProtocolError("OmO bash returned an invalid result");
  }
  return {
    output: value.output,
    exitCode: typeof value.exitCode === "number" ? value.exitCode : null,
    cancelled: value.cancelled,
    truncated: value.truncated,
  };
}

export function createShellMessage(session: ManagedSession, command: string): ShellMessage {
  const info = assistantMessage(session);
  info.parentID = `${info.id}u`;
  info.id = `${info.id}z`;
  const created = info.time.created;
  const part: OCToolPart = {
    id: id("prt"),
    sessionID: session.info.id,
    messageID: info.id,
    type: "tool",
    callID: id("call"),
    tool: "bash",
    state: {
      status: "running",
      input: { command, description: command },
      title: shellTitle(command),
      metadata: {},
      time: { start: created },
    },
  };
  return { info, parts: [part] };
}

export function shellUserMessage(message: ShellMessage): ShellUserMessage {
  const { info } = message;
  return {
    info: {
      id: info.parentID,
      sessionID: info.sessionID,
      role: "user",
      time: { created: info.time.created },
      agent: info.mode,
      model: { providerID: info.providerID, modelID: info.modelID },
    },
    parts: [
      {
        id: `${message.parts[0].id}u`,
        sessionID: info.sessionID,
        messageID: info.parentID,
        type: "text",
        text: "The following tool was executed by the user",
        synthetic: true,
        time: { start: info.time.created, end: info.time.created },
      },
    ],
  };
}

/** An adapter-authored notice card; `created` places a replayed notice at its original time. */
export function noticeMessage(
  session: ManagedSession,
  messageText: string,
  error?: OCAssistantMessage["error"],
  created?: number,
): ShareNoticeMessage {
  const info = assistantMessage(session);
  if (created !== undefined) info.time.created = created;
  info.time.completed = info.time.created;
  if (error) info.error = error;
  const part: OCTextPart = {
    id: id("prt"),
    sessionID: session.info.id,
    messageID: info.id,
    type: "text",
    text: messageText,
    time: { start: info.time.created, end: info.time.created },
  };
  return { info, parts: [part] };
}

export function announceSessionNotice(
  context: ShareNoticeContext,
  messageText: string,
  error?: OCAssistantMessage["error"],
): void {
  const { session, sessions, emit } = context;
  if (!sessions.messages(session.info.id)) return;
  const message = noticeMessage(session, messageText, error);
  const [part] = message.parts;
  const { info } = message;
  sessions.appendMessage(session.info.id, message);
  emit(session.info.directory, { type: "message.updated", properties: { info } });
  emit(session.info.directory, { type: "message.part.updated", properties: { part } });
}

export function announceSessionError(context: ShareNoticeContext, errorName: string, messageText: string): void {
  announceSessionNotice(context, messageText, { name: errorName, data: { message: messageText } });
  context.emit(context.session.info.directory, {
    type: "session.error",
    properties: { sessionID: context.session.info.id, error: { name: errorName, data: { message: messageText } } },
  });
}

export function completeShellMessage(message: ShellMessage, command: string, result: ShellResult): void {
  const [part] = message.parts;
  const started = part.state.status === "pending" ? Date.now() : part.state.time.start;
  part.state = {
    status: "completed",
    input: { command, description: command },
    output: result.output,
    title: shellTitle(command),
    metadata: { exitCode: result.exitCode, cancelled: result.cancelled, truncated: result.truncated },
    time: { start: started, end: Date.now() },
  };
  message.info.time.completed = Date.now();
}

export function failShellMessage(
  message: ShellMessage,
  command: string,
  error: string,
  metadata?: Record<string, unknown>,
): void {
  const [part] = message.parts;
  const started = part.state.status === "pending" ? Date.now() : part.state.time.start;
  part.state = {
    status: "error",
    input: { command, description: command },
    error,
    ...(metadata !== undefined ? { metadata } : {}),
    time: { start: started, end: Date.now() },
  };
  message.info.time.completed = Date.now();
}

export async function compactSession(sessions: SessionManager, sessionId: string): Promise<CompactResult> {
  const response = await sessions.sessionRpc(sessionId, { type: "compact" });
  if (!response.success) return { kind: "error", message: response.error ?? "OmO compact failed" };
  return { kind: "compacted" };
}

export async function runShellCommand(context: ShellCommandContext): Promise<ShellExecution> {
  const { session, sessions, command } = context;
  sessions.messages(session.info.id);
  const message = createShellMessage(session, command);
  const user = shellUserMessage(message);
  const shell = {
    id: message.parts[0].callID,
    command,
    cwd: session.info.directory,
    shell: "bash",
    file: "",
    metadata: {},
    time: { started: message.info.time.created },
  };
  const dispatch = (session.tree.shellDispatch ??= {});
  dispatch[message.info.id] = false;
  const afterEntryId = session.tree.leafId ?? null;
  const controller = new AbortController();
  let interrupted = false;
  // OmO streams user bash output as `bash_execution_update {id: executionId, delta}` frames before its reply
  // (agent-session.js `executeBash`; real RPC probe on 2026-10-28). Showing them live lets the user act on
  // output while the command waits, such as a login link.
  let streaming: PiRpcClient | undefined;
  let liveOutput = "";
  let flush: NodeJS.Timeout | undefined;
  const onOutput = (event: Record<string, unknown>): void => {
    const [part] = message.parts;
    if (event.type !== "bash_execution_update" || event.id !== part.callID || typeof event.delta !== "string") return;
    if (part.state.status !== "running") return;
    liveOutput = appendLiveOutput(liveOutput, event.delta);
    part.state.metadata = { ...part.state.metadata, output: liveOutput };
    flush ??= setTimeout(() => {
      flush = undefined;
      if (part.state.status === "running") shellEvent(context, { type: "message.part.updated", properties: { part } });
    }, LIVE_SHELL_OUTPUT_FLUSH_MS);
  };
  // A stopped card keeps what the command printed, such as a link the user still needs.
  const streamed = (): { output?: string } => (liveOutput === "" ? {} : { output: liveOutput });
  session.cancelShell = (byRestart = false) => {
    interrupted = byRestart;
    delete session.cancelShell;
    // Agent abort does not stop user bash. Dispatch the dedicated RPC first,
    // then release our waiter; a correlated late response is discarded.
    if (dispatch[message.info.id]) session.pi?.abortBash();
    controller.abort();
  };
  sessions.appendMessage(session.info.id, user);
  sessions.appendMessage(session.info.id, message);
  setShellStatus(context, "busy");
  shellEvent(context, { type: "message.updated", properties: { info: user.info } });
  shellEvent(context, { type: "message.part.updated", properties: { part: user.parts[0] } });
  emitShellMessage(context, message);
  shellEvent(context, {
    type: "session.shell.started",
    properties: { sessionID: session.info.id, shell: { ...shell, status: "running" } },
  });
  try {
    await sessions.update(session.info.id, {});
    const response = await sessions.sessionRpc<unknown>(
      session.info.id,
      { type: "bash", command, executionId: message.parts[0].callID },
      controller.signal,
      () => {
        dispatch[message.info.id] = true;
        streaming = session.pi;
        streaming?.onEvent(onOutput);
        // Only actual dispatch admissions are durable; queued attempts stay in the live cache.
        (session.tree.localShellTurns ??= []).push({ afterEntryId, messages: [user, message] });
        // A native result can land beyond the last synchronized leaf.
        if (!session.tree.revert) delete session.tree.leafId;
        void sessions.update(session.info.id, {}).catch((error: unknown) => controller.abort(error));
      },
    );
    if (controller.signal.aborted) throw controller.signal.reason;
    if (!response.success) {
      const error = response.error ?? "OmO bash failed";
      failShellMessage(message, command, error);
      emitShellMessage(context, message);
      return { kind: "error", message: error };
    }
    const result = parseShellResult(response.data);
    if (result.cancelled) {
      failShellMessage(message, command, "Command cancelled", {
        ...streamed(),
        cancelled: true,
        exitCode: result.exitCode,
      });
    } else {
      completeShellMessage(message, command, result);
    }
    emitShellMessage(context, message);
    return { kind: "completed", message };
  } catch (error) {
    if (controller.signal.aborted) {
      failShellMessage(message, command, interrupted ? "Interrupted by restart" : "Command cancelled", {
        ...streamed(),
        ...(interrupted ? { interrupted: true } : { cancelled: true }),
      });
      emitShellMessage(context, message);
      return { kind: "completed", message };
    }
    failShellMessage(message, command, error instanceof Error ? error.message : String(error));
    emitShellMessage(context, message);
    throw error;
  } finally {
    streaming?.off("event", onOutput);
    clearTimeout(flush);
    delete session.cancelShell;
    const state = message.parts[0].state;
    const metadata = state.status === "pending" ? undefined : state.metadata;
    const output = state.status === "completed" ? state.output : state.status === "error" ? state.error : "";
    const size = Buffer.byteLength(output);
    shellEvent(context, {
      type: "session.shell.ended",
      properties: {
        sessionID: session.info.id,
        shell: {
          ...shell,
          status: state.status === "completed" ? "exited" : "killed",
          ...(typeof metadata?.exitCode === "number" ? { exit: metadata.exitCode } : {}),
          time: { ...shell.time, completed: message.info.time.completed ?? Date.now() },
        },
        output: { output, cursor: size, size, truncated: metadata?.truncated === true },
      },
    });
    setShellStatus(context, "idle");
    await sessions.update(session.info.id, {});
  }
}
