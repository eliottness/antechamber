import { ApprovalInputError, type PendingQuestion } from "./approvals.js";

export function questionFormID(id: string): string {
  return `frm_${id}`;
}

export function toQuestionForm(card: PendingQuestion) {
  return {
    id: questionFormID(card.id),
    sessionID: card.sessionID,
    title: card.questions.map((q) => q.header).join(" / "),
    metadata: card.metadata ?? {},
    fields: [
      ...card.questions.map((q, index) => ({
        key: card.questionIDs?.[index] ?? `q${index + 1}`,
        type: q.multiple ? "multiselect" : "string",
        title: q.header,
        description: q.question,
        required: false,
        ...(q.options.length
          ? { options: q.options.map((o) => ({ value: o.label, ...o })), custom: q.custom !== false }
          : {}),
      })),
      ...(card.questionIDs ? [{ key: "comment", type: "string", title: "Comment", required: false }] : []),
    ],
  };
}

export function formQuestionAnswer(card: PendingQuestion, value: unknown): { answers: string[][]; comment?: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ApprovalInputError("answer must be an object");
  const answer = Object.fromEntries(Object.entries(value));
  const keys = card.questions.map((_, i) => card.questionIDs?.[i] ?? `q${i + 1}`);
  if (Object.keys(answer).some((key) => !keys.includes(key) && !(card.questionIDs && key === "comment")))
    throw new ApprovalInputError("unknown form field");
  const answers = keys.map((key, i) => {
    const v: unknown = answer[key];
    if (v === undefined) return [];
    if (typeof v === "string") return v === "" ? [] : [v];
    if (card.questions[i]?.multiple && Array.isArray(v) && v.every((item) => typeof item === "string")) return v;
    throw new ApprovalInputError("form field answer must match its type");
  });
  if (answer.comment !== undefined && typeof answer.comment !== "string")
    throw new ApprovalInputError("comment must be a string");
  return { answers, ...(typeof answer.comment === "string" ? { comment: answer.comment } : {}) };
}
