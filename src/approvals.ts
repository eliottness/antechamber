import { createHash } from "node:crypto";
import type {
  PermissionRequest,
  PermissionV2Request,
  QuestionInfo,
  QuestionRequest,
  EventPermissionAsked,
  EventPermissionReplied,
  EventQuestionReplied,
  EventQuestionRejected,
} from "@opencode-ai/sdk/v2";

type WithoutEventID<T> = T extends { id: string } ? Omit<T, "id"> : never;
export type ApprovalEvent =
  | WithoutEventID<EventPermissionAsked | EventPermissionReplied | EventQuestionRejected>
  | { type: "question.asked"; properties: PendingQuestion }
  | {
      type: "question.replied";
      properties: EventQuestionReplied["properties"] & {
        comment?: string;
        formAnswer?: Record<string, string | string[]>;
      };
    };
type PermissionReply = "once" | "always" | "reject";
export type PendingPermission = PermissionRequest;
export type PendingQuestion = QuestionRequest & {
  questionIDs?: string[];
  metadata?: Record<string, unknown>;
};
export type ExtensionUiResponse = Record<string, unknown>;
export class ApprovalInputError extends Error {}

interface Context {
  sessionID: string;
  directory: string;
  messageID: string;
  send: (response: Record<string, unknown>) => void;
}

interface UIRequest {
  id: string;
  method: "select" | "confirm" | "input" | "editor" | "question";
  title: string;
  options: string[];
  toolCallId?: string;
  timeout?: number;
  requestId?: string;
  questions?: Array<QuestionInfo & { id: string }>;
  waitForAnswer?: boolean;
  deadlineAtMs?: number;
  draft?: Record<string, unknown>;
}

type Pending = {
  context: Context;
  request: UIRequest;
  timer?: ReturnType<typeof setTimeout>;
  replying?: boolean;
} & ({ kind: "permission"; card: PermissionRequest } | { kind: "question"; card: PendingQuestion });

const MAX_SETTLED_STRUCTURED_QUESTIONS = 256;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function extensionUiRequestFrom(value: Record<string, unknown>): UIRequest | undefined {
  const { id, method, title, options, toolCallId, timeout } = value;
  if (typeof id !== "string" || id === "") return undefined;
  if (method === "question") {
    const requestId = typeof value.requestId === "string" ? value.requestId : toolCallId;
    if (typeof requestId !== "string" || !requestId || !Array.isArray(value.questions) || !value.questions.length)
      return undefined;
    const questions: Array<QuestionInfo & { id: string }> = [];
    for (const item of value.questions) {
      const q = record(item);
      if (
        !q ||
        typeof q.id !== "string" ||
        typeof q.question !== "string" ||
        typeof q.header !== "string" ||
        !Array.isArray(q.options)
      )
        return undefined;
      const parsedOptions: QuestionInfo["options"] = [];
      for (const option of q.options) {
        const o = record(option);
        if (!o || typeof o.label !== "string") return undefined;
        parsedOptions.push({ label: o.label, description: typeof o.description === "string" ? o.description : "" });
      }
      if (questions.some((question) => question.id === q.id) || q.id === "comment") return undefined;
      questions.push({
        id: q.id,
        question: q.question,
        header: q.header,
        options: parsedOptions,
        multiple: q.multiSelect === true || q.multiple === true,
        custom: true,
      });
    }
    const draft = record(value.draft);
    return {
      id,
      method,
      title: "",
      options: [],
      requestId,
      toolCallId: requestId,
      questions,
      waitForAnswer: value.waitForAnswer !== false,
      ...(typeof value.deadlineAtMs === "number" ? { deadlineAtMs: value.deadlineAtMs } : {}),
      ...(draft ? { draft } : {}),
    };
  }
  if (method !== "select" && method !== "confirm" && method !== "input" && method !== "editor") return undefined;
  return {
    id,
    method,
    title: typeof title === "string" ? title : "",
    options: Array.isArray(options) ? options.filter((o): o is string => typeof o === "string") : [],
    ...(typeof toolCallId === "string" ? { toolCallId } : {}),
    ...(typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0 ? { timeout } : {}),
  };
}

export function parsePermissionTitle(title: string): { permission: string; patterns: string[] } {
  const lines = title.split(/\r?\n/);
  const permission = (lines[0] ?? "").slice("Permission required:".length).trim();
  const start = lines.findIndex((line) => line.trim() === "Patterns:");
  const patterns: string[] = [];
  if (start !== -1) {
    for (const line of lines.slice(start + 1)) {
      const match = line.match(/^\s*-\s+(.+?)\s*$/);
      if (!match) break;
      if (match[1] !== undefined) patterns.push(match[1]);
    }
  }
  return { permission, patterns };
}

