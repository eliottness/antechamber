import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { parsePiSessionText } from "../src/session-history.js";
import { AdapterServer } from "../src/server.js";
import { backgroundResult } from "../src/background-results.js";
import { bindMessageEntries, getEntries, recordTurn } from "../src/session-tree.js";
import type { ManagedSession } from "../src/sessions.js";
import type { OCMessageWithParts, OCToolPart } from "../src/types.js";
import { bugHarness } from "./bug-harness.js";

const terminal = {
  type: "background_notification",
  entryID: "terminal-done",
  customType: "senpi-terminal:notification",
  content:
    "<system-reminder>Background terminal session bash_2 finished: killed (exit code 1).\nFinal output:\nfirst line\nlast line</system-reminder>",
};
const evaluation = {
  type: "background_notification",
  entryID: "eval-done",
  customType: "senpi-codemode:notification",
  content: "<system-reminder>Detached eval cell detached-cell (js) completed.\ncell output\n</system-reminder>",
};

/** First occurrence of a notification: content key plus occurrence index, as live and history derive it. */
function cardID(notification: { customType: string; content: string }): string {
  const result = backgroundResult(notification.customType, notification.content);
  assert.ok(result);
  return `${result.key}_0`;
}
const terminalID = cardID(terminal);
const orphanContent = "<system-reminder>Detached eval cell orphan (js) completed.\nfallback output</system-reminder>";
const orphanID = cardID({ customType: evaluation.customType, content: orphanContent });

function tools(messages: readonly OCMessageWithParts[]): OCToolPart[] {
  return messages.flatMap((message) => message.parts.filter((part): part is OCToolPart => part.type === "tool"));
}

async function started(t: TestContext) {
  const h = bugHarness(t);
  const info = await h.manager.create(h.root);
  await h.manager.prompt(info.id, "background-results", undefined, false, "msg_launch");
  const s = h.manager.get(info.id);
  assert.ok(s?.pi);
  return { h, s, pi: s.pi };
}

function restoredSession(s: ManagedSession): ManagedSession {
  return { ...s, tree: { messageEntries: {} }, messages: undefined };
}

test("background terminal completion emits a visible bash card and survives restart", async (t) => {
  const { h, s, pi } = await started(t);
  const statusEvents = h.events.filter((event) => event.type === "session.status").length;
  const completed = h.wait(
    (event) => event.type === "message.part.updated" && event.properties.part.id === `prt_background_${terminalID}`,
  );
  await pi.command(terminal);
  const event = await completed;
  assert.equal(event.type, "message.part.updated");
  if (event.type !== "message.part.updated") return;
  const part = event.properties.part;
  assert.equal(part.type, "tool");
  if (part.type !== "tool") return;
  assert.equal(part.tool, "bash");
  assert.equal(part.state.status, "completed");
  if (part.state.status !== "completed") return;
  assert.equal(part.state.title, "bash_2 finished: killed (exit code 1)");
  assert.equal(part.state.input.command, "bash_2\necho nested");
  assert.equal(part.state.output, "first line\nlast line");
  const message = h.manager.messages(s.info.id)?.find((message) => message.info.id === part.messageID);
  assert.ok(message?.info.role === "assistant");
  assert.equal(message.info.parentID, "msg_launch");
  assert.equal(message.info.time.completed, 3000);
  assert.equal(s.status.type, "idle");
  assert.equal(h.events.filter((event) => event.type === "session.status").length, statusEvents);
  // OmO sends no entry_appended for the notification, so the native ID arrives with the next tree read.
  assert.equal(s.tree.messageEntries[message.info.id], undefined);
  bindMessageEntries(s, await getEntries(pi));
  assert.equal(s.tree.messageEntries[message.info.id], "terminal-done");
  const live = structuredClone(message);
  await h.restart();
  // The fake agent's clock differs from the adapter's, so the launch time is compared in the JSONL test.
  const untimed = (value: OCMessageWithParts | undefined) =>
    value && {
      ...value,
      parts: value.parts.map((part) =>
        part.type === "tool" ? { ...part, state: { ...part.state, time: undefined } } : part,
      ),
    };
  assert.deepEqual(
    untimed(h.manager.messages(s.info.id)?.find((message) => message.info.id === live.info.id)),
    untimed(live),
  );
});

