#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const resume = process.argv.indexOf("--session");
const directory = join(
  process.env.PI_CODING_AGENT_DIR,
  "sessions",
  `--${process
    .cwd()
    .replace(/^[/\\]+/, "")
    .replace(/[\\/:]/g, "-")}--`,
);
mkdirSync(directory, { recursive: true });
const sessionFile = resume < 0 ? join(directory, `${randomUUID()}.jsonl`) : process.argv[resume + 1];
if (resume < 0)
  writeFileSync(
    sessionFile,
    JSON.stringify({
      type: "session",
      version: 3,
      id: randomUUID(),
      cwd: process.cwd(),
      timestamp: new Date().toISOString(),
    }) + "\n",
  );
const lines = readFileSync(sessionFile, "utf8").trim().split("\n").map(JSON.parse);
const sessionId = lines[0].id;
const entries = lines.slice(1);
let leafId = entries.at(-1)?.id ?? null;
const record = (entry) => {
  const value = { id: randomUUID(), parentId: leafId, timestamp: new Date().toISOString(), ...entry };
  entries.push(value);
  leafId = value.id;
  appendFileSync(sessionFile, JSON.stringify(value) + "\n");
};
const questions = [
  { id: "q1", header: "Features", question: "Which?", options: [{ label: "A" }, { label: "B" }], multiSelect: true },
  { id: "q2", header: "Details", question: "Details?", options: [], multiSelect: false },
];
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
let pending;
let busy = false;
let refused = false;
const responses = [];
let prompts = 0;
const frame = () => ({
  type: "extension_ui_request",
  method: "question",
  id: randomUUID(),
  requestId: "native-call",
  toolCallId: "native-call",
  waitForAnswer: false,
  questions,
  deadlineAtMs: 9999999999999,
});
if (
  entries.some((e) => e.customType === "ask-user:pending") &&
  !entries.some((e) => e.customType === "ask-user:settlement")
)
  pending = frame();
const settle = (outcome, answers = {}, comment) => {
  const request = pending;
  pending = undefined;
  record({ type: "custom", customType: "ask-user:settlement", data: { requestId: "native-call", outcome } });
  send({ type: "question_resolved", id: request.id, requestId: request.requestId, outcome, answers, comment });
  if (outcome === "answered" || outcome === "comment-submitted") {
    const message = {
      role: "user",
      id: "native-answer",
      timestamp: Date.now(),
      content: [{ type: "text", text: JSON.stringify({ answers, comment }) }],
    };
    record({ type: "message", message });
    send({ type: "message_start", message });
    send({ type: "message_end", message });
    send({ type: "answer_delivered", disposition: busy ? "steer" : "followUp" });
  }
};
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const command = JSON.parse(line);
  let data = {};
  if (command.type === "extension_ui_response") {
    responses.push(command);
    const success =
      !refused &&
      pending?.id === command.uiRequestId &&
      (command.cancelled || Object.keys(command.answers ?? {}).length || command.comment?.trim());
    refused = false;
    if (success)
      settle(
        command.cancelled ? "cancelled" : command.comment?.trim() ? "comment-submitted" : "answered",
        command.answers,
        command.comment,
      );
    send({
      type: "response",
      id: command.id,
      command: command.type,
      success: Boolean(success),
      ...(success ? {} : { error: "question_incomplete" }),
    });
    return;
  }
  if (command.type === "get_state") {
    // Revival deliberately exposes snapshot-only state: a missing hydration
    // call must fail the restart test rather than pass via a replayed UI frame.
    if (pending && resume < 0) send(pending);
    data = {
      sessionId,
      sessionFile,
      model: { provider: "fake", id: "fake" },
      isStreaming: busy,
      pendingQuestions: pending ? [pending] : [],
      responses,
      prompts,
    };
  }
  if (command.type === "get_entries") data = { entries, leafId };
  if (command.type === "refuse_next") refused = true;
  if (command.type === "resolve_question" && pending) settle(command.outcome);
  if (command.type === "emit_event") send(command.event);
  if (command.type === "prompt") {
    prompts++;
    busy = command.message === "busy";
    record({ type: "message", message: { role: "user", content: [{ type: "text", text: command.message }] } });
    send({ type: "agent_start" });
    send({
      type: "tool_execution_start",
      toolCallId: "native-call",
      toolName: "ask_user_question",
      args: { questions, waitForAnswer: false },
    });
    pending = frame();
    record({ type: "custom", customType: "ask-user:pending", data: { requestId: pending.requestId } });
    send(pending);
    send({
      type: "tool_execution_end",
      toolCallId: "native-call",
      result: { content: [], details: { accepted: true, pending: true } },
      isError: false,
    });
    send({ type: "turn_end", toolResults: [] });
    if (!busy) {
      send({ type: "agent_end" });
      send({ type: "agent_idle" });
    }
  }
  send({ type: "response", id: command.id, command: command.type, success: true, data });
});
input.on("close", () => process.exit(0));
