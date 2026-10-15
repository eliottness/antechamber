#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const agentDirectory = process.env.PI_CODING_AGENT_DIR ?? process.cwd();
const sessionId = randomUUID();
const sessionDirectory = join(agentDirectory, "sessions", "review-sessions");
const sessionFile = join(sessionDirectory, `${sessionId}.jsonl`);
mkdirSync(sessionDirectory, { recursive: true });
writeFileSync(
  sessionFile,
  `${JSON.stringify({
    type: "session",
    id: sessionId,
    cwd: process.cwd(),
    timestamp: "2026-10-14T00:00:00.000Z",
  })}\n`,
);

const entries = [];
let active = false;
let currentSessionId = sessionId;
let forkStateHeld;
let forked = false;
let heldEntries;
let followerEntries;
let holdEntries = false;
let leaf = null;

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function reply(command, success = true, data = {}, error) {
  send({
    type: "response",
    id: command.id,
    command: command.type,
    success,
    ...(success ? { data } : { error }),
  });
}

function state() {
  return {
    sessionId: currentSessionId,
    sessionFile,
    model: { provider: "fake", id: "review-model" },
    isStreaming: active,
  };
}

function record(message) {
  const entry = {
    type: "message",
    id: randomUUID(),
    parentId: leaf,
    timestamp: Date.now(),
    message,
  };
  entries.push(entry);
  leaf = entry.id;
  appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
  return entry;
}

function userMessage(command) {
  return {
    role: "user",
    content: [{ type: "text", text: command.message }],
    timestamp: Date.now(),
    clientMessageId: command.clientMessageId,
  };
}

function startHeldTurn(command) {
  active = true;
  const user = userMessage(command);
  record(user);
  send({ type: "agent_start" });
  send({ type: "message_start", message: user, clientMessageId: command.clientMessageId });
  send({ type: "message_end", message: user, clientMessageId: command.clientMessageId });
  send({
    type: "message_start",
    message: { role: "assistant", provider: "fake", model: "review-model" },
    clientMessageId: command.clientMessageId,
  });
  send({
    type: "message_update",
    assistantMessageEvent: {
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: { id: "held-tool", name: "bash", arguments: { command: "review hold" } },
    },
  });
  reply(command, true, { disposition: "started" });
}

function completePrompt(command) {
  const user = userMessage(command);
  const assistant = {
    role: "assistant",
    content: [{ type: "text", text: `reply: ${command.message}` }],
    provider: "fake",
    model: "review-model",
    responseModel: "review-model",
    timestamp: Date.now(),
    stopReason: "stop",
    usage: { input: 1, output: 1, cost: { total: 0 } },
  };
  record(user);
  record(assistant);
  send({ type: "agent_start" });
  send({ type: "message_start", message: user, clientMessageId: command.clientMessageId });
  send({ type: "message_end", message: user, clientMessageId: command.clientMessageId });
  send({ type: "message_start", message: assistant, clientMessageId: command.clientMessageId });
  send({
    type: "message_update",
    assistantMessageEvent: { type: "text_end", contentIndex: 0, content: assistant.content[0].text },
  });
  send({ type: "message_end", message: assistant, clientMessageId: command.clientMessageId });
  send({ type: "agent_end" });
  send({ type: "agent_idle" });
  reply(command, true, { disposition: "started" });
}

createInterface({ input: process.stdin })
  .on("line", (line) => {
    const command = JSON.parse(line);
    switch (command.type) {
      case "get_state":
        if (forked && forkStateHeld === undefined) {
          forkStateHeld = command;
          send({ type: "fixture_fork_state_held" });
          return;
        }
        reply(command, true, state());
        return;
      case "get_entries":
        if (holdEntries && heldEntries === undefined) {
          heldEntries = command;
          send({ type: "fixture_entries_held" });
          return;
        }
        if (holdEntries) {
          followerEntries = command;
          return;
        }
        reply(command, true, { entries, leafId: leaf });
        return;
      case "arm_entries_gate":
        holdEntries = true;
        reply(command);
        return;
      case "release_entries": {
        const followerBeforeRelease = followerEntries !== undefined;
        const original = heldEntries;
        const follower = followerEntries;
        heldEntries = undefined;
        followerEntries = undefined;
        holdEntries = false;
        if (original !== undefined) reply(original, true, { entries, leafId: leaf });
        if (follower !== undefined) reply(follower, true, { entries, leafId: leaf });
        reply(command, true, { followerBeforeRelease });
        return;
      }
      case "fork":
        currentSessionId = randomUUID();
        forked = true;
        reply(command, true, { cancelled: false });
        return;
      case "release_fork_state":
        if (forkStateHeld !== undefined) {
          reply(forkStateHeld, true, state());
          forkStateHeld = undefined;
        }
        forked = false;
        reply(command);
        return;
      case "set_session_name":
        if (command.name === "reject native rename") {
          reply(command, false, undefined, "native rename rejected");
          return;
        }
        reply(command);
        return;
      case "prompt":
        if (command.message === "/notify-review") {
          send({
            type: "extension_ui_request",
            id: randomUUID(),
            method: "notify",
            message: "review handled command",
            notifyType: "info",
          });
          reply(command, true, { disposition: "handled" });
          return;
        }
        if (command.message === "hold") {
          startHeldTurn(command);
          return;
        }
        completePrompt(command);
        return;
      case "corrupt_then_end":
        record({ role: "user", content: [{ type: "text", text: "before corruption" }] });
        appendFileSync(sessionFile, '{"type":\n');
        record({ role: "assistant", content: [{ type: "text", text: "after corruption" }] });
        send({ type: "agent_end" });
        reply(command);
        return;
      case "crash":
        process.exit(17);
        return;
      default:
        reply(command);
    }
  })
  .on("close", () => process.exit(0));
