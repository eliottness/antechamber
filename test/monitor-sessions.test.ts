/// <reference types="node" />
import assert from "node:assert/strict";
import test from "node:test";
import { bugHarness } from "./bug-harness.js";
import { MONITOR_ENDED_EVENT, MONITOR_STATE_EVENT } from "../src/monitor-sessions.js";
import { ocIdFor } from "../src/session-store.js";
import type { ManagedSession } from "../src/sessions.js";
import type { OCMessageWithParts, OCToolPart } from "../src/types.js";

const monitor = {
  id: "bash_7",
  description: "wait for the build",
  paused: false,
  startedAtMs: 1_760_000_000_000,
  command: "tail -F build.log",
  filter: "^DONE$",
  persistent: false,
  deadlineMs: 1_760_000_600_000,
  fireCount: 0,
  lastFiredAtMs: null,
};

async function emit(s: ManagedSession, name: string, data: unknown): Promise<void> {
  assert.ok(s.pi);
  // The fake agent writes the frame before its reply, so the event is handled once this resolves.
  const reply = await s.pi.command({ type: "emit", frame: { type: "extension_event", name, data } });
  assert.equal(reply.success, true);
}

function tool(messages: OCMessageWithParts[] | undefined): OCToolPart {
  const part = (messages ?? []).flatMap((message) => message.parts).find((p) => (p as OCToolPart).type === "tool");
  assert.ok(part);
  return part as OCToolPart;
}

test("a monitor is a busy child session until OmO reports it ended", async (t) => {
  const h = bugHarness(t);
  const info = await h.manager.create(h.root);
  const parent = h.manager.get(info.id);
  assert.ok(parent?.pi);
  const inspected = await parent.pi.command<{ capabilities: string[] }>({ type: "inspect" });
  assert.match(String(inspected.data?.capabilities[0]), /\bextension_events\b/);

  await emit(parent, MONITOR_STATE_EVENT, { activeCount: 1, monitors: [monitor] });
  const childID = ocIdFor(`${info.id}/monitor/bash_7`);
  const child = h.manager.get(childID);
  assert.equal(child?.info.parentID, info.id);
  assert.equal(child.info.title, "Monitor: wait for the build");
  assert.deepEqual(child.status, { type: "busy" });
  assert.ok(h.manager.list(h.root).some((s) => s.id === childID));
  assert.deepEqual(h.manager.statuses()[childID], { type: "busy" });
  assert.equal(parent.hasBackgroundWork?.(), true);
  assert.equal(parent.hasRunningChildren(), false, "a watch must not block fork or revert");
  const running = tool(h.manager.messages(childID));
  assert.equal(running.tool, "bash");
  assert.equal(running.state.status, "running");
  assert.equal(running.state.input.command, "tail -F build.log");
  assert.ok(h.events.some((e) => e.type === "session.created" && e.properties.info.id === childID));

  await emit(parent, MONITOR_STATE_EVENT, { activeCount: 1, monitors: [{ ...monitor, fireCount: 2 }] });
  assert.equal(h.events.filter((e) => e.type === "session.created" && e.properties.info.id === childID).length, 1);

  await emit(parent, MONITOR_STATE_EVENT, { activeCount: 0, monitors: [] });
  await emit(parent, MONITOR_ENDED_EVENT, {
    id: "bash_7",
    description: monitor.description,
    startedAtMs: monitor.startedAtMs,
    endedAtMs: monitor.startedAtMs + 5_000,
    exitCode: 0,
    fireCount: 3,
    reason: "exit",
  });
  assert.deepEqual(child.status, { type: "idle" });
  assert.equal(parent.hasBackgroundWork?.(), false);
  const ended = tool(h.manager.messages(childID));
  assert.equal(ended.state.status, "completed");
  assert.ok(ended.state.status === "completed");
  assert.match(ended.state.output, /Status: command exited with code 0/);
  assert.match(ended.state.output, /Events: 3/);
  const statuses = h.events
    .filter((e) => e.type === "session.status" && e.properties.sessionID === childID)
    .map((e) => (e.type === "session.status" ? e.properties.status.type : undefined));
  assert.deepEqual(statuses, ["busy", "idle"]);
});

test("agent exit ends its watches and deleting the parent removes them", async (t) => {
  const h = bugHarness(t);
  const info = await h.manager.create(h.root);
  const parent = h.manager.get(info.id);
  assert.ok(parent?.pi);
  await emit(parent, MONITOR_STATE_EVENT, { activeCount: 1, monitors: [monitor] });
  const childID = ocIdFor(`${info.id}/monitor/bash_7`);

  const ended = h.wait(
    (e) => e.type === "session.status" && e.properties.sessionID === childID && e.properties.status.type === "idle",
  );
  void parent.pi.command({ type: "exit" }).catch(() => undefined);
  await ended;
  const part = tool(h.manager.messages(childID));
  assert.ok(part.state.status === "completed");
  assert.match(part.state.output, /OmO process exited/);

  await h.manager.remove(info.id);
  assert.equal(h.manager.get(childID), undefined);
  assert.ok(h.events.some((e) => e.type === "session.deleted" && e.properties.info.id === childID));
});

test("a deleted watch is not recreated by the next snapshot", async (t) => {
  const h = bugHarness(t);
  const info = await h.manager.create(h.root);
  const parent = h.manager.get(info.id);
  assert.ok(parent);
  await emit(parent, MONITOR_STATE_EVENT, { activeCount: 1, monitors: [monitor] });
  const childID = ocIdFor(`${info.id}/monitor/bash_7`);
  assert.equal(await h.manager.remove(childID), true);
  assert.ok(parent.pi, "deleting a watch leaves its parent's agent running");
  await emit(parent, MONITOR_STATE_EVENT, { activeCount: 1, monitors: [{ ...monitor, fireCount: 1 }] });
  assert.equal(h.manager.get(childID), undefined);
});

test("malformed monitor payloads are ignored", async (t) => {
  const h = bugHarness(t);
  const info = await h.manager.create(h.root);
  const parent = h.manager.get(info.id);
  assert.ok(parent);
  const before = h.manager.list(h.root).length;
  await emit(parent, MONITOR_STATE_EVENT, { activeCount: 2, monitors: [{ id: "" }, { id: "x" }, "bad"] });
  await emit(parent, MONITOR_STATE_EVENT, null);
  await emit(parent, "some_other_extension_event", { monitors: [monitor] });
  assert.equal(h.manager.list(h.root).length, before);
  assert.equal(parent.hasBackgroundWork?.(), false);
});
