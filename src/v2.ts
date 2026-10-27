/**
 * opencode v2 API translation layer.
 *
 * NOTE: this file used to be kept byte-identical with openchamber-mcode's
 * v2.ts and no longer is — `model.changed` → `session.model.selected` and the
 * honest /api/model/default resolution are pi-side additions. Mirror them to
 * mcode only together with an equivalent `Catalog.default`; without it mcode
 * would lose its default-model resolution entirely.
 *
 * The connectors implement the v1 API natively (types.ts / sessions.ts). This
 * module reshapes that same data into the v2 wire contract that the OpenChamber
 * 2.0.4 web UI speaks:
 *
 *   - HTTP resources: v2 Session / Message (content blocks), the flattened
 *     model catalog served by /api/model, and the bootstrap Location/Info.
 *   - SSE: a stateful translator from the connector's internal OCEvent stream
 *     to the granular `session.*` envelope events (useAppFontEffects switch).
 *
 * The UI derives text/reasoning part ids from (assistantMessageID, ordinal) and
 * tool parts from the tool-call id. Ordinals are numbered per type within one
 * assistant message — exactly how the UI rebuilds a fetched message's `content`
 * array (index-CgR5rJq_ `Zh`).
 */

import { randomUUID } from "node:crypto";
import { getAgentName } from "./agent-name.js";
import { questionFormID, toQuestionForm } from "./question-forms.js";
import { v2PromptAttachments } from "./prompt-parts.js";
import type {
  OCAssistantMessage,
  OCMessageWithParts,
  OCUserMessage,
  OCModelRef,
  OCPart,
  OCSession,
  OCSessionStatus,
  OCEvent,
} from "./types.js";

function genId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function subpathOf(directory: string): string {
  return directory.replace(/^\/+/, "");
}

function zeroTokens(): V2Tokens {
  return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
}

// ---------------------------------------------------------------------
// v2 HTTP resource shapes
// ---------------------------------------------------------------------