test("detached eval completion updates its original card live and from JSONL", async (t) => {
  const { h, s, pi } = await started(t);
  const original = tools(h.manager.messages(s.info.id) ?? []).find((part) => part.callID === "detached-cell");
  assert.ok(original);
  const identity = original.id;
  const count = h.manager.messages(s.info.id)?.length;
  const updated = h.wait(
    (event) =>
      event.type === "message.part.updated" &&
      event.properties.part.type === "tool" &&
      event.properties.part.callID === "detached-cell" &&
      event.properties.part.state.status === "completed" &&
      event.properties.part.state.output === "cell output\n",
  );
  await pi.command(evaluation);
  await updated;
  // OmO wakes the agent with this notification; that turn's end records the native tree.
  recordTurn(s);
  assert.equal(original.id, identity);
  assert.equal(h.manager.messages(s.info.id)?.length, count);
  assert.equal(original.state.status, "completed");
  assert.ok(s.piPath);
  const fromJSONL = parsePiSessionText(s, original.tool, readFileSync(s.piPath, "utf8"));
  const parsed = tools(fromJSONL).find((part) => part.callID === "detached-cell");
  assert.equal(parsed?.state.status === "completed" && parsed.state.output, "cell output\n");
  assert.equal(parsed?.state.status === "completed" && parsed.state.time.end, 3000);
  await h.restart();
  const reloaded = tools(h.manager.messages(s.info.id) ?? []).find((part) => part.callID === "detached-cell");
  assert.equal(reloaded?.id, original.id);
  assert.equal(reloaded?.callID, original.callID);
  assert.equal(reloaded?.state.status === "completed" && reloaded.state.output, "cell output\n");
});

test("failed eval notifications display their error without leaking reminder wrappers", async (t) => {
  const { h, s, pi } = await started(t);
  await pi.command({
    ...evaluation,
    content: "<system-reminder>Detached eval cell detached-cell (js) failed.\nError: cell failed</system-reminder>",
  });
  const part = tools(h.manager.messages(s.info.id) ?? []).find((part) => part.callID === "detached-cell");
  assert.equal(part?.state.status, "error");
  if (part?.state.status !== "error") return;
  assert.equal(part.state.error, "Error: cell failed");
  assert.ok(s.piPath);
  const history = parsePiSessionText(restoredSession(s), "test", readFileSync(s.piPath, "utf8"));
  assert.equal(tools(history).find((part) => part.callID === "detached-cell")?.state.status, "error");
});

test("unmatched eval notifications fall back to one deterministic bash card", async (t) => {
  const { h, s, pi } = await started(t);
  await pi.command({
    ...evaluation,
    entryID: "orphan-eval",
    content: orphanContent,
  });
  const message = h.manager.messages(s.info.id)?.find((message) => message.info.id === `msg_background_${orphanID}`);
  assert.ok(message);
  const part = tools([message])[0];
  assert.equal(part?.tool, "bash");
  assert.equal(part?.state.input.command, "orphan");
  assert.equal(part?.state.status === "completed" && part.state.output, "fallback output");
  assert.ok(s.piPath);
  const history = parsePiSessionText(restoredSession(s), "test", readFileSync(s.piPath, "utf8"));
  assert.equal(history.filter((message) => message.info.id === `msg_background_${orphanID}`).length, 1);
  assert.deepEqual(tools(history).find((candidate) => candidate.id === part?.id)?.state, part?.state);
});

test("terminal completion recovers direct bash input without matching bash ID prefixes", async (t) => {
  const { h, s, pi } = await started(t);
  const content =
    "<system-reminder>Background terminal session bash_20 finished: completed (exit code 0).\nFinal output:\ndirect output</system-reminder>";
  await pi.command({ ...terminal, content });
  const id = cardID({ customType: terminal.customType, content });
  const part = tools(h.manager.messages(s.info.id) ?? []).find((part) => part.id === `prt_background_${id}`);
  assert.equal(part?.state.input.command, "bash_20\necho direct");
});

test("other custom types remain invisible live and after history parsing", async (t) => {
  const { h, s, pi } = await started(t);
  const messages = h.manager.messages(s.info.id) ?? [];
  const count = messages.length;
  for (const customType of [
    "environment-context",
    "senpi-task.usage",
    "senpi.todo-first-turn",
    "senpi-monitor:notification",
  ])
    await pi.command({ ...terminal, customType, entryID: `ignored-${customType}` });
  assert.equal(messages.length, count);
  assert.ok(s.piPath);
  assert.equal(parsePiSessionText(restoredSession(s), "test", readFileSync(s.piPath, "utf8")).length, count);
});

