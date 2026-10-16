#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const resume = process.argv.indexOf("--session");
const sessionId =
  resume < 0 ? randomUUID() : JSON.parse(readFileSync(process.argv[resume + 1], "utf8").split("\n")[0]).id;
const dir = join(
  process.env.PI_CODING_AGENT_DIR,
  "sessions",
  `--${process
    .cwd()
    .replace(/^[/\\]+/, "")
    .replace(/[\\/:\u0000]/g, "-")}--`,
);
mkdirSync(dir, { recursive: true });
const sessionFile = resume < 0 ? join(dir, `${sessionId}.jsonl`) : process.argv[resume + 1];
if (resume < 0)
  writeFileSync(
    sessionFile,
    JSON.stringify({ type: "session", id: sessionId, cwd: process.cwd(), timestamp: "2026-10-13T00:00:00.000Z" }) +
      "\n",
  );
let entries = readFileSync(sessionFile, "utf8").trim().split("\n").map(JSON.parse).slice(1);
let leaf = entries.at(-1)?.id ?? null;
let name = entries.filter((e) => e.type === "session_info").at(-1)?.name ?? process.env.ANTECHAMBER_TEST_NATIVE_TITLE;
let active;
const queued = [];
const commands = [];
const send = (v) => process.stdout.write(JSON.stringify(v) + "\n");
const record = (type, fields, time = 2000) => {
  const entry = { type, id: randomUUID(), parentId: leaf, timestamp: time, ...fields };
  entries.push(entry);
  leaf = entry.id;
  appendFileSync(sessionFile, JSON.stringify(entry) + "\n");
};
const user = (cmd) => {
  const message = {
    role: "user",
    content: [{ type: "text", text: cmd.message }],
    timestamp: 1000,
    clientMessageId: cmd.clientMessageId,
  };
  record("message", { message }, 1000);
  send({ type: "message_start", message, clientMessageId: cmd.clientMessageId });
  send({ type: "message_end", message, clientMessageId: cmd.clientMessageId });
};
const assistant = (reason, cmd, usage = true) => {
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "result" }],
    provider: "fake",
    model: "requested",
    responseModel: "served",
    timestamp: 1100,
    stopReason: reason,
    ...(usage
      ? { usage: { input: 111, output: 22, reasoning: 3, cacheRead: 44, cacheWrite: 5, cost: { total: 0.0123 } } }
      : {}),
    ...(reason === "error" ? { errorMessage: "provider failed" } : {}),
  };
  send({ type: "message_start", message, clientMessageId: cmd.clientMessageId });
  send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "result" } });
  record("message", { message });
  send({ type: "message_end", message, clientMessageId: cmd.clientMessageId });
};
const start = (cmd) => {
  active = cmd;
  send({ type: "agent_start" });
  user(cmd);
  if (cmd.message === "interrupted-work") {
    const message = {
      role: "assistant",
      content: [{ type: "toolCall", id: "checkpoint-tool", name: "bash", arguments: { command: "echo checkpoint" } }],
      provider: "fake",
      model: "served",
      timestamp: 1100,
      stopReason: "toolUse",
    };
    send({ type: "message_start", message, clientMessageId: cmd.clientMessageId });
    record("message", { message });
    send({ type: "message_end", message, clientMessageId: cmd.clientMessageId });
    const toolResult = {
      role: "toolResult",
      toolCallId: "checkpoint-tool",
      toolName: "bash",
      content: [{ type: "text", text: "checkpoint\n" }],
      isError: false,
      timestamp: 1200,
    };
    record("message", { message: toolResult });
    send({ type: "turn_end", message, toolResults: [toolResult] });
    assistant("toolUse", cmd);
    return;
  }
  if (cmd.message === "hold") {
    send({
      type: "message_start",
      message: { role: "assistant", provider: "fake", model: "served" },
      clientMessageId: cmd.clientMessageId,
    });
    send({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: { id: "held-tool", name: "bash", arguments: { command: "hold" } },
      },
    });
    return;
  }
  if (cmd.message === "steps") assistant("toolUse", cmd);
  assistant(
    ["error", "aborted", "length", "pending", "deferred"].includes(cmd.message) ? cmd.message : "stop",
    cmd,
    cmd.message !== "no-usage",
  );
  send({ type: "agent_end" });
  active = undefined;
  send({ type: "agent_idle" });
};
createInterface({ input: process.stdin })
  .on("line", (line) => {
    const cmd = JSON.parse(line);
    commands.push(cmd);
    let data = {};
    let success = true;
    if (cmd.type === "get_state")
      data = {
        sessionId,
        sessionFile,
        sessionName: name,
        model: { provider: "fake", id: "served" },
        isStreaming: !!active,
      };
    if (cmd.type === "get_entries") data = { entries, leafId: leaf };
    if (cmd.type === "navigate_tree") {
      const entry = entries.find((entry) => entry.id === cmd.targetId);
      success = entry !== undefined;
      if (entry) {
        leaf = cmd.intent === "resume" || entry.message?.role !== "user" ? entry.id : entry.parentId;
        data = { cancelled: false, leafId: leaf };
      }
    }
    if (cmd.type === "inspect")
      data = {
        commands,
        active: active?.clientMessageId,
        capabilities: [process.env.OMO_RPC_CLIENT_CAPABILITIES, process.env.SENPI_RPC_CLIENT_CAPABILITIES],
      };
    if (cmd.type === "set_session_name" || cmd.type === "native_title") {
      name = cmd.name;
      record("session_info", { name });
      send({ type: "session_info_changed", name });
    }
    if (cmd.type === "release") {
      if (active) assistant("stop", active);
      active = undefined;
      for (const next of queued.splice(0)) start(next);
      send({ type: "agent_end" });
      send({ type: "agent_idle" });
    }
    // Replays an arbitrary agent frame, e.g. an extension_event OmO would publish.
    if (cmd.type === "emit") send(cmd.frame);
    if (cmd.type === "exit") process.exit(3);
    if (cmd.type === "inject") {
      if (cmd.message === "interrupted-work") start(cmd);
      else {
        const injected = { message: cmd.message };
        user(injected);
        assistant("stop", injected);
      }
    }
    if (cmd.type === "compact") {
      // OmO: compaction_start, persisted entry, compaction_end with the result, then the reply.
      const firstKeptEntryId = entries.find((e) => e.type === "message")?.id ?? "none";
      send({ type: "compaction_start", reason: "manual" });
      record("compaction", { summary: "Summary of earlier work", firstKeptEntryId, tokensBefore: 1234 }, 3000);
      data = { summary: "Summary of earlier work", firstKeptEntryId, tokensBefore: 1234 };
      send({ type: "compaction_end", reason: "manual", result: data, aborted: false, willRetry: false });
    }
    if (cmd.type === "prompt") {
      if (active && !cmd.streamingBehavior) return;
      if (cmd.message === "reject") success = false;
      else if (active) {
        queued.push(cmd);
        record("custom", {
          customType: "rpc_client_message_admission",
          data: {
            durableSessionId: sessionId,
            clientMessageId: cmd.clientMessageId,
            state: "queued",
            disposition: "queued",
            prepared: { text: cmd.message, mode: cmd.streamingBehavior, enqueueOrder: queued.length },
          },
        });
        data = { disposition: "queued" };
      } else {
        start(cmd);
        data = { disposition: "started" };
      }
    }
    send({
      type: "response",
      id: cmd.id,
      command: cmd.type,
      success,
      data,
      ...(!success ? { error: "admission refused" } : {}),
    });
  })
  .on("close", () => process.exit(0));