export interface V2Tokens {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

export interface V2Model {
  id: string;
  modelID: string;
  providerID: string;
  name: string;
  capabilities: { tools: boolean; input: string[]; output: string[] };
  variants: Array<{ id: string; settings: Record<string, unknown> }>;
  time: { released: number };
  cost: Array<{ input: number; output: number; cache: { read: number; write: number } }>;
  status: string;
  enabled: boolean;
  limit: { context: number; output: number };
}

/**
 * Structural subset of each connector's Catalog (catalog.ts). Keeping it local
 * lets this file stay byte-identical between the mcode and pi repos.
 */
interface CatalogModelLike {
  id: string;
  providerID: string;
  name: string;
  capabilities: { input: Record<string, boolean> };
  cost: { input: number; output: number; cache: { read: number; write: number } };
  limit: { context: number; output: number };
  /** Thinking levels keyed by id, the v1 shape. */
  variants?: Record<string, Record<string, unknown>>;
}

interface CatalogProviderLike {
  id: string;
  name: string;
  models: Record<string, CatalogModelLike>;
}

interface CatalogLike {
  providers: CatalogProviderLike[];
  defaults: Record<string, string>;
  /** The model the agent reported as active (see catalog.ts). */
  default?: { providerID: string; modelID: string };
}

function toV2Model(m: CatalogModelLike): V2Model {
  const inputs = Object.entries(m.capabilities.input)
    .filter(([, on]) => on === true)
    .map(([name]) => name);
  return {
    id: m.id,
    modelID: m.id,
    providerID: m.providerID,
    name: m.name,
    capabilities: { tools: true, input: inputs.length > 0 ? inputs : ["text"], output: ["text"] },
    // OpenChamber 2.x reads a model's efforts only from this array; empty hides the picker.
    variants: Object.entries(m.variants ?? {}).map(([id, settings]) => ({ id, settings })),
    time: { released: 0 },
    cost: [
      { input: m.cost.input, output: m.cost.output, cache: { read: m.cost.cache.read, write: m.cost.cache.write } },
    ],
    status: "active",
    enabled: true,
    limit: { context: m.limit.context, output: m.limit.output },
  };
}

/** Flatten the per-provider model records into the v2 `/api/model` list. */
export function flattenModels(cat: CatalogLike): V2Model[] {
  const out: V2Model[] = [];
  for (const p of cat.providers) {
    for (const m of Object.values(p.models)) out.push(toV2Model(m));
  }
  return out;
}

/** The v2 `/api/model/default` model object — the model actually in use. */
export function defaultV2Model(cat: CatalogLike): V2Model | undefined {
  const lookup = (providerID: string, modelID: string): V2Model | undefined => {
    const provider = cat.providers.find((p) => p.id === providerID);
    const model = provider?.models[modelID];
    return model ? toV2Model(model) : undefined;
  };
  if (cat.default !== undefined) {
    const active = lookup(cat.default.providerID, cat.default.modelID);
    if (active !== undefined) return active;
  }
  for (const [providerID, modelID] of Object.entries(cat.defaults)) {
    const found = lookup(providerID, modelID);
    if (found !== undefined) return found;
  }
  // Deliberately no "first provider, first model" fallback: advertising a model
  // the agent is not running makes the client pin its picker to a lie, and
  // every prompt then re-asserts it. null is honest; the client copes.
  return undefined;
}

export interface V2Session {
  id: string;
  parentID?: string;
  parentMessageID?: string;
  projectID: string;
  agent: string;
  model?: { id: string; providerID: string; variant?: string };
  cost: number;
  tokens: V2Tokens;
  time: { created: number; updated: number; archived?: number };
  title: string;
  subpath: string;
  location: { directory: string };
  directory: string;
  metadata?: Record<string, unknown>;
  outcome?: OCSession["outcome"];
  revert?: { messageID: string };
}

export function toV2Session(
  info: OCSession,
  opts: { model?: OCModelRef | undefined; agent?: string | undefined } = {},
): V2Session {
  const session: V2Session = {
    id: info.id,
    projectID: info.projectID,
    agent: opts.agent ?? getAgentName(),
    cost: info.cost ?? 0,
    tokens: info.tokens ?? zeroTokens(),
    time: {
      created: info.time.created,
      updated: info.time.updated,
      ...(info.time.idle !== undefined ? { idle: info.time.idle } : {}),
      ...(info.time.archived !== undefined ? { archived: info.time.archived } : {}),
    },
    title: info.title,
    subpath: subpathOf(info.directory),
    location: { directory: info.directory },
    directory: info.directory,
    ...(info.metadata !== undefined ? { metadata: info.metadata } : {}),
    ...(info.outcome !== undefined ? { outcome: info.outcome } : {}),
    ...(info.revert !== undefined ? { revert: info.revert } : {}),
  };
  if (info.parentID !== undefined) session.parentID = info.parentID;
  if (info.parentMessageID !== undefined) session.parentMessageID = info.parentMessageID;
  if (opts.model !== undefined) {
    session.model = {
      id: opts.model.modelID,
      providerID: opts.model.providerID,
      variant: info.model?.variant ?? "default",
    };
  }
  return session;
}

export interface V2Message {
  id: string;
  time: { created: number; completed?: number; streamed?: number };
  type: "user" | "assistant" | "synthetic";
  text?: string;
  files?: Array<Record<string, unknown>>;
  agents?: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
  agent?: string;
  model?: { id: string; providerID: string; variant?: string };
  content?: Array<Record<string, unknown>>;
  finish?: string;
  cost?: number;
  tokens?: V2Tokens;
  error?: OCAssistantMessage["error"];
}

/** v2 user message (list + prompt response): the UI reads `.text`. */
function toV2UserMessage(info: OCMessageWithParts): V2Message {
  const text = info.parts.map((p) => (p.type === "text" ? p.text : p.type === "compaction" ? "/compact" : "")).join("");
  const user = info.info as OCUserMessage;
  const metadata = user.metadata !== undefined ? { metadata: user.metadata } : {};
  // Admitted no-reply context lists as OpenCode's synthetic item, not as a user turn.
  if (user.synthetic)
    return { id: user.id, time: { created: user.time.created }, type: "synthetic", text, ...metadata };
  const inputs = info.parts.flatMap((part) => (part.type === "file" || part.type === "agent" ? [part] : []));
  return {
    id: user.id,
    time: { created: user.time.created },
    type: "user",
    text,
    ...v2PromptAttachments(inputs),
    ...metadata,
  };
}

/**
 * v2 assistant message: parts become `content` blocks. The UI rebuilds
 * text/reasoning part ids from per-type indices into this array.
 */
export function toV2AssistantMessage(info: OCMessageWithParts): V2Message {
  const i = info.info as OCAssistantMessage;
  const model = { id: i.modelID, providerID: i.providerID, variant: "default" };
  const content: Array<Record<string, unknown>> = [];
  for (const part of info.parts) {
    if (part.type === "text") {
      content.push({ type: "text", text: part.text });
    } else if (part.type === "reasoning") {
      content.push({
        type: "reasoning",
        text: part.text,
        time: {
          ...(part.time?.start !== undefined ? { created: part.time.start } : {}),
          ...(part.time?.end !== undefined ? { completed: part.time.end } : {}),
        },
      });
    } else if (part.type === "tool") {
      content.push(toolContent(part));
    }
  }
  const msg: V2Message = { id: i.id, time: { created: i.time.created }, type: "assistant", content };
  if (i.time.completed !== undefined) msg.time.completed = i.time.completed;
  const streamed = info.parts.flatMap((part) =>
    part.type === "text" || part.type === "reasoning" ? (part.time?.start === undefined ? [] : [part.time.start]) : [],
  );
  if (streamed.length > 0) msg.time.streamed = Math.min(...streamed);
  msg.agent = i.mode;
  msg.model = model;
  if (i.finish !== undefined) msg.finish = i.finish;
  msg.cost = i.cost;
  msg.tokens = i.tokens;
  if (i.error !== undefined) msg.error = i.error;
  return msg;
}

/** OpenCode 2.x renamed `bash` to `shell`; OpenChamber 2.x draws a shell card (command, live output) only for `shell`. */
function v2ToolName(tool: string): string {
  return tool === "bash" ? "shell" : tool;
}

function toolContent(part: Extract<OCPart, { type: "tool" }>): Record<string, unknown> {
  const st = part.state;
  const name = v2ToolName(part.tool);
  const start = st.status === "pending" ? undefined : st.time.start;
  const end = st.status === "pending" || st.status === "running" ? undefined : st.time.end;
  const base: Record<string, unknown> = {
    type: "tool",
    id: part.callID,
    name,
    // keep the SDK v1 spellings too — harmless and tolerates older readers
    callID: part.callID,
    tool: name,
    executed: false,
    time: {
      ...(start !== undefined ? { created: start, ran: start } : {}),
      ...(end !== undefined ? { completed: end } : {}),
    },
  };
  if (st.status === "pending") {
    base.state = { status: "streaming", input: st.raw ?? "", metadata: {} };
  } else if (st.status === "running") {
    base.state = {
      status: "running",
      input: st.input,
      ...(st.title !== undefined ? { title: st.title } : {}),
      metadata: st.metadata ?? {},
    };
  } else if (st.status === "completed") {
    base.state = {
      status: "completed",
      input: st.input,
      content: st.output !== "" ? [{ type: "text", text: st.output }] : [],
      output: st.output,
      title: st.title,
      metadata: st.metadata ?? {},
    };
  } else {
    base.state = {
      status: "error",
      input: st.input,
      error: { message: st.error, type: "error" },
      metadata: st.metadata ?? {},
    };
  }
  return base;
}

export function toV2Message(info: OCMessageWithParts): V2Message {
  return info.info.role === "user" ? toV2UserMessage(info) : toV2AssistantMessage(info);
}

// ---------------------------------------------------------------------
// SSE event translation: OCEvent (v1) → v2 envelopes
// ---------------------------------------------------------------------

export interface V2Envelope {
  durable?: { aggregateID: string; seq: number; version: number };
  id: string;
  created: number;
  type: string;
  location: { directory: string };
  data: Record<string, unknown>;
}

interface StepState {
  sessionID: string;
  messageID: string;
  agent: string;
  model: { id: string; providerID: string };
  finish?: string;
  error?: OCAssistantMessage["error"];
  cost: number;
  tokens: V2Tokens;
  ended: boolean;
  streamed: boolean;
}

interface PartState {
  kind: "text" | "reasoning";
  ordinal: number;
  ended: boolean;
}

interface ToolState {
  callID: string;
  name: string;
  started: boolean;
  inputEnded: boolean;
  called: boolean;
  ended: boolean;
  raw: string;
  /** Metadata last sent on `session.tool.progress`, as JSON. */
  metadata: string;
}

interface SessionState {
  executionStarted: boolean;
  executionEnded?: boolean;
  step?: StepState;
  parts: Map<string, PartState>;
  counters: Map<string, { text: number; reasoning: number }>;
  tools: Map<string, ToolState>;
}

/**
 * Stateful v1→v2 event translator. One instance per server; translate() is
 * called once per emitted OCEvent and the resulting frames are fanned out to
 * v2 SSE subscribers only.
 */
export class V2EventTranslator {
  private sessions = new Map<string, SessionState>();
  private sequences = new Map<string, number>();