test("a completion during an assistant stream leaves that message and tool lifecycle intact", async (t) => {
  const { h, s, pi } = await started(t);
  await h.manager.prompt(s.info.id, "hold", undefined, false, "msg_hold");
  const streaming = s.streaming;
  assert.ok(streaming);
  await pi.command(terminal);
  assert.equal(s.streaming, streaming);
  assert.equal(s.status.type, "busy");
  assert.equal(streaming.message.time.completed, undefined);
  await pi.command({
    type: "emit",
    frame: { type: "message_end", message: { role: "assistant", stopReason: "toolUse" } },
  });
  await pi.command({ type: "release" });
  assert.equal(s.status.type, "idle");
  assert.equal(s.streaming, undefined);
  assert.ok(
    h.manager.messages(s.info.id)?.every((message) => message.info.role !== "assistant" || message.info.time.completed),
  );
});

test("completion entry bindings cannot consume the next native assistant message", async (t) => {
  const { h, s, pi } = await started(t);
  await pi.command(terminal);
  await h.manager.prompt(s.info.id, "normal", undefined, false, "msg_next");
  const entries = await getEntries(pi);
  bindMessageEntries(s, entries);
  assert.equal(s.tree.messageEntries[`msg_background_${terminalID}`], "terminal-done");
  const last = h.manager.messages(s.info.id)?.at(-1);
  assert.ok(last?.info.role === "assistant");
  assert.equal(
    entries.entries.find((entry) => entry.id === s.tree.messageEntries[last.info.id])?.message?.role,
    "assistant",
  );
});

test("a background completion cannot replace a failed run's idle outcome", async (t) => {
  const { h, s, pi } = await started(t);
  await h.manager.prompt(s.info.id, "error");
  await pi.command(terminal);
  await pi.command({ type: "emit", frame: { type: "agent_idle" } });
  assert.equal(s.info.outcome, "failed");
});

for (const notification of [terminal, evaluation]) {
  test(`JSONL history rebuilds ${notification.customType} completion output`, async (t) => {
    const { s, pi } = await started(t);
    assert.ok(s.piPath);
    const raw = readFileSync(s.piPath, "utf8");
    const tree = await getEntries(pi);
    const entry = {
      type: "custom_message",
      id: notification.entryID,
      parentId: tree.leafId,
      timestamp: "2026-10-17T16:47:04.648Z",
      customType: notification.customType,
      content: notification.content,
      display: false,
    };
    const historySession = restoredSession(s);
    const history = parsePiSessionText(historySession, "test", `${raw}${JSON.stringify(entry)}\n`);
    const part = tools(history).find((part) =>
      notification === terminal ? part.id === `prt_background_${terminalID}` : part.callID === "detached-cell",
    );
    assert.ok(part, "completion must rebuild a visible tool card");
    assert.equal(part.state.status, "completed");
    if (part.state.status !== "completed") return;
    assert.equal(part.state.output, notification === terminal ? "first line\nlast line" : "cell output\n");
    if (notification === terminal) {
      assert.equal(part.state.input.command, "bash_2\necho nested");
      // The card spans the command's run: from the card that launched it to the notification.
      const launch = tools(history).find((candidate) => candidate.callID === "background-launch");
      assert.ok(launch && launch.state.status !== "pending");
      assert.equal(part.state.time.start, launch.state.time.start);
      assert.ok(part.state.time.end > part.state.time.start);
    }

    const before = restoredSession(s);
    before.tree.leafId = tree.leafId;
    const abandoned = parsePiSessionText(before, "test", `${raw}${JSON.stringify(entry)}\n`);
    assert.equal(
      tools(abandoned).some((part) => part.id === `prt_background_${terminalID}`),
      false,
    );
    assert.ok(
      tools(abandoned).some(
        (part) =>
          part.callID === "detached-cell" &&
          part.state.status === "completed" &&
          part.state.output.startsWith("Eval cell detached-cell detached"),
      ),
    );
  });
}