export function toV2Permission(card: PermissionRequest): PermissionV2Request {
  return {
    id: card.id,
    sessionID: card.sessionID,
    action: card.permission,
    resources: card.patterns,
    save: card.always,
    metadata: card.metadata,
    ...(card.tool ? { source: { type: "tool", ...card.tool } } : {}),
  };
}

/** Session-scoped dialog lifecycle; RPC select replies are labels, never indices. */
export class ApprovalBridge {
  private pending = new Map<string, Pending>();
  private questionCalls = new Map<string, Map<string, QuestionInfo[]>>();
  private followups = new Map<string, Map<string, { value: string; kind: "permission" | "question" }>>();
  private emit: (directory: string, event: ApprovalEvent) => void;
  private settled = new Set<string>();

  constructor(
    private sessionID: string,
    emit: (event: ApprovalEvent) => void,
    private send: (response: ExtensionUiResponse) => void,
    private messageID: () => string | undefined,
    private acknowledge?: (response: ExtensionUiResponse) => Promise<boolean>,
  ) {
    this.emit = (_directory, event) => emit(event);
  }

  private context(): Context {
    return { sessionID: this.sessionID, directory: "", messageID: this.messageID() ?? "", send: this.send };
  }

  handle(request: UIRequest): void {
    this.ask(this.context(), { ...request });
  }

  noteToolStart(toolCallId: string, toolName: string, args: unknown): void {
    this.observe(this.context(), { type: "tool_execution_start", toolCallId, toolName, args });
  }

  noteToolEnd(toolCallId: string): void {
    this.clear(this.sessionID, false, toolCallId);
  }

  finishTurn(): void {
    this.clear(this.sessionID, false);
  }

  cancelAll(): void {
    this.clear(this.sessionID, true);
  }

  permissions(sessionID?: string, directory?: string): PermissionRequest[] {
    return [...this.pending.values()]
      .filter(
        (p) =>
          p.kind === "permission" &&
          (sessionID === undefined || p.context.sessionID === sessionID) &&
          (directory === undefined || p.context.directory === directory),
      )
      .flatMap((p) => (p.kind === "permission" ? [p.card] : []));
  }

  questionRequests(sessionID?: string, directory?: string): PendingQuestion[] {
    return [...this.pending.values()]
      .filter(
        (p) =>
          p.kind === "question" &&
          (sessionID === undefined || p.context.sessionID === sessionID) &&
          (directory === undefined || p.context.directory === directory),
      )
      .flatMap((p) => (p.kind === "question" ? [p.card] : []));
  }

  questions(): PendingQuestion[] {
    return this.questionRequests();
  }

  hasPending(sessionID: string): boolean {
    return (
      [...this.pending.values()].some((p) => p.context.sessionID === sessionID) ||
      (this.followups.get(sessionID)?.size ?? 0) > 0
    );
  }

  /** Merge a snapshot only after live subscriptions have been installed. */
  hydrate(questions: unknown): void {
    if (!Array.isArray(questions)) return;
    for (const value of questions) {
      const frame = record(value);
      if (!frame) continue;
      const request = extensionUiRequestFrom({ ...frame, method: "question" });
      if (request && ![...this.pending.values()].some((p) => p.request.requestId === request.requestId))
        this.handle(request);
    }
  }