  translate(directory: string, ev: OCEvent): V2Envelope[] {
    switch (ev.type) {
      case "session.inbox.enqueued":
      case "session.inbox.delivered":
      case "session.revert.staged":
      case "session.revert.cleared":
      case "session.revert.committed":
      case "session.compaction.started":
      case "session.compaction.ended":
      case "session.compaction.failed":
      case "session.shell.started":
      case "session.shell.ended":
        return [this.frame(directory, ev.type, ev.properties)];
      case "message.removed":
        return [
          this.frame(directory, "session.inbox.cancelled", {
            sessionID: ev.properties.sessionID,
            inboxID: ev.properties.messageID,
          }),
        ];
      case "session.created": {
        const info = ev.properties.info;
        return [
          this.frame(directory, "session.created", {
            sessionID: info.id,
            projectID: info.projectID,
            location: { directory: info.directory },
            subpath: subpathOf(info.directory),
            title: info.title,
            agent: info.agent ?? getAgentName(),
            ...(info.parentID !== undefined ? { parentID: info.parentID } : {}),
            ...(info.parentMessageID !== undefined ? { parentMessageID: info.parentMessageID } : {}),
            ...(info.metadata !== undefined ? { metadata: info.metadata } : {}),
          }),
        ];
      }
      case "session.updated": {
        const info = ev.properties.info;
        return [
          this.frame(directory, "session.renamed", { sessionID: info.id, title: info.title }),
          ...(info.metadata !== undefined
            ? [this.frame(directory, "session.metadata.updated", { sessionID: info.id, metadata: info.metadata })]
            : []),
          this.frame(directory, "session.agent.selected", { sessionID: info.id, agent: info.agent ?? getAgentName() }),
          ...(info.cost !== undefined
            ? [
                this.frame(directory, "session.usage.updated", {
                  sessionID: info.id,
                  cost: info.cost,
                  tokens: info.tokens ?? zeroTokens(),
                }),
              ]
            : []),
        ];
      }
      case "session.diff":
        return [this.frame(directory, "session.diff", ev.properties)];
      case "session.deleted": {
        const info = ev.properties.info;
        this.sessions.delete(info.id);
        return [this.frame(directory, "session.deleted", { sessionID: info.id })];
      }
      case "session.status":
        return this.onStatus(directory, ev.properties.sessionID, ev.properties.status);
      case "session.idle": {
        const sessionID = ev.properties.sessionID;
        const st = this.sessions.get(sessionID);
        const frames: V2Envelope[] = [];
        if (st?.step && !st.step.ended) frames.push(...this.finalizeStep(directory, st.step));
        if (st?.executionEnded) {
          // session.error already published the execution's terminal frame.
        } else if (st?.step?.error?.name === "MessageAbortedError") {
          frames.push(this.frame(directory, "session.execution.interrupted", { sessionID, reason: "user" }));
        } else if (st?.step?.finish === "error") {
          frames.push(
            this.frame(directory, "session.execution.failed", {
              sessionID,
              error: st.step.error ?? { name: "UnknownError", data: { message: "Provider error" } },
            }),
          );
        } else {
          frames.push(this.frame(directory, "session.execution.succeeded", { sessionID }));
        }
        frames.push(this.frame(directory, "session.idle", { sessionID }));
        this.sessions.delete(sessionID);
        return frames;
      }
      case "session.error": {
        const { sessionID, error } = ev.properties;
        const frames: V2Envelope[] = [];
        const st = sessionID !== undefined ? this.state(sessionID) : undefined;
        if (sessionID !== undefined && st?.step && !st.step.ended) {
          st.step.finish = "error";
          st.step.error = error ?? { name: "UnknownError", data: { message: "session error" } };
          frames.push(...this.finalizeStep(directory, st.step));
        }
        if (sessionID !== undefined && st !== undefined && !st.executionEnded) {
          st.executionEnded = true;
          frames.push(
            error?.name === "MessageAbortedError"
              ? this.frame(directory, "session.execution.interrupted", { sessionID, reason: "user" })
              : this.frame(directory, "session.execution.failed", {
                  sessionID,
                  error: error ?? { name: "UnknownError", data: { message: "session error" } },
                }),
          );
        }
        return frames;
      }
      case "message.updated":
        return this.onMessageUpdated(directory, ev.properties.info);
      case "message.part.updated":
        return this.onPartUpdated(directory, ev.properties.part, ev.properties.delta);
      case "message.part.delta": {
        const { sessionID, messageID, partID, delta } = ev.properties;
        const part = this.state(sessionID).parts.get(partID);
        if (part === undefined || delta === "") return [];
        return [
          this.frame(directory, `session.${part.kind}.delta`, {
            sessionID,
            assistantMessageID: messageID,
            ordinal: part.ordinal,
            delta,
          }),
        ];
      }
      case "model.changed": {
        const { sessionID, model, previous } = ev.properties;
        return [
          this.frame(directory, "session.model.selected", {
            sessionID,
            model: { id: model.modelID, providerID: model.providerID },
            ...(previous !== undefined ? { previous: { id: previous.modelID, providerID: previous.providerID } } : {}),
          }),
        ];
      }
      case "permission.asked": {
        const p = ev.properties;
        return [this.frame(directory, "permission.asked", p)];
      }
      case "permission.replied":
        return [this.frame(directory, "permission.replied", ev.properties)];
      case "question.asked":
        return [this.frame(directory, "form.created", { form: toQuestionForm(ev.properties) })];
      case "question.replied":
        return [
          this.frame(directory, "form.replied", {
            id: questionFormID(ev.properties.requestID),
            sessionID: ev.properties.sessionID,
            answer:
              ev.properties.formAnswer ??
              Object.fromEntries(ev.properties.answers.map((a, i) => [`q${i + 1}`, a.length === 1 ? a[0] : a])),
          }),
        ];
      case "question.rejected":
        return [
          this.frame(directory, "form.cancelled", {
            id: questionFormID(ev.properties.requestID),
            sessionID: ev.properties.sessionID,
          }),
        ];
      case "mcp.tools.changed":
        return [this.frame(directory, "mcp.status.changed", { server: ev.properties.server })];
      default:
        return [];
    }
  }

