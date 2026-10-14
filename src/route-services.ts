/** Shared services and prompt/model adaptation for both API versions. */

import type { IncomingMessage } from "node:http";
import { statSync } from "node:fs";
import { RequestBodyError } from "./http.js";
import type { SessionManager, ManagedSession } from "./sessions.js";
import type { Catalog } from "./catalog.js";
import type { ModelSelection } from "./thinking-levels.js";
import type { OCEvent, OCMessageWithParts, OCPromptPart } from "./types.js";
import type { TodoUpdated } from "./todo-bridge.js";
import { getAgentName, getExposedAgentNames } from "./agent-name.js";
import { agentDefaults } from "./catalog.js";
import {
  announceSessionError,
  parseShellCommand,
  parseSlashCommand,
  runShellCommand,
  runSlashCommand,
} from "./session-commands.js";
import { envSetting } from "./config.js";

export interface RouteServices {
  readonly sessions: SessionManager;
  readonly defaultDirectory: string;
  readonly url: string;
  readonly body: (req: IncomingMessage) => Promise<unknown>;
  readonly catalog: () => Promise<Catalog>;
  readonly broadcast: (directory: string, event: OCEvent | TodoUpdated) => void;
}

// This connector is not opencode — it only implements an OpenCode API subset.
// OpenChamber reads /global/health's `version` as the installed opencode version
// and offers an update when it trails the latest release. Advertising the SDK
// contract version (1.18.31) made every adapter profile look permanently
// outdated, and the resulting "update" then failed with "Unknown installation
// method". Report no version so upgrade-status returns available:null and the UI
// shows no prompt. Set ANTECHAMBER_OPENCODE_COMPAT_VERSION to advertise one on purpose.
export const OPENCODE_COMPAT_VERSION = envSetting("OPENCODE_COMPAT_VERSION")?.trim() || null;

export function numberParam(value: string | null): number | undefined {
  if (value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function sessionDirectory(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0"))
    throw new RequestBodyError(400, "directory must be a nonempty path");
  try {
    if (!statSync(value).isDirectory())
      throw new RequestBodyError(400, "directory does not exist or is not a directory");
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR"))
      throw new RequestBodyError(400, "directory does not exist or is not a directory");
    throw error;
  }
  return value;
}

export function sessionMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new RequestBodyError(400, "metadata must be an object");
  return Object.fromEntries(Object.entries(value));
}

/** v2 prompt bodies carry `model:{providerID, id|modelID}`; adapt to OCModelRef. */
export function modelRefFromBody(
  model: { providerID?: string; id?: string; modelID?: string; variant?: string } | undefined,
  variant?: string,
): ModelSelection | undefined {
  if (!model || typeof model.providerID !== "string") return undefined;
  const modelID =
    typeof model.id === "string" ? model.id : typeof model.modelID === "string" ? model.modelID : undefined;
  if (modelID === undefined) return undefined;
  const level = variant ?? model.variant;
  return { providerID: model.providerID, modelID, ...(typeof level === "string" ? { variant: level } : {}) };
}

/** Both async APIs acknowledge admission; failures must reach SSE and history. */
export function promptAsync(
  services: RouteServices,
  session: ManagedSession,
  text: string,
  model?: ModelSelection,
  noReply = false,
  messageID?: string,
  delivery: "steer" | "queue" = "steer",
  parts?: readonly OCPromptPart[],
): void {
  void services.sessions
    .prompt(session.info.id, text, model, noReply, messageID, delivery, parts)
    .catch((error: unknown) => {
      announceSessionError(
        { sessions: services.sessions, session, emit: services.broadcast },
        error instanceof Error ? error.name : "UnknownError",
        error instanceof Error ? error.message : String(error),
      );
    });
}

export type ShellRouteResult =
  | { kind: "input" }
  | { kind: "busy" }
  | { kind: "error"; message: string }
  | { kind: "success"; message: OCMessageWithParts };

/** Run a shell command consistently while leaving each API version to shape its response envelope. */
export async function runSessionShell(
  services: RouteServices,
  session: ManagedSession,
  body: unknown,
): Promise<ShellRouteResult> {
  const command = parseShellCommand(body);
  if (command === undefined) return { kind: "input" };
  if (session.status.type !== "idle") return { kind: "busy" };
  const result = await runShellCommand({
    sessions: services.sessions,
    session,
    command,
    emit: services.broadcast,
  });
  return result.kind === "error" ? result : { kind: "success", message: result.message };
}

export type SlashRouteResult = { kind: "input" } | { kind: "success"; message: OCMessageWithParts | undefined };

/** Parse and dispatch slash commands once for both protocol versions. */
export async function runSessionSlash(
  services: RouteServices,
  sessionID: string,
  body: unknown,
): Promise<SlashRouteResult> {
  const input = parseSlashCommand(body);
  if (input === undefined) return { kind: "input" };
  return { kind: "success", message: await runSlashCommand(services.sessions, sessionID, input) };
}

export async function agentDescriptors(services: RouteServices) {
  const piName = getAgentName();
  const defaults = agentDefaults(await services.catalog());
  return getExposedAgentNames().map((name) => ({
    name,
    description:
      name === piName
        ? `${piName} (pi coding agent via antechamber)`
        : `${name} — ${piName} (pi coding agent via antechamber)`,
    mode: "primary",
    hidden: name === "build" && piName !== "build",
    options: {},
    native: true,
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
    prompt: "",
    temperature: 0,
    ...defaults,
  }));
}