  observeQuestion(ev: Record<string, unknown>): void {
    if (ev.type !== "question_updated" && ev.type !== "question_resolved") return;
    const p = [...this.pending.values()].find(
      (p) =>
        p.request.method === "question" &&
        (p.request.id === ev.id || (typeof ev.requestId === "string" && p.request.requestId === ev.requestId)),
    );
    if (ev.type === "question_resolved" && typeof ev.requestId === "string") this.rememberSettled(ev.requestId);
    if (!p || p.kind !== "question") return;
    if (ev.type === "question_updated") {
      if (typeof ev.deadlineAtMs === "number") p.request.deadlineAtMs = ev.deadlineAtMs;
      const draft = record(ev.draft) ?? (record(ev.answers) ? { answers: ev.answers, comment: ev.comment } : undefined);
      if (draft) p.request.draft = draft;
      p.card.metadata = { ...p.card.metadata, deadlineAtMs: p.request.deadlineAtMs, draft: p.request.draft };
      return;
    }
    this.rememberSettled(p.request.requestId);
    if (ev.outcome !== "answered" && ev.outcome !== "comment-submitted") {
      this.remove(p, true);
      return;
    }
    const native = record(ev.answers) ?? {};
    const formAnswer: Record<string, string | string[]> = {};
    const answers = (p.request.questions ?? []).map((q) => {
      const answer = record(native[q.id]);
      const selected = Array.isArray(answer?.selected)
        ? answer.selected.filter((v): v is string => typeof v === "string")
        : [];
      const values = typeof answer?.text === "string" ? [...selected, answer.text] : selected;
      if (values.length) formAnswer[q.id] = q.multiple ? values : (values[0] ?? "");
      return values;
    });
    if (typeof ev.comment === "string") formAnswer.comment = ev.comment;
    this.remove(p, false);
    this.emit(p.context.directory, {
      type: "question.replied",
      properties: {
        sessionID: this.sessionID,
        requestID: p.card.id,
        answers,
        formAnswer,
        ...(typeof ev.comment === "string" ? { comment: ev.comment } : {}),
      },
    });
  }

  observe(context: Context, ev: Record<string, unknown>): void {
    const callID = typeof ev.toolCallId === "string" ? ev.toolCallId : undefined;
    switch (ev.type) {
      case "tool_execution_start": {
        if (ev.toolName !== "ask_user_question" || callID === undefined) return;
        const args = record(ev.args);
        const questions = Array.isArray(args?.questions) ? args.questions : [];
        const parsed: QuestionInfo[] = [];
        for (const value of questions) {
          const q = record(value);
          if (!q || typeof q.question !== "string") continue;
          parsed.push({
            question: q.question,
            header: typeof q.header === "string" ? q.header : q.question.slice(0, 30),
            options: (Array.isArray(q.options) ? q.options : []).flatMap((value) => {
              const o = record(value);
              return o && typeof o.label === "string"
                ? [{ label: o.label, description: typeof o.description === "string" ? o.description : "" }]
                : [];
            }),
            multiple: false,
          });
        }
        let calls = this.questionCalls.get(context.sessionID);
        if (!calls) this.questionCalls.set(context.sessionID, (calls = new Map()));
        calls.set(callID, parsed);
        return;
      }
      case "tool_execution_end":
        if (callID !== undefined) this.clear(context.sessionID, false, callID);
        return;
      case "turn_end":
        this.clear(context.sessionID, false);
        return;
      case "agent_end":
        if (ev.willRetry !== true) this.clear(context.sessionID, false);
        return;
      case "extension_ui_request":
        this.ask(context, ev);
        return;
    }
  }

  private ask(context: Context, ev: Record<string, unknown>): void {
    const request = extensionUiRequestFrom(ev);
    if (!request) return;
    if (request.method === "question") {
      this.askStructuredQuestion(context, request);
      return;
    }
    this.askLegacyDialog(context, request);
  }

  private askStructuredQuestion(context: Context, request: UIRequest): void {
    if (this.settled.has(request.requestId ?? "")) return;
    const publicID = `que_${createHash("sha256")
      .update(JSON.stringify([context.sessionID, request.requestId]))
      .digest("hex")
      .slice(0, 32)}`;
    const existing = this.pending.get(publicID);
    if (existing) {
      existing.request = request;
      if (existing.kind === "question")
        existing.card.metadata = {
          requestId: request.requestId,
          waitForAnswer: request.waitForAnswer,
          deadlineAtMs: request.deadlineAtMs,
          draft: request.draft,
        };
      return;
    }
    const card: PendingQuestion = {
      id: publicID,
      sessionID: context.sessionID,
      questions: (request.questions ?? []).map(({ id: _id, ...q }) => q),
      questionIDs: (request.questions ?? []).map((q) => q.id),
      metadata: {
        requestId: request.requestId,
        waitForAnswer: request.waitForAnswer,
        deadlineAtMs: request.deadlineAtMs,
        draft: request.draft,
      },
      tool: { messageID: context.messageID, callID: request.requestId ?? "" },
    };
    this.pending.set(publicID, { kind: "question", card, context, request });
    this.emit(context.directory, { type: "question.asked", properties: card });
  }

