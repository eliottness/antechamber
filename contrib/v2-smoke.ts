/**
 * opencode v2 API smoke test — no OpenChamber required.
 *
 * Boots the adapter in-process and drives the v2 surface exactly the way the
 * OpenChamber 2.0.4 web UI does: bootstrap GETs → session create/list/get →
 * prompt over `POST /api/session/:id/prompt` while observing the granular
 * `session.*` SSE events on `/api/event` → assistant reply in the message list.
 *
 *   npm run v2-smoke
 *
 * Requires the connector's agent on PATH (pi), since the prompt is a
 * real agent run. Point it at another binary with ANTECHAMBER_PI_BINARY.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterServer } from "../src/server.js";

const WORKSPACE = mkdtempSync(join(tmpdir(), "oc-v2-smoke-"));
process.env.ANTECHAMBER_STATE_DIR = join(WORKSPACE, "pi-state");

let failures = 0;
let checks = 0;

function ok(name: string, cond: boolean, detail = ""): void {
  checks++;
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failures++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

interface V2Envelope {
  id: string;
  created: number;
  type: string;
  location?: { directory?: string };
  data: Record<string, unknown>;
}

/** Minimal SSE client for the v2 envelopes on `/api/event`. */
class V2Sse {
  private events: V2Envelope[] = [];
  private waiters: Array<{
    type: string;
    test: (e: V2Envelope) => boolean;
    resolve: (e: V2Envelope) => void;
    timer: NodeJS.Timeout;
  }> = [];
  private controller = new AbortController();

  constructor(private url: string) {}

  async start(): Promise<void> {
    const res = await fetch(this.url, { signal: this.controller.signal, headers: { Accept: "text/event-stream" } });
    if (!res.ok || !res.body) throw new Error(`SSE connect failed: ${res.status}`);
    void this.pump(res.body);
  }

