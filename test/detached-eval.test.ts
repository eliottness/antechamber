/// <reference types="node" />
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { SessionManager, type ManagedSession } from "../src/sessions.js";
import { ocIdFor, piSessionDir, SessionStore } from "../src/session-store.js";
import type { OCMessageWithParts, OCToolPart } from "../src/types.js";

const DETACHED = "Eval cell cell-1 detached and is running in the py kernel (0 other live cells).";
const args = { language: "py", code: "for i in range(3): print(i)", summary: "Count" };

// Shape built by senpi-codemode's detached-cell-notification.ts.
function notice(cellId: string, outcome: string, output: string): string {
  return [
    `<system-reminder>Detached eval cell ${cellId} (py) ${outcome}.`,
    output,
    "Kernel state updated - variables are available to the next eval cell.</system-reminder>",
  ].join("\n");
}

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "antechamber-detached-eval-"));
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  const previousState = process.env.ANTECHAMBER_STATE_DIR;
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  process.env.ANTECHAMBER_STATE_DIR = join(dir, "state");
  const directory = join(dir, "work");
  mkdirSync(directory);
  const sessionPath = join(piSessionDir(directory), "parent.jsonl");
  mkdirSync(dirname(sessionPath), { recursive: true });
  writeFileSync(
    sessionPath,
    JSON.stringify({
      type: "session",
      version: 3,
      id: "parent-pi",
      cwd: directory,
      timestamp: "2026-10-15T00:00:00Z",
    }) + "\n",
  );
  const managers: SessionManager[] = [];
  const open = (): { manager: SessionManager; session: ManagedSession } => {
    const manager = new SessionManager(() => {}, new SessionStore(join(dir, "state")), directory);
    managers.push(manager);
    const session = manager.get(ocIdFor("parent-pi"));
    assert.ok(session);
    manager.messages(session.info.id);
    return { manager, session };
  };
  t.after(async () => {
    for (const manager of managers) await manager.disposeAll();
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgent;
    if (previousState === undefined) delete process.env.ANTECHAMBER_STATE_DIR;
    else process.env.ANTECHAMBER_STATE_DIR = previousState;
    rmSync(dir, { recursive: true, force: true });
  });
  return { open, sessionPath };
}

function startEval(manager: SessionManager, session: ManagedSession, callID: string): void {
  manager["onPiEvent"](session, { type: "message_start", message: { role: "assistant" } });
  manager["onPiEvent"](session, {
    type: "message_update",
    assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: callID, toolName: "eval" },
  });
  manager["onPiEvent"](session, {
    type: "message_update",
    assistantMessageEvent: {
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: { id: callID, name: "eval", arguments: args },
    },
  });
  manager["onPiEvent"](session, { type: "tool_execution_start", toolCallId: callID, toolName: "eval", args });
}

function detach(manager: SessionManager, session: ManagedSession, callID: string): void {
  manager["onPiEvent"](session, {
    type: "tool_execution_end",
    toolCallId: callID,
    toolName: "eval",
    result: { content: [{ type: "text", text: DETACHED.replace("cell-1", callID) }] },
  });
}

function card(messages: OCMessageWithParts[] | undefined, callID: string): OCToolPart {
  const part = (messages ?? [])
    .flatMap((message) => message.parts)
    .find((p): p is OCToolPart => p.type === "tool" && p.callID === callID);
  assert.ok(part);
  return part;
}

test("a running eval card streams its cell output", (t) => {
  const { open } = setup(t);
  const { manager, session } = open();
  startEval(manager, session, "cell-1");
  manager["onPiEvent"](session, {
    type: "tool_execution_update",
    toolCallId: "cell-1",
    toolName: "eval",
    partialResult: { content: [{ type: "text", text: "0\n1" }] },
  });
  const part = card(session.messages, "cell-1");
  assert.equal(part.state.status, "running");
  assert.equal(part.state.status === "running" ? part.state.metadata?.output : undefined, "0\n1");
});

test("a detached cell's completion notice finishes its card with the final output", (t) => {
  const { open } = setup(t);
  const { manager, session } = open();
  startEval(manager, session, "cell-1");
  detach(manager, session, "cell-1");
  startEval(manager, session, "cell-2");
  detach(manager, session, "cell-2");
  const detached = card(session.messages, "cell-1").state;
  assert.ok(detached.status === "completed");
  assert.match(detached.output, /detached/);

  manager["onPiEvent"](session, {
    type: "message_end",
    message: {
      role: "custom",
      customType: "senpi-codemode:notification",
      display: false,
      content: `${notice("cell-1", "completed", "0\n1\n2\ndone")}\n\n${notice("cell-2", "cancelled", "(no output)")}`,
    },
  });

  const done = card(session.messages, "cell-1").state;
  assert.ok(done.status === "completed");
  assert.equal(done.output, "0\n1\n2\ndone");
  assert.equal(done.title, "Count");
  const cancelled = card(session.messages, "cell-2").state;
  assert.ok(cancelled.status === "error");
  assert.equal(cancelled.error, "Detached cell cancelled.");
});

test("a restored session applies a detached cell's completion from the session file", (t) => {
  const { open, sessionPath } = setup(t);
  appendFileSync(
    sessionPath,
    [
      { type: "message", id: "u", parentId: null, timestamp: 1, message: { role: "user", content: "count" } },
      {
        type: "message",
        id: "a",
        parentId: "u",
        timestamp: 2,
        message: { role: "assistant", content: [{ type: "toolCall", id: "cell-1", name: "eval", arguments: args }] },
      },
      {
        type: "message",
        id: "r",
        parentId: "a",
        timestamp: 3,
        message: {
          role: "toolResult",
          toolCallId: "cell-1",
          toolName: "eval",
          content: [{ type: "text", text: DETACHED }],
        },
      },
      {
        type: "custom_message",
        id: "n",
        parentId: "r",
        timestamp: 4,
        customType: "senpi-codemode:notification",
        display: false,
        content: notice("cell-1", "completed", "0\n1\n2\ndone"),
      },
    ]
      .map((entry) => `${JSON.stringify(entry)}\n`)
      .join(""),
  );
  const { manager, session } = open();
  const state = card(manager.messages(session.info.id), "cell-1").state;
  assert.ok(state.status === "completed");
  assert.equal(state.output, "0\n1\n2\ndone");
});