test("v1 paging keeps completion cards and their user anchor beyond 190 results after reload", async (t) => {
  const { h, s, pi } = await started(t);
  await h.manager.prompt(s.info.id, "normal", undefined, false, "msg_page");
  for (let index = 0; index < 192; index++)
    await pi.command({ ...terminal, entryID: `page-result-${index}`, timestamp: 4000 + index });
  await h.restart();
  const server = new AdapterServer({ host: "127.0.0.1", port: 0, defaultDirectory: h.root });
  t.after(() => server.stop());
  await server.start();
  const base = `${server.url}/session/${s.info.id}/message`;
  const response = await fetch(`${base}?limit=30`);
  assert.equal(response.status, 200);
  const page = (await response.json()) as OCMessageWithParts[];
  assert.equal(page[0]?.info.id, "msg_page");
  assert.equal(tools(page).length, 192);
  assert.equal(response.headers.get("x-next-cursor"), "msg_page");
  assert.ok(page.every((message) => message.info.role !== "assistant" || message.info.parentID === "msg_page"));
  const older = (await (await fetch(`${base}?limit=30&before=msg_page`)).json()) as OCMessageWithParts[];
  const all = (await (await fetch(base)).json()) as OCMessageWithParts[];
  assert.deepEqual([...older, ...page], all);
  assert.equal(new Set(all.map((message) => message.info.id)).size, all.length);
});

function card(messages: readonly OCMessageWithParts[] | undefined, callID: string): OCToolPart {
  const part = tools(messages ?? []).find((candidate) => candidate.callID === callID);
  assert.ok(part, `card ${callID}`);
  return part;
}

test("a card that started background work keeps running until that work reports finishing", async (t) => {
  // Given: a turn whose cells left bash_2, bash_20 and a detached cell running; the turn has ended.
  const { h, s, pi } = await started(t);
  for (const callID of ["background-launch", "direct-launch", "detached-cell"]) {
    const part = card(h.manager.messages(s.info.id), callID);
    assert.equal(part.state.status, "running", `${callID} waits for its background work past the turn`);
  }
  const launch = card(h.manager.messages(s.info.id), "background-launch");
  assert.ok(launch.state.status === "running");
  assert.deepEqual(launch.state.metadata?.backgroundWaits, ["bash_2"]);
  assert.equal(launch.state.metadata?.output, "Command running in background with ID: bash_2\n\nfirst line");
  const finished = h.wait(
    (event) =>
      event.type === "message.part.updated" &&
      event.properties.part.type === "tool" &&
      event.properties.part.callID === "background-launch" &&
      event.properties.part.state.status === "completed",
  );
  // When: bash_2 reports finishing.
  await pi.command(terminal);
  await finished;
  // Then: only its launcher ends, at the notice's time, with the result it already showed.
  const done = card(h.manager.messages(s.info.id), "background-launch");
  assert.ok(done.state.status === "completed");
  assert.equal(done.state.output, "Command running in background with ID: bash_2\n\nfirst line");
  // The fake agent's clock is behind the adapter's; the JSONL test checks the end against the notice.
  assert.ok(done.state.time.end >= done.state.time.start);
  assert.equal(done.state.metadata?.backgroundWaits, undefined);
  assert.equal(card(h.manager.messages(s.info.id), "direct-launch").state.status, "running");
  assert.equal(s.status.type, "idle");
});

test("cards still waiting end when the agent process exits", async (t) => {
  const { h, s, pi } = await started(t);
  const exited = h.wait(
    (event) =>
      event.type === "message.part.updated" &&
      event.properties.part.type === "tool" &&
      event.properties.part.callID === "direct-launch" &&
      event.properties.part.state.status === "completed",
  );
  pi.notify({ type: "exit" });
  await exited;
  assert.equal(card(h.manager.messages(s.info.id), "direct-launch").state.status, "completed");
});

test("history rebuild ends every waiting card, at its finish notice when there is one", async (t) => {
  const { s, pi } = await started(t);
  assert.ok(s.piPath);
  const tree = await getEntries(pi);
  const notice = {
    type: "custom_message",
    id: "terminal-done",
    parentId: tree.leafId,
    timestamp: "2026-10-17T16:47:04.648Z",
    customType: terminal.customType,
    content: terminal.content,
    display: false,
  };
  const raw = `${readFileSync(s.piPath, "utf8")}${JSON.stringify(notice)}\n`;
  const history = parsePiSessionText(restoredSession(s), "test", raw);
  const launch = card(history, "background-launch");
  assert.ok(launch.state.status === "completed");
  assert.equal(launch.state.time.end, Date.parse(notice.timestamp));
  const direct = card(history, "direct-launch");
  assert.ok(direct.state.status === "completed", "no notice, but nothing can still run after a rebuild");
  assert.equal(direct.state.output, "Command running in background with ID: bash_20");
});

