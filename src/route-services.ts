/** Shared services and prompt/model adaptation for both API versions. */

import type { IncomingMessage } from "node:http";
import type { SessionManager, ManagedSession } from "./sessions.js";
import type { Catalog } from "./catalog.js";
import type { ModelSelection } from "./thinking-levels.js";
import type { OCEvent } from "./types.js";
import type { TodoUpdated } from "./todo-bridge.js";
import { announceSessionError } from "./session-commands.js";
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
): void {
  void services.sessions.prompt(session.info.id, text, model, noReply, messageID, delivery).catch((error: unknown) => {
    announceSessionError(
      { sessions: services.sessions, session, emit: services.broadcast },
      error instanceof Error ? error.name : "UnknownError",
      error instanceof Error ? error.message : String(error),
    );
  });
}
