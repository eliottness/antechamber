import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { describeStop } from "../src/pi-rpc.js";
import { promptAsync, type RouteServices } from "../src/route-services.js";
import type { SessionManager } from "../src/sessions.js";
import type { OCEvent, OCMessageWithParts } from "../src/types.js";
import { bugHarness } from "./bug-harness.js";

const stopNotices = (messages: OCMessageWithParts[] | undefined) =>
  (messages ?? []).filter((message) => message.info.id.startsWith("msg_agentstop_"));

test("an agent that dies on its own leaves a notice naming why, replayed once after a restart until the next prompt", {
  timeout: 20_000,
}, async (t) => {
  const h = bugHarness(t);
  const info = await h.manager.create(h.root);
  await h.manager.prompt(info.id, "normal");
  const pid = h.manager.get(info.id)?.pi?.pid;
  assert.ok(pid);
  const expected = describeStop({ kind: "exit", code: null, signal: "SIGKILL" });
  const reported = h.wait((event) => event.type === "session.error" && event.properties.sessionID === info.id);
  const idle = h.wait((event) => event.type === "session.idle" && event.properties.sessionID === info.id);

  process.kill(pid, "SIGKILL");
  const [error] = await Promise.all([reported, idle]);

  assert.equal(error.type === "session.error" ? error.properties.error?.data.message : undefined, expected);
  const [live, ...extra] = stopNotices(h.manager.messages(info.id));
  assert.ok(live);
  assert.deepEqual(extra, []);
  const [part] = live.parts;
  assert.equal(part?.type === "text" ? part.text : undefined, expected);
  assert.equal(live.info.role === "assistant" ? live.info.error?.name : undefined, "AgentStoppedError");

  await h.restart();
  assert.deepEqual(
    stopNotices(h.manager.messages(info.id)).map((message) => message.info.id),
    [live.info.id],
  );
  await h.manager.reloadMessages(info.id);
  assert.deepEqual(
    stopNotices(h.manager.messages(info.id)).map((message) => message.info.id),
    [live.info.id],
  );

  await h.manager.prompt(info.id, "again");
  await h.restart();
  assert.deepEqual(stopNotices(h.manager.messages(info.id)), []);
});

test("a stop that ends a revival is shown once, by the session and not again by prompt admission", {
  timeout: 20_000,
}, async (t) => {
  const h = bugHarness(t);
  const info = await h.manager.create(h.root);
  await h.manager.prompt(info.id, "normal");
  await h.restart();
  process.env.ANTECHAMBER_PI_BINARY = join(h.root, "missing-agent");
  const session = h.manager.get(info.id);
  assert.ok(session);
  const manager = h.manager;
  const prompted: Promise<void>[] = [];
  const sessions = new Proxy(manager, {
    get(target, property) {
      if (property === "prompt")
        return (...args: Parameters<SessionManager["prompt"]>) => {
          const pending = target.prompt(...args);
          prompted.push(pending);
          return pending;
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const announced: OCEvent[] = [];
  const services = {
    sessions,
    broadcast: (_directory: string, event: OCEvent) => announced.push(event),
  } as unknown as RouteServices;
  const reported = h.wait((event) => event.type === "session.error" && event.properties.sessionID === info.id);

  promptAsync(services, session, "after restart");
  const error = await reported;
  // promptAsync's own catch was attached first, so it has run once this settles.
  await prompted[0]?.catch(() => {});

  assert.equal(error.type === "session.error" ? error.properties.error?.name : undefined, "AgentStoppedError");
  const notices = stopNotices(h.manager.messages(info.id));
  assert.equal(notices.length, 1);
  const [part] = notices[0]?.parts ?? [];
  assert.equal(
    part?.type === "text" ? part.text : undefined,
    error.type === "session.error" ? error.properties.error?.data.message : undefined,
  );
  assert.deepEqual(announced, []);
});

test("an agent that crashes during revival is reported by its exit status, not as a lost connection", {
  timeout: 20_000,
}, async (t) => {
  const h = bugHarness(t);
  const info = await h.manager.create(h.root);
  await h.manager.prompt(info.id, "normal");
  await h.restart();
  const crashing = join(h.root, "crashing-agent.sh");
  writeFileSync(crashing, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
  process.env.ANTECHAMBER_PI_BINARY = crashing;

  await assert.rejects(h.manager.prompt(info.id, "after restart"), { name: "AgentStoppedError" });

  const [notice, ...extra] = stopNotices(h.manager.messages(info.id));
  assert.deepEqual(extra, []);
  const [part] = notice?.parts ?? [];
  assert.equal(part?.type === "text" ? part.text : undefined, describeStop({ kind: "exit", code: 3, signal: null }));
});

test("a dispose antechamber requests is not reported as a stop", { timeout: 20_000 }, async (t) => {
  const h = bugHarness(t);
  const info = await h.manager.create(h.root);
  await h.manager.prompt(info.id, "normal");
  const session = h.manager.get(info.id);
  assert.ok(session?.pi);
  const idle = h.wait((event) => event.type === "session.idle" && event.properties.sessionID === info.id);

  await session.pi.dispose();
  await idle;

  assert.deepEqual(stopNotices(h.manager.messages(info.id)), []);
  assert.equal(session.lastStop, undefined);
});
