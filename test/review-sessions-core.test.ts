import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { parsePiSessionText } from "../src/session-history.js";
import { SessionManager, type ManagedSession } from "../src/sessions.js";
import { SessionStore } from "../src/session-store.js";
import type { OCEvent } from "../src/types.js";

function entry(directory: string, piSessionId: string) {
  return {
    piSessionId,
    piPath: join(directory, `${piSessionId}.jsonl`),
    directory,
    created: 1,
    updated: 1,
  };
}

test("R-017: independent registry writers preserve unrelated records", (t) => {
  const root = mkdtempSync(join(tmpdir(), "antechamber-review-store-race-"));
  const state = join(root, "state");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const first = new SessionStore(state);
  const second = new SessionStore(state);
  first.directories();
  second.directories();
  first.set("ses_first", entry(root, "pi_first"));
  second.set("ses_second", entry(root, "pi_second"));

  const restored = new SessionStore(state);
  assert.deepEqual(
    [restored.get("ses_first")?.piSessionId, restored.get("ses_second")?.piSessionId],
    ["pi_first", "pi_second"],
  );
});

test("R-027: registry paths are private under umask 022", (t) => {
  const root = mkdtempSync(join(tmpdir(), "antechamber-review-store-mode-"));
  const state = join(root, "state");
  const previousUmask = process.umask(0o022);
  t.after(() => {
    process.umask(previousUmask);
    rmSync(root, { recursive: true, force: true });
  });

  new SessionStore(state).set("ses_private", entry(root, "pi_private"));

  assert.equal(statSync(state).mode & 0o777, 0o700);
  assert.equal(statSync(join(state, "sessions.json")).mode & 0o777, 0o600);
});

test("R-028: malformed nested registry records are rejected", (t) => {
  const root = mkdtempSync(join(tmpdir(), "antechamber-review-store-shape-"));
  const state = join(root, "state");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(state, { recursive: true });
  writeFileSync(
    join(state, "sessions.json"),
    JSON.stringify({
      ses_bad: {
        ...entry(root, "pi_bad"),
        tree: { messageEntries: {}, localShellTurns: [{ messages: {} }] },
      },
    }),
  );

  const store = new SessionStore(state);
  assert.equal(store.get("ses_bad"), undefined);
  assert.deepEqual(JSON.parse(readFileSync(join(state, "sessions.json"), "utf8")).ses_bad.piSessionId, "pi_bad");
});

const reviewFixture = resolve("test/fixtures/review-sessions-control.mjs");