  private async pump(body: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    const reader = body.getReader();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        for (;;) {
          const idx = buf.indexOf("\n\n");
          if (idx === -1) break;
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          try {
            const ev = JSON.parse(line.slice(5).trim()) as V2Envelope;
            this.events.push(ev);
            for (const w of [...this.waiters]) {
              if (w.test(ev)) {
                this.waiters.splice(this.waiters.indexOf(w), 1);
                clearTimeout(w.timer);
                w.resolve(ev);
              }
            }
          } catch {
            /* malformed frame */
          }
        }
      }
    } catch {
      /* aborted */
    }
  }

  waitFor(type: string, test: (e: V2Envelope) => boolean, timeoutMs: number): Promise<V2Envelope> {
    const existing = this.events.find((e) => e.type === type && test(e));
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = {
        type,
        test,
        resolve,
        timer: setTimeout(() => {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          reject(new Error(`timeout waiting for ${type} after ${timeoutMs}ms`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  stop(): void {
    this.controller.abort();
  }
}

async function api<T>(url: string, path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${url}${path}`, init);
  const text = await res.text();
  let body: T;
  try {
    body = text === "" ? (undefined as T) : (JSON.parse(text) as T);
  } catch {
    body = text as unknown as T;
  }
  return { status: res.status, body };
}

/** Joined text of an assistant message's v2 `content` blocks. */
function assistantText(m: { content?: Array<{ type?: string; text?: string }> }): string {
  return (m.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("");
}

let teardown: (() => Promise<void>) | undefined;

async function runTeardown(): Promise<void> {
  const current = teardown;
  teardown = undefined;
  await current?.().catch((error: unknown) => console.error("v2 smoke teardown failed:", error));
}

async function main(): Promise<void> {
  console.log(`workspace: ${WORKSPACE}`);
  const server = new AdapterServer({ port: 0, host: "127.0.0.1", defaultDirectory: WORKSPACE });
  teardown = async () => {
    await server.stop();
    rmSync(WORKSPACE, { recursive: true, force: true });
  };
  await server.start();
  const url = server.url;
  console.log(`adapter: ${url}`);

  const sse = new V2Sse(`${url}/api/event`);
  await sse.start();
  await sse.waitFor("server.connected", () => true, 5_000).catch(() => undefined);

  // 1. bootstrap GETs and envelopes
  console.log("— bootstrap GETs —");
  const info = await api<{ version: string; pid: number; urls: string[]; paths: Record<string, string> }>(
    url,
    "/api/info",
  );
  ok(
    "GET /api/info envelope",
    info.status === 200 &&
      typeof info.body.version === "string" &&
      typeof info.body.pid === "number" &&
      Array.isArray(info.body.urls) &&
      typeof info.body.paths === "object",
  );

  const location = await api<{ directory: string; project: { id: string; directory: string; canonical: string } }>(
    url,
    "/api/location",
  );
  ok(
    "GET /api/location envelope",
    location.status === 200 &&
      typeof location.body.directory === "string" &&
      typeof location.body.project?.directory === "string" &&
      typeof location.body.project?.canonical === "string",
  );

  const config = await api<{ location?: { directory?: string }; data?: { default_agent?: string } }>(
    url,
    "/api/config",
  );
  ok(
    "GET /api/config {location,data}",
    config.status === 200 &&
      typeof config.body.location?.directory === "string" &&
      typeof config.body.data?.default_agent === "string",
  );

  for (const listPath of ["/api/provider", "/api/model", "/api/command", "/api/skill"]) {
    const r = await api<{ location?: { directory?: string }; data?: unknown[] }>(url, listPath);
    ok(
      `GET ${listPath} {location,data}`,
      r.status === 200 && typeof r.body.location?.directory === "string" && Array.isArray(r.body.data),
    );
  }
  const modelDefault = await api<{
    location?: { directory?: string };
    data?: { modelID?: string; providerID?: string } | null;
  }>(url, "/api/model/default");
  ok(
    "GET /api/model/default {location,data:Model}",
    modelDefault.status === 200 &&
      typeof modelDefault.body.location?.directory === "string" &&
      (modelDefault.body.data === null || typeof modelDefault.body.data?.modelID === "string"),
  );

  const agents = await api<{ location?: { directory?: string }; data?: Array<{ id?: string }> }>(url, "/api/agent");
  ok(
    "GET /api/agent {location,data:[Agent]}",
    agents.status === 200 && Array.isArray(agents.body.data) && agents.body.data.length > 0,
  );
  const firstAgentId = agents.body.data?.[0]?.id;
  if (firstAgentId) {
    const agent = await api<{ data?: { id?: string } }>(url, `/api/agent/${encodeURIComponent(firstAgentId)}`);
    ok("GET /api/agent/:id {data:Agent}", agent.status === 200 && agent.body.data?.id === firstAgentId);
  }

  const sessionList0 = await api<{ data?: unknown[]; cursor?: { previous: unknown; next: unknown } }>(
    url,
    "/api/session",
  );
  ok("GET /api/session {data:[Session]}", sessionList0.status === 200 && Array.isArray(sessionList0.body.data));
  ok(
    "GET /api/session includes cursor",
    sessionList0.status === 200 && typeof sessionList0.body.cursor === "object" && sessionList0.body.cursor !== null,
  );

  for (const extra of [
    "/api/project",
    "/api/vcs",
    "/api/vcs/base",
    "/api/vcs/status",
    "/api/vcs/branch",
    "/api/permission/request",
    "/api/permission/saved",
    "/api/form",
  ]) {
    const r = await api<unknown>(url, extra);
    ok(`GET ${extra} → 200`, r.status === 200, `status ${r.status}`);
  }

  const active = await api<{ data?: Record<string, { type: string }> }>(url, "/api/session/active");
  ok(
    "GET /api/session/active {data:{id:{type}}}",
    active.status === 200 && typeof active.body.data === "object" && active.body.data !== null,
  );

  // 2. session create / list / get / message
  console.log("— session create / list / get —");
  const created = await api<{ data?: { id?: string; location?: { directory?: string }; agent?: string } }>(
    url,
    "/api/session",
    {
      method: "POST",
      body: JSON.stringify({ title: "v2 smoke" }),
    },
  );
  const sessionId = created.body.data?.id;
  ok(
    "POST /api/session {data:Session}",
    created.status === 200 && typeof sessionId === "string" && created.body.data?.location?.directory === WORKSPACE,
    JSON.stringify(created.body).slice(0, 200),
  );
  if (!sessionId) throw new Error("no session id");

  const listed = await api<{ data?: Array<{ id?: string }> }>(url, "/api/session");
  ok(
    "GET /api/session lists the new session",
    listed.status === 200 && (listed.body.data ?? []).some((s) => s.id === sessionId),
  );

  const got = await api<{ data?: { id?: string } }>(url, `/api/session/${encodeURIComponent(sessionId)}`);
  ok("GET /api/session/:id {data:Session}", got.status === 200 && got.body.data?.id === sessionId);

  const messages0 = await api<{ data?: unknown[] }>(url, `/api/session/${encodeURIComponent(sessionId)}/message`);
  ok("GET /api/session/:id/message {data:[Message]}", messages0.status === 200 && Array.isArray(messages0.body.data));

  const form0 = await api<{ data?: unknown[] }>(url, `/api/session/${encodeURIComponent(sessionId)}/form`);
  ok(
    "GET /api/session/:id/form {data:[]}",
    form0.status === 200 && Array.isArray(form0.body.data) && form0.body.data.length === 0,
  );

  // 3. prompt + streaming events
  console.log("— prompt + /api/event streaming —");
  const clientMessageId = `msg_v2smoke${Date.now()}`;
  const prompt = await api<{ data?: { id?: string; type?: string; sessionID?: string } }>(
    url,
    `/api/session/${encodeURIComponent(sessionId)}/prompt`,
    {
      method: "POST",
      body: JSON.stringify({ id: clientMessageId, text: "Reply with exactly: V2-SMOKE-OK", delivery: "steer" }),
    },
  );
  ok(
    "POST /api/session/:id/prompt {data:UserMessage}",
    prompt.status === 200 && prompt.body.data?.id === clientMessageId && prompt.body.data?.type === "user",
    JSON.stringify(prompt.body).slice(0, 200),
  );

  const sid = (e: V2Envelope) => e.data.sessionID === sessionId;
  let completedTurn = false;
  try {
    await sse.waitFor("session.execution.started", sid, 15_000);
    ok("SSE session.execution.started", true);
    const step = await sse.waitFor("session.step.started", sid, 30_000);
    ok("SSE session.step.started", true, JSON.stringify(step.data).slice(0, 120));
    await sse.waitFor("session.text.started", sid, 120_000);
    ok("SSE session.text.started", true);
    await sse.waitFor(
      "session.text.delta",
      (e) => sid(e) && typeof e.data.delta === "string" && e.data.delta !== "",
      120_000,
    );
    ok("SSE session.text.delta", true);
    await sse.waitFor("session.text.ended", sid, 180_000);
    ok("SSE session.text.ended", true);
    await sse.waitFor("session.step.ended", sid, 180_000);
    ok("SSE session.step.ended", true);
    await sse.waitFor("session.execution.succeeded", sid, 30_000);
    ok("SSE session.execution.succeeded", true);
    completedTurn = true;
  } catch (err) {
    ok("SSE streaming event sequence", false, err instanceof Error ? err.message : String(err));
  } finally {
    sse.stop();
  }

  // 4. assistant reply landed in the message list
  console.log("— assistant reply in message list —");
  let answer = "";
  if (completedTurn) {
    const res = await api<{ data?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> }>(
      url,
      `/api/session/${encodeURIComponent(sessionId)}/message?order=asc`,
    );
    const msgs = res.body.data ?? [];
    answer = msgs
      .filter((m) => m.type === "assistant")
      .map((m) => assistantText(m))
      .join("\n");
  }
  ok(
    "terminal assistant message contains V2-SMOKE-OK",
    completedTurn && answer.includes("V2-SMOKE-OK"),
    completedTurn ? answer.slice(0, 160) : "session.execution.succeeded was not observed",
  );

  // 5. remaining minimum-viable routes
  console.log("— remaining routes —");
  const userMsg = await api<{ data?: { id?: string; type?: string } }>(
    url,
    `/api/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(clientMessageId)}`,
  );
  ok(
    "GET /api/session/:id/message/:messageID {data:Message}",
    userMsg.status === 200 && userMsg.body.data?.type === "user" && userMsg.body.data?.id === clientMessageId,
  );

  const patched = await api<unknown>(url, `/api/session/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    body: JSON.stringify({ title: "v2 smoke renamed" }),
  });
  ok("PATCH /api/session/:id → 204", patched.status === 204 && patched.body === undefined);
  const renamed = await api<{ data?: { title?: string } }>(url, `/api/session/${encodeURIComponent(sessionId)}`);
  ok("PATCH persisted the title", renamed.body.data?.title === "v2 smoke renamed", renamed.body.data?.title);

  const setAgent = await api<unknown>(url, `/api/session/${encodeURIComponent(sessionId)}/agent`, {
    method: "POST",
    body: JSON.stringify({ agent: firstAgentId ?? "build" }),
  });
  ok("POST /api/session/:id/agent → 204", setAgent.status === 204);
  // A model pi does not have must be refused, not silently accepted: the UI
  // awaits this call before every prompt, so a fake 204 is how the picker and
  // pi end up disagreeing. contrib/model-consistency.ts covers the happy path.
  const setModel = await api<unknown>(url, `/api/session/${encodeURIComponent(sessionId)}/model`, {
    method: "POST",
    body: JSON.stringify({ model: { providerID: "x", id: "y" } }),
  });
  ok("POST /api/session/:id/model with an unknown model → 400", setModel.status === 400, `status ${setModel.status}`);

  const interrupted = await api<unknown>(url, `/api/session/${encodeURIComponent(sessionId)}/interrupt`, {
    method: "POST",
  });
  ok("POST /api/session/:id/interrupt → 200", interrupted.status === 200);

  const diff = await api<{ data?: unknown[] }>(url, `/api/session/${encodeURIComponent(sessionId)}/diff`);
  ok("GET /api/session/:id/diff → 200 {data}", diff.status === 200 && Array.isArray(diff.body.data));

  const removed = await api<unknown>(url, `/api/session/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  ok("DELETE /api/session/:id → 204", removed.status === 204);
  const gone = await api<unknown>(url, `/api/session/${encodeURIComponent(sessionId)}`);
  ok("deleted session returns 404", gone.status === 404);

  await runTeardown();

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error(err);
  await runTeardown();
  process.exitCode = 1;
});
