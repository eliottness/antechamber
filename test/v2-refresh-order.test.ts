import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { runShellCommand } from "../src/session-commands.js";
import { SessionManager } from "../src/sessions.js";
import { SessionStore } from "../src/session-store.js";
import { type V2Envelope, V2EventTranslator } from "../src/v2.js";

// A successful `!` shell refreshes history and re-announces every message. OpenChamber 2.x dates an assistant
// message by its `session.step.started` envelope and reorders by that date, so a refresh stamped with the current
// time moved every earlier reply after the later prompts and the shell itself.
test("a shell's history refresh re-announces replies with their own times", { timeout: 30_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "antechamber-v2-order-"));
  const previous = process.env.ANTECHAMBER_PI_BINARY;
  const frames: V2Envelope[] = [];
  const translator = new V2EventTranslator();
  let manager: SessionManager | undefined;
  t.after(async () => {
    await manager?.disposeAll();
    if (previous === undefined) delete process.env.ANTECHAMBER_PI_BINARY;
    else process.env.ANTECHAMBER_PI_BINARY = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.ANTECHAMBER_PI_BINARY = resolve("test/fixtures/fake-omo.mjs");
  const sessions = new SessionManager(
    (directory, event) => {
      if (event.type !== "todo.updated") frames.push(...translator.translate(directory, event));
    },
    new SessionStore(join(dir, "state")),
    dir,
  );
  manager = sessions;
  const created = await sessions.create(dir);
  for (let i = 1; i <= 2; i++) await sessions.prompt(created.id, `turn-${i}`, undefined, false, `msg_live_${i}`);
  const session = sessions.get(created.id);
  assert.ok(session);
  const replies = new Map<string, { created: number; completed?: number }>(
    (sessions.messages(created.id) ?? [])
      .filter((message) => message.info.role === "assistant")
      .map((message) => [message.info.id, message.info.time]),
  );
  assert.equal(replies.size, 2);

  frames.length = 0;
  const shell = await runShellCommand({ sessions, session: session, command: "echo refreshed", emit: () => {} });
  assert.equal(shell.kind, "completed");
  const started = frames.filter(
    (frame) => frame.type === "session.step.started" && replies.has(String(frame.data.assistantMessageID)),
  );
  assert.equal(started.length, 2, "the refresh re-announces both earlier replies");
  for (const frame of started) {
    const time = replies.get(String(frame.data.assistantMessageID));
    assert.equal(frame.created, time?.created);
    const ended = frames.find(
      (candidate) =>
        candidate.type === "session.step.ended" && candidate.data.assistantMessageID === frame.data.assistantMessageID,
    );
    assert.equal(ended?.created, time?.completed);
  }
});
