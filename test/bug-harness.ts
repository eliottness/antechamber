import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import { SessionManager } from "../src/sessions.js";
import { SessionStore } from "../src/session-store.js";
import type { OCEvent } from "../src/types.js";
import { V2EventTranslator, type V2Envelope } from "../src/v2.js";

export function bugHarness(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "antechamber-bugs-"));
  const saved = new Map(
    ["ANTECHAMBER_PI_BINARY", "PI_CODING_AGENT_DIR", "ANTECHAMBER_STATE_DIR"].map((key) => [key, process.env[key]]),
  );
  process.env.ANTECHAMBER_PI_BINARY = resolve("test/fixtures/turn-omo.mjs");
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.ANTECHAMBER_STATE_DIR = join(root, "state");
  const events: OCEvent[] = [];
  const frames: V2Envelope[] = [];
  const bus = new EventEmitter();
  const translator = new V2EventTranslator();
  const makeManager = () =>
    new SessionManager(
      (dir, event) => {
        if (event.type === "todo.updated") return;
        events.push(structuredClone(event));
        frames.push(...translator.translate(dir, event));
        bus.emit("event", event);
      },
      new SessionStore(join(root, "state")),
      root,
    );
  let manager = makeManager();
  t.after(async () => {
    try {
      await manager.disposeAll();
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
  return {
    root,
    events,
    frames,
    get manager() {
      return manager;
    },
    async restart() {
      await manager.disposeAll();
      manager = makeManager();
    },
    wait(predicate: (e: OCEvent) => boolean): Promise<OCEvent> {
      return new Promise((resolveEvent, reject) => {
        const timer = setTimeout(() => {
          bus.off("event", listener);
          reject(new Error("event deadline"));
        }, 5000);
        const listener = (event: OCEvent) => {
          if (!predicate(event)) return;
          clearTimeout(timer);
          bus.off("event", listener);
          resolveEvent(event);
        };
        bus.on("event", listener);
      });
    },
  };
}

export async function openEvents(url: string) {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  if (!response.body) throw new Error("missing SSE body");
  const reader = response.body.getReader();
  await reader.read(); // server.connected arms the subscription before any action.
  const bus = new EventEmitter();
  const frames: Array<Record<string, unknown>> = [];
  const reading = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      buffer += decoder.decode(chunk.value, { stream: true });
      const complete = buffer.split("\n\n");
      buffer = complete.pop() ?? "";
      for (const frame of complete) {
        const data = frame.split("\n").find((line) => line.startsWith("data: "));
        if (!data) continue;
        const event = JSON.parse(data.slice(6)) as Record<string, unknown>;
        frames.push(event);
        bus.emit("event", event);
      }
    }
  })().catch((error: unknown) => {
    if (!controller.signal.aborted) throw error;
  });
  return {
    frames,
    wait(predicate: (event: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
      return new Promise((resolveEvent, reject) => {
        const timer = setTimeout(() => {
          bus.off("event", listener);
          reject(new Error("SSE deadline"));
        }, 5000);
        const listener = (event: Record<string, unknown>) => {
          if (!predicate(event)) return;
          clearTimeout(timer);
          bus.off("event", listener);
          resolveEvent(event);
        };
        bus.on("event", listener);
      });
    },
    async close() {
      controller.abort();
      await reading;
    },
  };
}
