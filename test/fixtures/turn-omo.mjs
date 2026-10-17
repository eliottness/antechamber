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
let thinkingLevel = entries.filter((e) => e.type === "thinking_level_change").at(-1)?.thinkingLevel ?? "medium";
let nestedEntries;
// OmO cancels a compaction when its tool set changes (e.g. MCP servers connecting after startup).
let cancelledCompacts = Number(process.env.ANTECHAMBER_TEST_CANCELLED_COMPACTS ?? 0);
let heldCompact;
const queued = [];
const commands = [];
const send = (v) => process.stdout.write(`${JSON.stringify(v)}\n`);
const record = (type, fields, time = 2000) => {
  const entry = { type, id: randomUUID(), parentId: leaf, timestamp: time, ...fields };
  entries.push(entry);
  leaf = entry.id;
  appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
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
  if (cmd.message === "nested-eval" || cmd.message === "nested-final") {
    // Frame shapes: raw RPC capture of installed omo-ai 5.1.33 / senpi runtime, 2026-10-17.
    // Nested calls have no execution frames of their own; previews arrive after each call finishes.
    nestedEntries = readFileSync(new URL("./eval-nested.jsonl", import.meta.url), "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    const message = nestedEntries.find((entry) => entry.id === "nested-assistant").message;
    send({ type: "message_start", message, clientMessageId: cmd.clientMessageId });
    for (const [contentIndex, block] of message.content.entries()) {
      send({
        type: "message_update",
        assistantMessageEvent:
          block.type === "toolCall"
            ? { type: "toolcall_end", contentIndex, toolCall: block }
            : { type: "text_end", contentIndex, content: block.text },
      });
    }
    record("message", { message }, 2000);
    send({ type: "message_end", message });
    const args = message.content[1].arguments;
    send({ type: "tool_execution_start", toolCallId: "eval-parent", toolName: "eval", args });
    if (cmd.message === "nested-eval") {
      const result = nestedEntries.find((entry) => entry.id === "nested-result").message;
      const partialResult = {
        content: [{ type: "text", text: "1/1 cells running\n[1] js Nested calls running" }],
        details: {
          ...result.details,
          durationMs: 0,
          toolCallCount: 2,
          toolCalls: result.details.toolCalls.slice(0, 2),
          cells: result.details.cells.map((cell) => ({ ...cell, status: "running", output: "", durationMs: 0 })),
        },
      };
      for (let update = 0; update < 2; update++)
        send({ type: "tool_execution_update", toolCallId: "eval-parent", toolName: "eval", args, partialResult });
    }
    return;
  }
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
    let error = "admission refused";
    const cancelCompaction = () => {
      send({ type: "compaction_end", reason: "manual", aborted: true, willRetry: false });
      success = false;
      error = "Compaction cancelled";
    };
    if (cmd.type === "get_state")
      data = {
        sessionId,
        sessionFile,
        sessionName: name,
        model: { provider: "fake", id: "served" },
        thinkingLevel,
        isStreaming: !!active,
      };
    // Real OmO appends the change as a tree entry on the active branch.
    if (cmd.type === "set_thinking_level") {
      thinkingLevel = cmd.level;
      record("thinking_level_change", { thinkingLevel });
      send({ type: "thinking_level_changed", level: thinkingLevel });
    }
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
    if (cmd.type === "nested_finish" && nestedEntries) {
      const result = nestedEntries.find((entry) => entry.id === "nested-result").message;
      const sibling = nestedEntries.find((entry) => entry.id === "sibling-result").message;
      if (cmd.via !== "turn") {
        const { details, ...withoutDetails } = result;
        send({
          type: "tool_execution_end",
          toolCallId: result.toolCallId,
          toolName: result.toolName,
          result: cmd.via === "late" ? withoutDetails : result,
          isError: false,
        });
      }
      record("message", { message: result }, 12000);
      record("message", { message: sibling }, 12001);
      send({ type: "turn_end", toolResults: [result, sibling] });
      assistant("stop", active);
      active = undefined;
      nestedEntries = undefined;
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
      send({ type: "compaction_start", reason: "manual" });
      if (process.env.ANTECHAMBER_TEST_HOLD_COMPACT === "1") {
        heldCompact = cmd;
        return;
      }
      if (cancelledCompacts > 0) {
        cancelledCompacts--;
        cancelCompaction();
      }
    }
    if (cmd.type === "compact" && success) {
      const firstKeptEntryId = entries.find((e) => e.type === "message")?.id ?? "none";
      record("compaction", { summary: "Summary of earlier work", firstKeptEntryId, tokensBefore: 1234 }, 3000);
      data = { summary: "Summary of earlier work", firstKeptEntryId, tokensBefore: 1234 };
      send({ type: "compaction_end", reason: "manual", result: data, aborted: false, willRetry: false });
    }
    if (cmd.type === "abort" && heldCompact) {
      cancelCompaction();
      send({ type: "response", id: heldCompact.id, command: "compact", success, error });
      heldCompact = undefined;
      success = true;
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
      ...(!success ? { error } : {}),
    });
  })
  .on("close", () => process.exit(0));