test("a reused shell id is matched to its own launch, and a trimmed detach hint still makes the cell wait", () => {
  // Shapes from a preview session, 2026-10-17: after an OmO restart the next background shell is bash_1 again,
  // and the detached cell's tail-trimmed output keeps only the bash_output hint for it.
  const at = (s: number) => new Date(Date.UTC(2026, 9, 17, 21, 0, s)).toISOString();
  const call = (id: string) => ({
    type: "toolCall",
    id,
    name: "eval",
    arguments: { language: "js", code: "x", summary: id },
  });
  const assistant = (id: string, parent: string | null, s: number, callID: string) => ({
    type: "message",
    id,
    parentId: parent,
    timestamp: at(s),
    message: { role: "assistant", content: [call(callID)], stopReason: "toolUse", timestamp: Date.parse(at(s)) },
  });
  const result = (id: string, parent: string, s: number, callID: string, text: string) => ({
    type: "message",
    id,
    parentId: parent,
    timestamp: at(s),
    message: {
      role: "toolResult",
      toolCallId: callID,
      toolName: "eval",
      content: [{ type: "text", text }],
      isError: false,
      timestamp: Date.parse(at(s)),
    },
  });
  const notice = (id: string, parent: string, s: number, customType: string, text: string) => ({
    type: "custom_message",
    id,
    parentId: parent,
    timestamp: at(s),
    customType,
    content: text,
    display: false,
  });
  const hint =
    'Continue other work; completion will be reported automatically. Use bash_output({ bash_id: "bash_1" }) only to peek at new output.';
  const entries = [
    assistant("a1", null, 0, "old-cell"),
    result(
      "r1",
      "a1",
      5,
      "old-cell",
      "Command is still running; auto-detached to background with ID: bash_1 (not killed)",
    ),
    notice(
      "n1",
      "r1",
      10,
      "senpi-terminal:notification",
      "Background terminal session bash_1 finished: completed (exit code 0).\nFinal output:\nOLD",
    ),
    assistant("a2", "n1", 100, "new-cell"),
    result("r2", "a2", 160, "new-cell", "Eval cell new-cell detached and is running in the background."),
    notice(
      "n2",
      "r2",
      170,
      "senpi-codemode:notification",
      `Detached eval cell new-cell (js) completed.\n--- call 3 ---\nB75 60\n\n${hint}`,
    ),
    notice(
      "n3",
      "n2",
      180,
      "senpi-terminal:notification",
      "Background terminal session bash_1 finished: completed (exit code 0).\nFinal output:\nB75_DONE",
    ),
    notice(
      "n4",
      "n3",
      190,
      "senpi-terminal:notification",
      "Background terminal session bash_1 finished: completed (exit code 0).\nFinal output:\nNO_LAUNCH",
    ),
  ];
  const managed: ManagedSession = {
    info: {
      id: "ses_reuse",
      projectID: "/tmp/r",
      directory: "/tmp/r",
      title: "r",
      version: "test",
      time: { created: 0, updated: 0 },
    },
    pi: undefined,
    model: undefined,
    streaming: undefined,
    status: { type: "idle" },
    messages: [],
    toolByCallId: new Map(),
    tree: { messageEntries: {} },
    hasPendingInteraction: () => false,
    hasRunningChildren: () => false,
  };
  const history = parsePiSessionText(managed, "test", `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  const cell = tools(history).find((part) => part.callID === "new-cell");
  assert.ok(cell?.state.status === "completed");
  assert.equal(cell.state.time.end, Date.parse(at(180)), "the cell waits for the shell its trimmed output names");
  const finished = tools(history).filter((part) => part.callID.startsWith("call_background_"));
  assert.equal(finished.length, 3);
  const [, own, unclaimed] = finished;
  assert.ok(own && own.state.status !== "pending");
  assert.equal(own.state.time.start, Date.parse(at(100)), "started with this cell, not the earlier bash_1 launch");
  assert.ok(unclaimed && unclaimed.state.status !== "pending");
  assert.equal(unclaimed.state.time.start, Date.parse(at(190)), "an already-finished launch is not borrowed");
});