  private askLegacyDialog(context: Context, request: UIRequest): void {
    if (this.pending.has(request.id)) return;
    const calls = this.questionCalls.get(context.sessionID);
    const matched =
      request.method === "select"
        ? [...(calls ?? [])].flatMap(([callID, questions]) =>
            questions.filter((q) => q.question === request.title).map((question) => ({ callID, question })),
          )
        : [];
    const match = matched.length === 1 ? matched[0] : undefined;
    const soleCall = calls?.size === 1 ? calls.keys().next().value : undefined;
    let callID =
      request.toolCallId ??
      match?.callID ??
      (request.method === "input" || request.method === "editor" ? soleCall : undefined);
    const followups = this.followups.get(context.sessionID);
    if (callID === undefined && request.method === "input" && followups?.size === 1) {
      const next = [...followups.entries()][0];
      if (next?.[1].kind === "question") callID = next[0];
    }
    if (callID !== undefined) request.toolCallId = callID;

    const followup = callID !== undefined ? followups?.get(callID) : undefined;
    if (request.method === "input" && followup) {
      if (callID !== undefined) followups?.delete(callID);
      context.send({ type: "extension_ui_response", id: request.id, value: followup.value });
      return;
    }

    let pending: Pending;
    if (request.method === "select" && request.title.startsWith("Permission required:")) {
      const parsed = parsePermissionTitle(request.title);
      const card: PermissionRequest = {
        id: request.id,
        sessionID: context.sessionID,
        ...parsed,
        always: [],
        metadata: { title: request.title },
        ...(callID !== undefined ? { tool: { messageID: context.messageID, callID } } : {}),
      };
      pending = { kind: "permission", card, context, request };
    } else {
      const options = request.method === "confirm" ? ["Yes", "No"] : request.method === "select" ? request.options : [];
      const question: QuestionInfo = match
        ? {
            ...match.question,
            options: match.question.options.filter((o) => options.includes(o.label)),
            custom: options.includes("Other (type an answer)"),
          }
        : {
            question: request.title,
            header: request.title.slice(0, 30),
            options: options.map((label) => ({ label, description: "" })),
            multiple: false,
            custom:
              request.method === "input" || request.method === "editor" || options.includes("Other (type an answer)"),
          };
      const card: QuestionRequest = {
        id: request.id,
        sessionID: context.sessionID,
        questions: [question],
        ...(callID !== undefined ? { tool: { messageID: context.messageID, callID } } : {}),
      };
      pending = { kind: "question", card, context, request };
    }
    this.pending.set(request.id, pending);
    if (request.timeout !== undefined) {
      pending.timer = setTimeout(() => this.remove(pending, true), request.timeout);
      pending.timer.unref();
    }
    this.emit(
      context.directory,
      pending.kind === "permission"
        ? { type: "permission.asked", properties: pending.card }
        : { type: "question.asked", properties: pending.card },
    );
  }

  replyPermission(id: string, reply: PermissionReply, message?: string, sessionID?: string): boolean {
    const p = this.pending.get(id);
    if (!p || p.kind !== "permission" || (sessionID !== undefined && p.context.sessionID !== sessionID)) return false;
    if (reply !== "once" && reply !== "always" && reply !== "reject")
      throw new ApprovalInputError("invalid permission reply");
    if (message !== undefined && typeof message !== "string") throw new ApprovalInputError("message must be a string");
    const label =
      reply === "once" ? "Allow once" : reply === "always" ? "Allow always" : message ? "Deny with feedback" : "Deny";
    if (!p.request.options.includes(label)) throw new ApprovalInputError(`permission option unavailable: ${label}`);
    if (message && reply === "reject" && p.request.toolCallId !== undefined) {
      this.follow(p, message, "permission");
    }
    this.remove(p, false);
    p.context.send({ type: "extension_ui_response", id, value: label });
    this.emit(p.context.directory, {
      type: "permission.replied",
      properties: { sessionID: p.context.sessionID, requestID: id, reply },
    });
    return true;
  }