  private onStatus(directory: string, sessionID: string, status: OCSessionStatus): V2Envelope[] {
    const frames: V2Envelope[] = [this.frame(directory, "session.status", { sessionID, status })];
    const st = this.state(sessionID);
    if (status.type === "busy" && !st.executionStarted) {
      st.executionStarted = true;
      frames.push(this.frame(directory, "session.execution.started", { sessionID }));
    }
    return frames;
  }

  private onMessageUpdated(directory: string, info: OCMessageWithParts["info"]): V2Envelope[] {
    if (info.role === "user") return []; // the UI inserts user messages optimistically
    const st = this.state(info.sessionID);
    const frames: V2Envelope[] = [];
    const isNew = st.step === undefined || st.step.messageID !== info.id;
    if (isNew) {
      if (st.step && !st.step.ended) frames.push(...this.finalizeStep(directory, st.step));
      const step: StepState = {
        sessionID: info.sessionID,
        messageID: info.id,
        agent: info.mode !== "" ? info.mode : getAgentName(),
        model: { id: info.modelID, providerID: info.providerID },
        cost: info.cost,
        tokens: info.tokens,
        ended: false,
        streamed: false,
      };
      if (info.finish !== undefined) step.finish = info.finish;
      if (info.finish === "error") {
        step.error = info.error ?? { name: "UnknownError", data: { message: "Provider error" } };
      }
      st.step = step;
      frames.push(
        this.frame(directory, "session.step.started", {
          sessionID: info.sessionID,
          assistantMessageID: info.id,
          agent: step.agent,
          model: step.model,
        }),
      );
    } else if (st.step) {
      st.step.cost = info.cost;
      st.step.tokens = info.tokens;
      if (info.finish !== undefined) st.step.finish = info.finish;
      if (info.finish === "error") {
        st.step.error = info.error ?? { name: "UnknownError", data: { message: "Provider error" } };
      }
      if (!st.step.streamed) {
        st.step.streamed = true;
        frames.push(
          this.frame(directory, "session.step.streamed", { sessionID: info.sessionID, assistantMessageID: info.id }),
        );
      }
    }
    if (st.step && !st.step.ended && info.time.completed !== undefined) {
      if (info.finish !== undefined) st.step.finish = info.finish;
      frames.push(...this.finalizeStep(directory, st.step));
    }
    return frames;
  }

