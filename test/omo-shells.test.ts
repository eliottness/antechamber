import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { bugHarness, openEvents } from "./bug-harness.js";
import { finishToolPart } from "../src/background-results.js";
import { MONITOR_ENDED_EVENT, MONITOR_STATE_EVENT } from "../src/monitor-sessions.js";
import { evalShellId, OutputLog, type ShellOutputPage, terminalShellId } from "../src/omo-shells.js";
import { AdapterServer } from "../src/server.js";
import type { ManagedSession, SessionManager } from "../src/sessions.js";
import type { OCShellInfo, OCToolPart } from "../src/types.js";
import { toV2Message, V2EventTranslator } from "../src/v2.js";

const monitor = {
  id: "bash_7",
  description: "wait for the build",
  paused: false,
  startedAtMs: 1_760_000_000_000,
  command: "tail -F build.log",
  filter: "^DONE$",
  persistent: true,
  deadlineMs: null,
  fireCount: 0,
  lastFiredAtMs: null,
};

async function startServer(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "antechamber-shells-"));
  const saved = new Map(
    ["ANTECHAMBER_PI_BINARY", "ANTECHAMBER_STATE_DIR", "PI_CODING_AGENT_DIR"].map((key) => [key, process.env[key]]),
  );
  process.env.ANTECHAMBER_PI_BINARY = resolve("test/fixtures/turn-omo.mjs");
  process.env.ANTECHAMBER_STATE_DIR = join(directory, "state");
  process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
  const server = new AdapterServer({ host: "127.0.0.1", port: 0, defaultDirectory: directory });
  t.after(async () => {
    await server.stop();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  await server.start();
  const manager = (server as unknown as { sessions: SessionManager }).sessions;
  return { manager, url: server.url };
}

async function emit(s: ManagedSession, frame: Record<string, unknown>): Promise<void> {
  assert.ok(s.pi);
  // The fake agent writes the frame before its reply, so the frame is handled once this resolves.
  const reply = await s.pi.command({ type: "emit", frame });
  assert.equal(reply.success, true);
}

const extensionEvent = (name: string, data: unknown) => ({ type: "extension_event", name, data });

test("OmO background work is listed and announced as OpenCode shells, readable, and stoppable where OmO allows", async (t) => {
  const { manager, url } = await startServer(t);
  const created = await fetch(`${url}/session`, { method: "POST", body: "{}" });
  const { id, directory } = (await created.json()) as { id: string; directory: string };
  const s = manager.get(id);
  assert.ok(s?.pi && s.piPath && s.piSessionId);
  const v2 = await openEvents(`${url}/api/event`);
  t.after(() => v2.close());
  const monitorShell = terminalShellId(s.pi.startedAtMs, "bash_7");
  const backgroundShell = terminalShellId(s.pi.startedAtMs, "bash_3");
  const cellShell = evalShellId("cell_1");
  const shellFrame = (type: string, shellID: string) => (event: Record<string, unknown>) => {
    const data = event.data as { info?: { id?: string }; id?: string };
    return event.type === type && (data.info?.id ?? data.id) === shellID;
  };

  // A watch: announced on the v2 stream with OpenCode's Shell.Info shape and its session.
  const monitorCreated = v2.wait(shellFrame("shell.created", monitorShell));
  await emit(s, extensionEvent(MONITOR_STATE_EVENT, { activeCount: 1, monitors: [monitor] }));
  const announced = await monitorCreated;
  assert.deepEqual(announced.location, { directory });
  assert.deepEqual((announced.data as { info: OCShellInfo }).info, {
    id: monitorShell,
    status: "running",
    command: "tail -F build.log",
    cwd: directory,
    shell: "bash",
    file: "",
    metadata: { sessionID: id, omo: { kind: "monitor", id: "bash_7" } },
    time: { started: monitor.startedAtMs },
  });

  // A detached eval cell (codemode's wake source) and a background terminal session (the manifest).
  const cellCreated = v2.wait(shellFrame("shell.created", cellShell));
  await emit(
    s,
    extensionEvent("wake_source_state", {
      source: "senpi-codemode",
      activeCount: 1,
      items: [{ id: "cell_1", description: "build the docs", startedAtMs: Date.now() }],
    }),
  );
  await cellCreated;
  const manifest = join(dirname(s.piPath), "extensions", "terminal", `${encodeURIComponent(s.piSessionId)}.json`);
  mkdirSync(dirname(manifest), { recursive: true });
  writeFileSync(
    manifest,
    JSON.stringify({
      version: 1,
      sessionId: s.piSessionId,
      monitors: [],
      backgroundSessions: [
        { id: "bash_3", command: "npm run dev", startedAtMs: Date.now(), runtime: { pid: process.pid } },
        // An entry of an earlier agent process: its pid may belong to anything now.
        { id: "bash_1", command: "stale", startedAtMs: s.pi.startedAtMs - 1, runtime: { pid: process.pid } },
      ],
    }),
  );

  const list = (await (await fetch(`${url}/api/shell`)).json()) as {
    location: { directory: string };
    data: OCShellInfo[];
  };
  assert.deepEqual(
    list.data.map((shell) => shell.id),
    [monitorShell, cellShell, backgroundShell],
  );
  assert.equal(list.location.directory, directory);
  assert.equal(list.data[2]?.command, "npm run dev");
  const one = (await (await fetch(`${url}/api/shell/${backgroundShell}`)).json()) as {
    location: unknown;
    data: OCShellInfo;
  };
  assert.deepEqual(one.location, { directory });
  assert.equal(one.data.id, backgroundShell);
  assert.equal((await fetch(`${url}/api/shell/sh_unknown`)).status, 404);

  // Output: a watch's matched lines, an eval cell's tail read on from a cursor, a notice for a session.
  const notification = {
    role: "custom",
    customType: "senpi-monitor:notification",
    content: "<system-reminder>Monitor event(wait for the build): DONE</system-reminder>",
    display: false,
    details: { monitors: [{ id: "bash_7", description: monitor.description, eventCount: 1, kinds: ["line"] }] },
  };
  await emit(s, { type: "message_start", message: notification });
  const watched = await output(url, monitorShell);
  assert.equal(watched.output, "$ tail -F build.log\nfilter: ^DONE$\n\nDONE\n");
  const cell = { cellId: "cell_1", language: "js", state: "running", startedAtMs: 1, outputTail: "step 1\nstep 2\n" };
  await s.pi.command({ type: "set_eval_cells", cells: [cell] });
  const first = await output(url, cellShell);
  assert.deepEqual(first, { output: "step 1\nstep 2\n", cursor: 14, size: 14, truncated: false });
  await s.pi.command({ type: "set_eval_cells", cells: [{ ...cell, outputTail: "step 1\nstep 2\nstep 3\n" }] });
  assert.equal((await output(url, cellShell, "?cursor=14")).output, "step 3\n");
  assert.match((await output(url, backgroundShell)).output, /bash_output/);

  // Stop: OpenChamber's note goes first; it is refused for work OmO cannot stop, so nothing is claimed.
  const note = (shellIDs: string[]) =>
    fetch(`${url}/api/session/${id}/synthetic`, {
      method: "POST",
      body: JSON.stringify({ text: "stopped", metadata: { openchamberShellCancellation: { shellIDs } } }),
    });
  assert.equal((await note([monitorShell])).status, 400);
  assert.equal((await note([cellShell, backgroundShell])).status, 400);
  assert.equal((await fetch(`${url}/api/shell/${monitorShell}`, { method: "DELETE" })).status, 400);
  assert.equal((await note([cellShell])).status, 200);
  assert.equal((await fetch(`${url}/api/shell/${cellShell}`, { method: "DELETE" })).status, 204);
  const peeked = await s.pi.command<{ state: string }>({ type: "eval_cells.peek", cellId: "cell_1" });
  assert.equal(peeked.data?.state, "cancelled");

  // Ends, each with how OmO says it ended: the stopped cell, the watch's exit code, the session's notice.
  const cellKilled = v2.wait(shellFrame("shell.exited", cellShell));
  await emit(s, extensionEvent("wake_source_state", { source: "senpi-codemode", activeCount: 0, items: [] }));
  assert.deepEqual((await cellKilled).data, { id: cellShell, status: "killed" });
  const monitorExited = v2.wait(shellFrame("shell.exited", monitorShell));
  await emit(s, extensionEvent(MONITOR_ENDED_EVENT, { id: "bash_7", reason: "exit", exitCode: 0 }));
  await emit(s, extensionEvent(MONITOR_STATE_EVENT, { activeCount: 0, monitors: [] }));
  assert.deepEqual((await monitorExited).data, { id: monitorShell, status: "exited", exit: 0 });
  writeFileSync(
    manifest,
    JSON.stringify({ version: 1, sessionId: s.piSessionId, monitors: [], backgroundSessions: [] }),
  );
  const backgroundEnded = v2.wait(shellFrame("shell.exited", backgroundShell));
  // Raw RPC capture shape (background-results.test.ts): OmO's notice when a background session finishes.
  await s.pi.command({
    type: "background_notification",
    entryID: "bash-3-done",
    customType: "senpi-terminal:notification",
    content:
      "<system-reminder>Background terminal session bash_3 finished: killed (exit code 137).\nFinal output:\nbye</system-reminder>",
  });
  assert.deepEqual((await backgroundEnded).data, { id: backgroundShell, status: "killed", exit: 137 });
  const after = (await (await fetch(`${url}/api/shell`)).json()) as { data: OCShellInfo[] };
  assert.deepEqual(after.data, []);
  const ended = (await (await fetch(`${url}/api/shell/${monitorShell}`)).json()) as { data: OCShellInfo };
  assert.equal(ended.data.status, "exited");
});

async function output(url: string, shellID: string, query = ""): Promise<ShellOutputPage> {
  const response = await fetch(`${url}/api/shell/${shellID}/output${query}`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { location?: unknown; data: ShellOutputPage };
  assert.ok(body.location, "OpenChamber reads the page from the {location, data} envelope");
  return body.data;
}

test("a session whose agent antechamber stops, or that is removed, ends every shell it ran", async (t) => {
  const { manager, url } = await startServer(t);
  const v2 = await openEvents(`${url}/api/event`);
  t.after(() => v2.close());
  const started = async () => {
    const { id } = (await (await fetch(`${url}/session`, { method: "POST", body: "{}" })).json()) as { id: string };
    const s = manager.get(id);
    assert.ok(s?.pi);
    const shellID = terminalShellId(s.pi.startedAtMs, "bash_7");
    const created = v2.wait(
      (event) => event.type === "shell.created" && (event.data as { info: OCShellInfo }).info.id === shellID,
    );
    await emit(s, extensionEvent(MONITOR_STATE_EVENT, { activeCount: 1, monitors: [monitor] }));
    await created;
    return { id, s, shellID };
  };
  const exited = (shellID: string) =>
    v2.wait((event) => event.type === "shell.exited" && (event.data as { id: string }).id === shellID);

  // Idle eviction and a failed tree refresh dispose the agent through lifecycle.dormant, which unwires its exit handler.
  const dormant = await started();
  const dormantEnded = exited(dormant.shellID);
  await manager.lifecycle.dormant(dormant.s);
  assert.deepEqual((await dormantEnded).data, { id: dormant.shellID, status: "killed" });

  const removed = await started();
  const removedEnded = exited(removed.shellID);
  assert.equal((await fetch(`${url}/session/${removed.id}`, { method: "DELETE" })).status, 200);
  assert.deepEqual((await removedEnded).data, { id: removed.shellID, status: "killed" });
  const after = (await (await fetch(`${url}/api/shell`)).json()) as { data: OCShellInfo[] };
  assert.deepEqual(after.data, []);
});

test("a watch's output keeps its header once and every matched line in order past the kept 200", async (t) => {
  const { manager, url } = await startServer(t);
  const { id } = (await (await fetch(`${url}/session`, { method: "POST", body: "{}" })).json()) as { id: string };
  const s = manager.get(id);
  assert.ok(s?.pi);
  const shellID = terminalShellId(s.pi.startedAtMs, "bash_7");
  await emit(s, extensionEvent(MONITOR_STATE_EVENT, { activeCount: 1, monitors: [monitor] }));
  const notify = (from: number, count: number) => {
    const lines = Array.from({ length: count }, (_, index) => `line ${from + index}`);
    const message = {
      role: "custom",
      customType: "senpi-monitor:notification",
      content: `<system-reminder>Monitor event(wait for the build): ${lines.join("\n")}</system-reminder>`,
      display: false,
      details: { monitors: [{ id: "bash_7", description: monitor.description, eventCount: count, kinds: ["line"] }] },
    };
    return emit(s, { type: "message_start", message });
  };
  await notify(0, 150);
  const first = await output(url, shellID);
  await notify(150, 100);
  const second = await output(url, shellID, `?cursor=${first.cursor}`);
  const all = `${first.output}${second.output}`;
  assert.equal(all.split("$ tail -F build.log").length - 1, 1);
  const expected = Array.from({ length: 250 }, (_, index) => `line ${index}`).join("\n");
  assert.equal(all, `$ tail -F build.log\nfilter: ^DONE$\n\n${expected}\n`);
  assert.equal(second.output, `${Array.from({ length: 100 }, (_, index) => `line ${150 + index}`).join("\n")}\n`);
});

function card(s: ManagedSession, callID: string): OCToolPart {
  const part = s.messages
    ?.flatMap((message) => message.parts)
    .find((item): item is OCToolPart => item.type === "tool" && item.callID === callID);
  assert.ok(part, callID);
  return part;
}

test("on v2 a card that left work running settles at once and names the shell it waits on", async (t) => {
  // Given: the fake agent's turn leaves bash_2 (background-launch) and a detached cell running.
  const h = bugHarness(t);
  const info = await h.manager.create(h.root);
  await h.manager.prompt(info.id, "background-results", undefined, false, "msg_launch");
  const s = h.manager.get(info.id);
  assert.ok(s?.pi);
  const expected = {
    "background-launch": terminalShellId(s.pi.startedAtMs, "bash_2"),
    "detached-cell": evalShellId("detached-cell"),
  };
  for (const [callID, shellID] of Object.entries(expected)) {
    assert.equal(card(s, callID).state.status, "running", `${callID} still waits on v1`);
    const frames = h.frames.filter((frame) => frame.data.id === callID);
    const success = frames.filter((frame) => frame.type === "session.tool.success");
    assert.equal(success.length, 1, callID);
    const metadata = success[0]?.data.metadata as Record<string, unknown>;
    assert.equal(metadata.status, "running");
    assert.equal(metadata.shellID, shellID);
    assert.equal(metadata.backgroundWaits, undefined);
    const index = frames.indexOf(success[0]!);
    assert.ok(!frames.slice(index + 1).some((frame) => frame.type === "session.tool.progress"), callID);
    // A history read agrees with the stream.
    const listed = s.messages
      ?.map((message) => toV2Message(message))
      .flatMap((message) => ("content" in message && Array.isArray(message.content) ? message.content : []))
      .find((part) => (part as { id?: string }).id === callID) as
      | { state: { status: string; metadata: Record<string, unknown> } }
      | undefined;
    assert.equal(listed?.state.status, "completed");
    assert.equal(listed?.state.metadata.shellID, shellID);
  }
  // When bash_2 finishes, its card ends as a plain completed card on both streams.
  const finished = h.wait(
    (event) =>
      event.type === "message.part.updated" &&
      event.properties.part.type === "tool" &&
      event.properties.part.callID === "background-launch" &&
      event.properties.part.state.status === "completed",
  );
  await s.pi.command({
    type: "background_notification",
    entryID: "terminal-done",
    customType: "senpi-terminal:notification",
    content:
      "<system-reminder>Background terminal session bash_2 finished: completed.\nFinal output:\nok</system-reminder>",
  });
  await finished;
  const done = card(s, "background-launch");
  assert.equal(done.state.status === "completed" ? done.state.metadata?.backgroundShellID : "running", undefined);
  const last = h.frames.findLast(
    (frame) => frame.data.id === "background-launch" && frame.type === "session.tool.success",
  );
  assert.ok(last);
  assert.equal((last.data.metadata as Record<string, unknown>).shellID, undefined);
});

test("a monitor call names its watch's shell; other completed calls do not", () => {
  const part = (tool: string, callID: string): OCToolPart => ({
    id: `prt_${callID}`,
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "tool",
    callID,
    tool,
    state: { status: "running", input: {}, time: { start: 1 } },
  });
  // senpi terminal/tools/monitor.js: textResult(`Monitor started with ID: ${monitorId}`, {details: {...}}).
  const watch = part("monitor", "call_watch");
  const result = {
    content: [{ type: "text", text: "Monitor started with ID: mon_1" }],
    details: { monitor_id: "mon_1", bash_id: "bash_4", monitor: true },
  };
  finishToolPart(watch, result, "call_watch", 10, 1000);
  const read = part("read", "call_read");
  finishToolPart(
    read,
    { content: [{ type: "text", text: "x" }], details: { bash_id: "bash_9" } },
    "call_read",
    10,
    1000,
  );
  const translator = new V2EventTranslator();
  const metadata = (p: OCToolPart) =>
    translator
      .translate("/repo", { type: "message.part.updated", properties: { part: p } })
      .find((frame) => frame.type === "session.tool.success")?.data.metadata as Record<string, unknown> | undefined;
  const watched = metadata(watch);
  assert.equal(watched?.shellID, terminalShellId(1000, "bash_4"));
  assert.equal(watched?.status, "running");
  const plain = metadata(read);
  assert.ok(plain);
  assert.equal(plain.shellID, undefined);
  assert.equal(plain.status, undefined);
  // A history read agrees with the stream for a finished monitor card.
  const listed = toV2Message({
    info: {
      id: "msg_1",
      sessionID: "ses_1",
      role: "assistant",
      time: { created: 1, completed: 10 },
      parentID: "msg_0",
      modelID: "m",
      providerID: "p",
      mode: "build",
      path: { cwd: "/repo", root: "/repo" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [watch, read],
  });
  const content = ("content" in listed && Array.isArray(listed.content) ? listed.content : []) as Array<{
    id: string;
    state: { metadata: Record<string, unknown> };
  }>;
  assert.equal(
    content.find((part) => part.id === "call_watch")?.state.metadata.shellID,
    terminalShellId(1000, "bash_4"),
  );
  assert.equal(content.find((part) => part.id === "call_read")?.state.metadata.shellID, undefined);
});

test("output windows that slide past their start keep an append-only cursor", () => {
  const log = new OutputLog();
  log.update("a1\na2\na3\n");
  assert.deepEqual(log.read(0, 100), { output: "a1\na2\na3\n", cursor: 9, size: 9, truncated: false });
  // The source keeps only its tail: a2 fell out while a4 and a5 arrived.
  log.update("a3\na4\na5\n");
  assert.deepEqual(log.read(9, 100), { output: "a4\na5\n", cursor: 15, size: 15, truncated: false });
  log.update("a3\na4\na5\n");
  assert.equal(log.size, 15);
  // A window that shares nothing with what is known is appended whole.
  log.update("zz\n");
  assert.deepEqual(log.read(15, 2), { output: "zz", cursor: 17, size: 18, truncated: false });
});

test("output pages never split a character", () => {
  const log = new OutputLog();
  log.append("aé€b"); // bytes: a(1) é(2) €(3) b(1)
  assert.deepEqual(log.read(0, 2), { output: "a", cursor: 1, size: 7, truncated: false });
  assert.deepEqual(log.read(1, 1), { output: "é", cursor: 3, size: 7, truncated: false });
  // A cursor inside a character (a client's own tail start) moves to the next one.
  assert.deepEqual(log.read(4, 10), { output: "b", cursor: 7, size: 7, truncated: false });
});