  replyQuestion(id: string, answers: string[][], sessionID?: string, comment?: string): boolean | Promise<boolean> {
    const p = this.pending.get(id);
    if (!p || p.kind !== "question" || (sessionID !== undefined && p.context.sessionID !== sessionID)) return false;
    if (p.request.method === "question") {
      if (
        !Array.isArray(answers) ||
        answers.length > p.card.questions.length ||
        answers.some((a) => !Array.isArray(a) || a.some((v) => typeof v !== "string")) ||
        (comment !== undefined && typeof comment !== "string")
      )
        throw new ApprovalInputError("invalid structured question answers");
      const native: Record<string, { selected: string[]; text?: string }> = {};
      (p.request.questions ?? []).forEach((q, index) => {
        const values = answers[index] ?? [];
        if (!q.multiple && values.length > 1) throw new ApprovalInputError("single select question accepts one answer");
        if (!values.length) return;
        const selected = values.filter((value) => q.options.some((o) => o.label === value));
        const text = values.filter((value) => !q.options.some((o) => o.label === value)).join("\n");
        native[q.id] = { selected, ...(text ? { text } : {}) };
      });
      return this.respondStructured(p, { answers: native, ...(comment !== undefined ? { comment } : {}) });
    }
    if (
      !Array.isArray(answers) ||
      answers.length !== 1 ||
      !Array.isArray(answers[0]) ||
      answers[0].length !== 1 ||
      typeof answers[0][0] !== "string"
    ) {
      throw new ApprovalInputError("answers must contain one question with one string answer");
    }
    const answer = answers[0][0];
    let value = answer;
    const { method, options } = p.request;
    if (method === "select" && !options.includes(answer)) {
      if (!options.includes("Other (type an answer)")) {
        throw new ApprovalInputError("answer is not an available option");
      }
      value = "Other (type an answer)";
      p.request.toolCallId ??= p.request.id;
      this.follow(p, answer, "question");
    }
    if (method === "confirm" && answer !== "Yes" && answer !== "No")
      throw new ApprovalInputError("confirm answer must be Yes or No");
    this.remove(p, false);
    p.context.send(
      method === "confirm"
        ? { type: "extension_ui_response", id, confirmed: answer === "Yes" }
        : { type: "extension_ui_response", id, value },
    );
    this.emit(p.context.directory, {
      type: "question.replied",
      properties: { sessionID: p.context.sessionID, requestID: id, answers },
    });
    return true;
  }

  rejectQuestion(id: string, sessionID?: string): boolean | Promise<boolean> {
    const p = this.pending.get(id);
    if (!p || p.kind !== "question" || (sessionID !== undefined && p.context.sessionID !== sessionID)) return false;
    if (p.request.method === "question") return this.respondStructured(p, { cancelled: true });
    p.context.send({ type: "extension_ui_response", id, cancelled: true });
    this.remove(p, true);
    return true;
  }

  private async respondStructured(p: Pending, fields: Record<string, unknown>): Promise<boolean> {
    if (p.replying) return false;
    p.replying = true;
    try {
      const response = { type: "extension_ui_response", uiRequestId: p.request.id, ...fields };
      if (this.acknowledge) return await this.acknowledge(response);
      p.context.send({ ...response, id: `reply_${createHash("sha256").update(p.request.id).digest("hex")}` });
      return true;
    } finally {
      p.replying = false;
    }
  }

  private rememberSettled(requestID: string | undefined): void {
    if (!requestID) return;
    this.settled.delete(requestID);
    this.settled.add(requestID);
    if (this.settled.size <= MAX_SETTLED_STRUCTURED_QUESTIONS) return;
    const oldest = this.settled.values().next().value;
    if (oldest !== undefined) this.settled.delete(oldest);
  }

  private follow(p: Pending, value: string, kind: "permission" | "question"): void {
    const callID = p.request.toolCallId;
    if (callID === undefined) return;
    let followups = this.followups.get(p.context.sessionID);
    if (!followups) this.followups.set(p.context.sessionID, (followups = new Map()));
    followups.set(callID, { value, kind });
  }

  private remove(p: Pending, rejected: boolean): void {
    if (!this.pending.delete(p.card.id)) return;
    if (p.timer !== undefined) clearTimeout(p.timer);
    if (!rejected) return;
    this.emit(
      p.context.directory,
      p.kind === "permission"
        ? {
            type: "permission.replied",
            properties: { sessionID: p.context.sessionID, requestID: p.card.id, reply: "reject" },
          }
        : {
            type: "question.rejected",
            properties: { sessionID: p.context.sessionID, requestID: p.card.id },
          },
    );
  }

  clear(sessionID: string, cancel: boolean, callID?: string): void {
    for (const p of this.pending.values()) {
      if (p.context.sessionID !== sessionID || (callID !== undefined && p.request.toolCallId !== callID)) continue;
      if (p.request.method === "question" && !cancel) continue;
      if (cancel) this.rememberSettled(p.request.requestId);
      if (cancel) p.context.send({ type: "extension_ui_response", id: p.request.id, cancelled: true });
      this.remove(p, true);
    }
    if (callID !== undefined) {
      this.questionCalls.get(sessionID)?.delete(callID);
      this.followups.get(sessionID)?.delete(callID);
    } else {
      this.questionCalls.delete(sessionID);
      this.followups.delete(sessionID);
    }
  }
}