function reviewHarness(t: TestContext, maxLive = 8) {
  const root = mkdtempSync(join(tmpdir(), "antechamber-review-sessions-"));
  const saved = new Map(
    ["ANTECHAMBER_PI_BINARY", "ANTECHAMBER_STATE_DIR", "PI_CODING_AGENT_DIR"].map((key) => [key, process.env[key]]),
  );
  process.env.ANTECHAMBER_PI_BINARY = reviewFixture;
  process.env.ANTECHAMBER_STATE_DIR = join(root, "state");
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const events: OCEvent[] = [];
  const bus = new EventEmitter();
  const manager = new SessionManager(
    (_directory, event) => {
      if (event.type === "todo.updated") return;
      const copied = structuredClone(event);
      events.push(copied);
      bus.emit("event", copied);
    },
    new SessionStore(join(root, "state")),
    root,
    { maxLive },
  );
  t.after(async () => {
    await manager.disposeAll();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, events, bus, manager };
}

function waitForReviewEvent(
  events: OCEvent[],
  bus: EventEmitter,
  predicate: (event: OCEvent) => boolean,
): Promise<OCEvent> {
  const existing = events.find(predicate);
  if (existing !== undefined) return Promise.resolve(existing);
  return new Promise((resolveEvent, reject) => {
    const timeout = AbortSignal.timeout(10_000);
    const listener = (event: OCEvent) => {
      if (!predicate(event)) return;
      bus.off("event", listener);
      resolveEvent(event);
    };
    timeout.addEventListener(
      "abort",
      () => {
        bus.off("event", listener);
        reject(new Error("review event deadline"));
      },
      { once: true },
    );
    bus.on("event", listener);
  });
}

function waitForFixtureEvent(
  pi: NonNullable<ManagedSession["pi"]>,
  predicate: (event: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const emitter = pi as unknown as EventEmitter;
  return new Promise((resolveEvent, reject) => {
    const timeout = AbortSignal.timeout(10_000);
    const listener = (event: Record<string, unknown>) => {
      if (!predicate(event)) return;
      emitter.off("event", listener);
      resolveEvent(event);
    };
    timeout.addEventListener(
      "abort",
      () => {
        emitter.off("event", listener);
        reject(new Error("fixture event deadline"));
      },
      { once: true },
    );
    pi.onEvent(listener);
  });
}

test("R-001: malformed live transcripts do not crash the connector process", { timeout: 15_000 }, async (t) => {
  const script = `
    import { mkdtempSync, rmSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    import { SessionManager } from "./src/sessions.ts";
    import { SessionStore } from "./src/session-store.ts";

    const root = mkdtempSync(join(tmpdir(), "antechamber-r001-child-"));
    process.env.ANTECHAMBER_PI_BINARY = ${JSON.stringify(reviewFixture)};
    process.env.ANTECHAMBER_STATE_DIR = join(root, "state");
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
    let sawError = false;
    const manager = new SessionManager(
      (_directory, event) => {
        if (event.type === "session.error") {
          sawError = true;
          console.log("SESSION_ERROR");
        }
      },
      new SessionStore(join(root, "state")),
      root,
    );
    try {
      const session = await manager.create(root);
      const pi = manager.get(session.id)?.pi;
      if (!pi) throw new Error("missing fixture client");
      console.log("PI_PID=" + pi.pid);
      await pi.command({ type: "corrupt_then_end" });
      if (!sawError) throw new Error("missing session-scoped transcript error");
      await manager.disposeAll();
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      throw error;
    }
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let piPID: number | undefined;
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    const match = output.match(/PI_PID=(\d+)/);
    if (match?.[1] !== undefined) piPID = Number(match[1]);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
    if (piPID === undefined) return;
    try {
      process.kill(-piPID, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  });
  const [code] = await once(child, "close", { signal: AbortSignal.timeout(10_000) });
  assert.equal(code, 0, output);
  assert.match(output, /SESSION_ERROR/);
});

test("R-002: cancelled callers do not release native operation ordering", { timeout: 15_000 }, async (t) => {
  const h = reviewHarness(t);
  const session = await h.manager.create(h.root);
  const pi = h.manager.get(session.id)?.pi;
  if (pi === undefined) throw new Error("missing fixture client");
  await pi.command({ type: "arm_entries_gate" });
  const held = waitForFixtureEvent(pi, (event) => event.type === "fixture_entries_held");
  const controller = new AbortController();
  const first = h.manager.reloadMessages(session.id, controller.signal);
  await held;
  controller.abort(new Error("review cancellation"));
  await assert.rejects(first, /review cancellation/);

  const follower = h.manager.reloadMessages(session.id);
  const release = await pi.command<{ followerBeforeRelease: boolean }>({ type: "release_entries" });
  await follower;

  assert.equal(release.data?.followerBeforeRelease, false);
});

test("R-012: agent exit finalizes a streaming message and running tool card", { timeout: 15_000 }, async (t) => {
  const h = reviewHarness(t);
  const session = await h.manager.create(h.root);
  await h.manager.prompt(session.id, "hold", undefined, false, "msg_held");
  const managed = h.manager.get(session.id);
  if (managed?.pi === undefined) throw new Error("missing held session");
  const exited = waitForReviewEvent(
    h.events,
    h.bus,
    (event) => event.type === "session.error" && event.properties.sessionID === session.id,
  );
  managed.pi.notify({ type: "crash" });
  await exited;

  const unfinished = [
    ...(managed.streaming === undefined ? [] : ["streaming assistant"]),
    ...[...managed.toolByCallId.values()]
      .filter((part) => part.state.status === "pending" || part.state.status === "running")
      .map((part) => `running tool ${part.callID}`),
  ];
  assert.deepEqual(unfinished, []);
});

test("R-013: fork transfer reserves its live slot through state handoff", { timeout: 15_000 }, async (t) => {
  const h = reviewHarness(t, 1);
  const parent = await h.manager.create(h.root);
  await h.manager.prompt(parent.id, "seed", undefined, false, "msg_seed");
  const pi = h.manager.get(parent.id)?.pi;
  if (pi === undefined) throw new Error("missing fork client");
  const stateHeld = waitForFixtureEvent(pi, (event) => event.type === "fixture_fork_state_held");
  const fork = h.manager.fork(parent.id);
  await stateHeld;
  const secondCreate = h.manager.create(h.root);
  await pi.command({ type: "release_fork_state" });
  const results = await Promise.allSettled([fork, secondCreate]);
  const live = h.manager.list().filter((info) => h.manager.get(info.id)?.pi !== undefined);

  assert.ok(live.length <= 1, `MAX_LIVE=1 admitted ${live.length} clients: ${JSON.stringify(results)}`);
});

test("R-014: failed initialization rolls back the published session and client", { timeout: 15_000 }, async (t) => {
  const h = reviewHarness(t);
  await assert.rejects(h.manager.create(h.root, "reject native rename"), /native rename rejected/);

  const leaked = h.manager.list().map((info) => ({
    id: info.id,
    live: h.manager.get(info.id)?.pi !== undefined,
  }));
  assert.deepEqual(leaked, []);
});

test("R-015: repeated compactions with one retained boundary keep distinct identities", () => {
  const session = {
    info: {
      id: "ses_compaction_review",
      projectID: "/tmp/review",
      directory: "/tmp/review",
      title: "Review",
      version: "test",
      time: { created: 0, updated: 0 },
    },
    tree: { messageEntries: {} },
  } as unknown as ManagedSession;
  const raw = [
    JSON.stringify({ type: "session", id: "native", cwd: "/tmp/review" }),
    JSON.stringify({
      type: "message",
      id: "entry_first",
      parentId: null,
      timestamp: 1,
      message: { role: "user", content: [{ type: "text", text: "keep this" }] },
    }),
    JSON.stringify({
      type: "compaction",
      id: "compact_one",
      parentId: "entry_first",
      timestamp: 2,
      firstKeptEntryId: "entry_first",
      summary: "first summary",
    }),
    JSON.stringify({
      type: "compaction",
      id: "compact_two",
      parentId: "compact_one",
      timestamp: 3,
      firstKeptEntryId: "entry_first",
      summary: "second summary",
    }),
  ].join("\n");

  const compactionMessages = parsePiSessionText(session, "review-agent", raw).filter((message) =>
    message.info.id.startsWith("msg_compaction_"),
  );
  assert.equal(new Set(compactionMessages.map((message) => message.info.id)).size, compactionMessages.length);
});

test("R-016: handled slash commands settle their admitted inbox input", { timeout: 15_000 }, async (t) => {
  const h = reviewHarness(t);
  const session = await h.manager.create(h.root);
  for (const id of ["msg_handled_one", "msg_handled_two", "msg_handled_three"]) {
    await h.manager.prompt(session.id, "/notify-review", undefined, false, id);
  }
  const managed = h.manager.get(session.id);
  if (managed === undefined) throw new Error("missing handled-command session");
  const delivered = h.events.filter(
    (event) => event.type === "session.inbox.delivered" && event.properties.sessionID === session.id,
  );
  assert.deepEqual({ pending: managed.inputs?.size ?? 0, delivered: delivered.length }, { pending: 0, delivered: 3 });
});

test("R-029: native rename rejection is observable to the caller", { timeout: 15_000 }, async (t) => {
  const h = reviewHarness(t);
  const session = await h.manager.create(h.root);

  await assert.rejects(
    Promise.resolve(h.manager.update(session.id, { title: "reject native rename" })),
    /native rename rejected/,
  );
});

test("R-029: filesystem delete failure is observable to the caller", { timeout: 15_000 }, async (t) => {
  const h = reviewHarness(t);
  const session = await h.manager.create(h.root);
  const path = h.manager.get(session.id)?.piPath;
  if (path === undefined) throw new Error("missing session path");
  rmSync(path);
  mkdirSync(path);

  // unlink(2) on a directory is EISDIR on Linux and EPERM on macOS.
  await assert.rejects(h.manager.remove(session.id), { code: process.platform === "linux" ? "EISDIR" : "EPERM" });
});