  private finalizeStep(directory: string, st: StepState): V2Envelope[] {
    if (st.ended) return [];
    st.ended = true;
    return [
      st.finish === "error"
        ? this.frame(directory, "session.step.failed", {
            sessionID: st.sessionID,
            assistantMessageID: st.messageID,
            rawFinish: st.finish,
            error: st.error ?? { name: "UnknownError", data: { message: "Provider error" } },
            cost: st.cost,
            tokens: st.tokens,
          })
        : this.frame(directory, "session.step.ended", {
            sessionID: st.sessionID,
            assistantMessageID: st.messageID,
            ...(st.finish !== undefined ? { finish: st.finish } : {}),
            cost: st.cost,
            tokens: st.tokens,
          }),
    ];
  }

  private onPartUpdated(directory: string, part: OCPart, delta?: string): V2Envelope[] {
    if (part.type === "file" || part.type === "agent") return [];
    if (part.type === "compaction")
      // Like shell turns, the server creates this user turn; there is no optimistic prompt.
      return [
        this.frame(directory, "session.prompted", {
          sessionID: part.sessionID,
          messageID: part.messageID,
          prompt: { text: "/compact" },
          delivery: "queue",
        }),
      ];
    return part.type === "tool" ? this.onToolPart(directory, part) : this.onTextPart(directory, part, delta);
  }

  private onTextPart(
    directory: string,
    part: Extract<OCPart, { type: "text" | "reasoning" }>,
    delta?: string,
  ): V2Envelope[] {
    // Shell creates this user turn on the server; there is no optimistic prompt.
    if (part.type === "text" && part.synthetic) {
      return [
        this.frame(directory, "session.prompted", {
          sessionID: part.sessionID,
          messageID: part.messageID,
          prompt: { text: part.text },
          delivery: "queue",
        }),
      ];
    }
    const kind = part.type;
    const st = this.state(part.sessionID);
    const mid = part.messageID;
    const frames: V2Envelope[] = [];
    let ps = st.parts.get(part.id);
    if (!ps) {
      const counters = st.counters.get(mid) ?? { text: 0, reasoning: 0 };
      const ordinal = kind === "text" ? counters.text++ : counters.reasoning++;
      st.counters.set(mid, counters);
      ps = { kind, ordinal, ended: false };
      st.parts.set(part.id, ps);
      frames.push(
        this.frame(directory, `session.${kind}.started`, {
          sessionID: part.sessionID,
          assistantMessageID: mid,
          ordinal,
        }),
      );
    }
    if (typeof delta === "string" && delta !== "") {
      frames.push(
        this.frame(directory, `session.${kind}.delta`, {
          sessionID: part.sessionID,
          assistantMessageID: mid,
          ordinal: ps.ordinal,
          delta,
        }),
      );
    }
    if (!ps.ended && part.time?.end !== undefined) {
      ps.ended = true;
      frames.push(
        this.frame(directory, `session.${kind}.ended`, {
          sessionID: part.sessionID,
          assistantMessageID: mid,
          ordinal: ps.ordinal,
          text: part.text,
        }),
      );
    }
    return frames;
  }

  private onToolPart(directory: string, part: Extract<OCPart, { type: "tool" }>): V2Envelope[] {
    const st = this.state(part.sessionID);
    const name = v2ToolName(part.tool);
    let ts = st.tools.get(part.id);
    if (!ts) {
      ts = {
        callID: part.callID,
        name,
        started: false,
        inputEnded: false,
        called: false,
        ended: false,
        raw: "",
        metadata: "",
      };
      st.tools.set(part.id, ts);
    }
    ts.callID = part.callID;
    const frames: V2Envelope[] = [];
    const base = { sessionID: part.sessionID, assistantMessageID: part.messageID, id: part.callID };
    const state = part.state;

    if (state.status === "pending") {
      if (!ts.started) {
        ts.started = true;
        frames.push(this.frame(directory, "session.tool.input.started", { ...base, name }));
      }
      const raw = state.raw ?? "";
      if (raw.length > ts.raw.length) {
        const chunk = raw.slice(ts.raw.length);
        ts.raw = raw;
        frames.push(this.frame(directory, "session.tool.input.delta", { ...base, delta: chunk }));
      }
      return frames;
    }

    // mapTool renames a call when it leaves pending (eval -> shell). OpenChamber 2.x takes the tool name only from
    // input.started, so announce the card again under its new name before its input ends.
    if (!ts.started || (ts.name !== name && !ts.inputEnded)) {
      ts.started = true;
      frames.push(this.frame(directory, "session.tool.input.started", { ...base, name }));
    }
    ts.name = name;
    if (!ts.inputEnded) {
      ts.inputEnded = true;
      frames.push(
        this.frame(directory, "session.tool.input.ended", {
          ...base,
          text: ts.raw !== "" ? ts.raw : safeJson(state.input),
        }),
      );
    }
    if (!ts.called) {
      ts.called = true;
      frames.push(this.frame(directory, "session.tool.called", { ...base, input: state.input, executed: false }));
    }
    // `called` carries no metadata (eval card headers, live output); 2.x reads it while running only from progress.
    if (state.status === "running" && state.metadata !== undefined) {
      const metadata = safeJson(state.metadata);
      if (metadata !== ts.metadata) {
        ts.metadata = metadata;
        frames.push(this.frame(directory, "session.tool.progress", { ...base, metadata: state.metadata }));
      }
    }

    if (!ts.ended && state.status === "completed") {
      ts.ended = true;
      frames.push(
        this.frame(directory, "session.tool.success", {
          ...base,
          content: state.output !== "" ? [{ type: "text", text: state.output }] : [],
          metadata: state.metadata ?? {},
          executed: false,
        }),
      );
    } else if (!ts.ended && state.status === "error") {
      ts.ended = true;
      frames.push(
        this.frame(directory, "session.tool.failed", {
          ...base,
          error: { message: state.error, type: "error" },
          content: [],
          metadata: state.metadata ?? {},
          executed: false,
        }),
      );
    }
    return frames;
  }

  private state(sessionID: string): SessionState {
    let st = this.sessions.get(sessionID);
    if (!st) {
      st = { executionStarted: false, parts: new Map(), counters: new Map(), tools: new Map() };
      this.sessions.set(sessionID, st);
    }
    return st;
  }

  private frame(directory: string, type: string, data: Record<string, unknown>): V2Envelope {
    const aggregateID = typeof data.sessionID === "string" ? data.sessionID : undefined;
    const seq = aggregateID === undefined ? undefined : (this.sequences.get(aggregateID) ?? 0) + 1;
    if (aggregateID !== undefined && seq !== undefined) this.sequences.set(aggregateID, seq);
    return {
      id: genId("evt"),
      created: Date.now(),
      type,
      location: { directory },
      data,
      ...(aggregateID !== undefined && seq !== undefined ? { durable: { aggregateID, seq, version: 1 } } : {}),
    };
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "";
  }
}
