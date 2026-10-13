/**
 * Model-consistency smoke test — no OpenChamber required.
 *
 * Proves the one invariant the connector exists to uphold: the model the UI
 * asks for, the model pi actually runs, and the model the connector reports
 * back are the SAME model. Three surfaces, one truth (pi).
 *
 * It drives the v2 surface exactly the way the OpenChamber 2.0.4 web UI does
 * on send: `POST /api/session/:id/model` first (the UI's `applySendSelection`
 * awaits it before prompting), then `POST /api/session/:id/prompt` — and checks
 * that the switch really reaches pi, that the `session.model.selected` SSE
 * envelope tells the UI about it, that the assistant reply is attributed to the
 * model that produced it, and that the choice survives an adapter restart
 * without having to wake pi up.
 *
 *   npm run model-smoke
 *
 * Requires the connector's agent on PATH (pi), since the prompt is a real agent
 * run. Point it at another binary with ANTECHAMBER_PI_BINARY.
 */

import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterServer } from "../src/server.js";

// realpath matters: on macOS mkdtemp returns a /var/folders path that is a
// symlink to /private/var/folders. pi records the resolved cwd in its session
// header, and the restore scan matches on that header — an unresolved workspace
// would make every restored session invisible.
const WORKSPACE = realpathSync(mkdtempSync(join(tmpdir(), "oc-model-smoke-")));
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

  /** Every envelope of `type` seen so far that satisfies `test`. */
  seen(type: string, test: (e: V2Envelope) => boolean): V2Envelope[] {
    return this.events.filter((e) => e.type === type && test(e));
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------
// Model refs — the catalog serves both `id` and `modelID`; sessions and
// messages carry `{id, providerID}`. Normalize everything to one shape so the
// comparisons below are comparing like with like.
// ---------------------------------------------------------------------

interface ModelRef {
  providerID: string;
  modelID: string;
}

interface CatalogModel {
  id?: string;
  modelID?: string;
  providerID?: string;
  name?: string;
}

interface SessionBody {
  id?: string;
  title?: string;
  model?: { id?: string; providerID?: string };
}

interface MessageBody {
  id?: string;
  type?: string;
  model?: { id?: string; providerID?: string };
  content?: Array<{ type?: string; text?: string }>;
}

function refOf(m: {
  id?: string | undefined;
  modelID?: string | undefined;
  providerID?: string | undefined;
}): ModelRef | undefined {
  const providerID = typeof m.providerID === "string" && m.providerID !== "" ? m.providerID : undefined;
  const modelID =
    typeof m.modelID === "string" && m.modelID !== ""
      ? m.modelID
      : typeof m.id === "string" && m.id !== ""
        ? m.id
        : undefined;
  if (providerID === undefined || modelID === undefined) return undefined;
  return { providerID, modelID };
}

function sameRef(a: ModelRef | undefined, b: ModelRef | undefined): boolean {
  return a !== undefined && b !== undefined && a.providerID === b.providerID && a.modelID === b.modelID;
}

function show(r: ModelRef | undefined): string {
  return r === undefined ? "<none>" : `${r.providerID}/${r.modelID}`;
}

function inCatalog(catalog: ModelRef[], r: ModelRef | undefined): boolean {
  return r !== undefined && catalog.some((c) => sameRef(c, r));
}

/** The catalog lists a model once per provider entry; comparisons want a set. */
function dedupe(refs: ModelRef[]): ModelRef[] {
  const out: ModelRef[] = [];
  for (const r of refs) {
    if (!out.some((o) => sameRef(o, r))) out.push(r);
  }
  return out;
}

function sessionModel(s: SessionBody | undefined): ModelRef | undefined {
  if (s?.model === undefined) return undefined;
  return refOf({ id: s.model.id, providerID: s.model.providerID });
}

async function getSession(url: string, sessionId: string): Promise<SessionBody | undefined> {
  const res = await api<{ data?: SessionBody }>(url, `/api/session/${encodeURIComponent(sessionId)}`);
  return res.status === 200 ? res.body.data : undefined;
}

/** Joined text of an assistant message's v2 `content` blocks. */
function assistantText(m: MessageBody): string {
  return (m.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("");
}

async function main(): Promise<void> {
  console.log(`workspace: ${WORKSPACE}`);
  let server: AdapterServer | undefined;
  let sse: V2Sse | undefined;

  try {
    server = new AdapterServer({ port: 0, host: "127.0.0.1", defaultDirectory: WORKSPACE });
    await server.start();
    const url = server.url;
    console.log(`adapter: ${url}`);

    sse = new V2Sse(`${url}/api/event`);
    await sse.start();
    await sse.waitFor("server.connected", () => true, 5_000).catch(() => undefined);
    const stream = sse;

    // 1. the catalog is the vocabulary every other check speaks
    console.log("— catalog —");
    const models = await api<{ location?: { directory?: string }; data?: CatalogModel[] }>(url, "/api/model");
    const catalog = dedupe((models.body.data ?? []).map((m) => refOf(m)).filter((r): r is ModelRef => r !== undefined));
    ok(
      "GET /api/model {location,data:[Model]}",
      models.status === 200 && Array.isArray(models.body.data) && catalog.length > 0,
      `${catalog.length} distinct models`,
    );

    // The picker is seeded from /api/model/default and validated against the
    // catalog: a default that is not in the list makes the client silently fall
    // back to something else, which is exactly the drift this test exists for.
    const def = await api<{ location?: { directory?: string }; data?: CatalogModel | null }>(url, "/api/model/default");
    const defRef = def.body.data === null || def.body.data === undefined ? undefined : refOf(def.body.data);
    ok(
      "GET /api/model/default is null or a catalog member",
      def.status === 200 && (defRef === undefined || inCatalog(catalog, defRef)),
      `default=${show(defRef)}`,
    );

    // 2. create a session and look at what it claims to be running
    console.log("— session create —");
    const created = await api<{ data?: SessionBody }>(url, "/api/session", {
      method: "POST",
      body: JSON.stringify({ title: "model consistency" }),
    });
    const sessionId = created.body.data?.id;
    ok(
      "POST /api/session {data:Session}",
      created.status === 200 && typeof sessionId === "string" && sessionId !== "",
      JSON.stringify(created.body).slice(0, 200),
    );
    if (typeof sessionId !== "string" || sessionId === "") throw new Error("no session id");

    const initial = sessionModel(created.body.data);
    ok(
      "new session reports no model or a catalog member",
      initial === undefined || inCatalog(catalog, initial),
      `reported=${show(initial)}`,
    );

    // B must be a model nothing is already using — otherwise the switch is a
    // legitimate no-op and the absence of `session.model.selected` would be
    // correct behaviour misread as a failure. `defRef` approximates what pi
    // booted with when the session itself does not report a model.
    const modelB = catalog.find((r) => !sameRef(r, initial) && !sameRef(r, defRef));
    if (modelB === undefined) {
      // process.exit() does not unwind through `finally`, so tear down here —
      // otherwise the adapter and its pi child outlive the test.
      stream.stop();
      sse = undefined;
      await server.stop();
      server = undefined;
      console.log(
        `\nSKIP: no catalog model distinct from the active one (${show(initial ?? defRef)}) — cannot prove a switch with ${catalog.length} model(s).`,
      );
      console.log(`${checks - failures}/${checks} checks passed`);
      process.exit(0);
    }
    console.log(`  · active = ${show(initial ?? defRef)}   switching to B = ${show(modelB)}`);

    // 3. the UI's write path: switch, then (separately) prompt
    console.log("— POST /api/session/:id/model —");
    const switched = await api<unknown>(url, `/api/session/${encodeURIComponent(sessionId)}/model`, {
      method: "POST",
      body: JSON.stringify({ model: { providerID: modelB.providerID, modelID: modelB.modelID } }),
    });
    ok(
      "switch to B → 204 empty",
      switched.status === 204 && switched.body === undefined,
      `status ${switched.status} body ${JSON.stringify(switched.body)?.slice(0, 160)}`,
    );

    // The session-create path also announces pi's boot model, so match on the
    // target model too — otherwise this picks up the earlier envelope.
    let selected: V2Envelope | undefined;
    try {
      selected = await stream.waitFor(
        "session.model.selected",
        (e) => e.data.sessionID === sessionId && sameRef(refOf(pickModel(e.data.model)), modelB),
        10_000,
      );
      ok("SSE session.model.selected announces B", true, JSON.stringify(selected.data).slice(0, 160));
    } catch (err) {
      ok("SSE session.model.selected announces B", false, err instanceof Error ? err.message : String(err));
    }
    // A transition, not a fresh announcement: the envelope must say what it
    // moved away from, or the UI cannot render an honest "switched" marker.
    const previous = selected === undefined ? undefined : refOf(pickModel(selected.data.previous));
    ok(
      "session.model.selected carries the model it switched from",
      previous !== undefined && inCatalog(catalog, previous),
      `previous=${show(previous)}`,
    );

    const afterSwitch = sessionModel(await getSession(url, sessionId));
    ok(
      "GET /api/session/:id reports B",
      sameRef(afterSwitch, modelB),
      `reported=${show(afterSwitch)} expected=${show(modelB)}`,
    );

    // 4. the UI calls this before EVERY send — a no-op switch must stay quiet,
    // otherwise the transcript fills up with phantom "model switched" markers.
    console.log("— idempotence —");
    const before = stream.seen("session.model.selected", (e) => e.data.sessionID === sessionId).length;
    const again = await api<unknown>(url, `/api/session/${encodeURIComponent(sessionId)}/model`, {
      method: "POST",
      body: JSON.stringify({ model: { providerID: modelB.providerID, modelID: modelB.modelID } }),
    });
    ok("re-switch to B → 204", again.status === 204, `status ${again.status}`);
    await sleep(2_000);
    const after = stream.seen("session.model.selected", (e) => e.data.sessionID === sessionId).length;
    ok("re-switch emits no second session.model.selected", after === before, `${before} → ${after}`);

    // 5. a model pi does not know must be refused, not silently accepted
    console.log("— invalid model —");
    const bogus = await api<{ error?: string; name?: string }>(
      url,
      `/api/session/${encodeURIComponent(sessionId)}/model`,
      {
        method: "POST",
        body: JSON.stringify({ model: { providerID: "nope", modelID: "nope" } }),
      },
    );
    ok(
      "switch to nope/nope → 400",
      bogus.status === 400,
      `status ${bogus.status} body ${JSON.stringify(bogus.body).slice(0, 160)}`,
    );
    const afterBogus = sessionModel(await getSession(url, sessionId));
    ok("session still reports B after the refused switch", sameRef(afterBogus, modelB), `reported=${show(afterBogus)}`);

    // 6. the reply must be attributed to the model that actually produced it
    console.log("— prompt + reply attribution —");
    const clientMessageId = `msg_modelsmoke${Date.now()}`;
    const prompt = await api<{ data?: { id?: string; type?: string } }>(
      url,
      `/api/session/${encodeURIComponent(sessionId)}/prompt`,
      {
        method: "POST",
        body: JSON.stringify({ id: clientMessageId, text: "Reply with the single word: pong", delivery: "steer" }),
      },
    );
    ok(
      "POST /api/session/:id/prompt {data:UserMessage}",
      prompt.status === 200 && prompt.body.data?.id === clientMessageId,
      JSON.stringify(prompt.body).slice(0, 200),
    );

    const deadline = Date.now() + 180_000;
    let reply: MessageBody | undefined;
    while (Date.now() < deadline) {
      const res = await api<{ data?: MessageBody[] }>(
        url,
        `/api/session/${encodeURIComponent(sessionId)}/message?order=asc`,
      );
      const done = (res.body.data ?? []).find((m) => m.type === "assistant" && assistantText(m).trim() !== "");
      if (done !== undefined) {
        reply = done;
        break;
      }
      await sleep(1_000);
    }
    ok(
      "assistant reply arrived",
      reply !== undefined,
      reply === undefined ? "timed out after 180s" : assistantText(reply).slice(0, 80),
    );

    const replyModel =
      reply === undefined ? undefined : refOf({ id: reply.model?.id, providerID: reply.model?.providerID });
    ok("reply is attributed to a real model", replyModel !== undefined, `model=${show(replyModel)}`);
    ok(
      "reply provider is B's provider",
      replyModel?.providerID === modelB.providerID,
      `got=${replyModel?.providerID ?? "<none>"} expected=${modelB.providerID}`,
    );
    // pi may report the provider's concrete `responseModel` rather than the
    // requested id (alias resolution). That is still pi's truth — but it must
    // then be a catalog member, not a fabrication.
    ok(
      "reply model id is B (or a catalog member pi resolved it to)",
      sameRef(replyModel, modelB) || inCatalog(catalog, replyModel),
      `got=${show(replyModel)} expected=${show(modelB)}`,
    );

    // The step envelope is what renders the model in the transcript header.
    const step = stream.seen("session.step.started", (e) => e.data.sessionID === sessionId).at(-1);
    const stepModel = step === undefined ? undefined : refOf(pickModel(step.data.model));
    ok(
      "session.step.started carries the same model",
      sameRef(stepModel, replyModel),
      `step=${show(stepModel)} reply=${show(replyModel)}`,
    );

    // 7. restart: the sidebar must show the right model before pi is woken up
    console.log("— restart (dormant session) —");
    stream.stop();
    sse = undefined;
    await server.stop();
    server = undefined;

    const revived = new AdapterServer({ port: 0, host: "127.0.0.1", defaultDirectory: WORKSPACE });
    await revived.start();
    server = revived;
    const url2 = revived.url;
    console.log(`adapter (restarted): ${url2}`);

    const listed = await api<{ data?: SessionBody[]; cursor?: { previous: unknown; next: unknown } }>(
      url2,
      `/api/session?directory=${encodeURIComponent(WORKSPACE)}`,
    );
    const restored = (listed.body.data ?? []).find((s) => s.id === sessionId);
    ok(
      "restored session is listed after restart",
      restored !== undefined,
      `${(listed.body.data ?? []).length} sessions listed`,
    );

    // No prompt, no revive: this is served purely from the persisted registry.
    const dormant = sessionModel(await getSession(url2, sessionId));
    ok(
      "dormant session still reports B (no prompt sent)",
      sameRef(dormant, modelB),
      `reported=${show(dormant)} expected=${show(modelB)}`,
    );
  } finally {
    sse?.stop();
    if (server !== undefined) await server.stop().catch(() => undefined);
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  process.exit(failures > 0 ? 1 : 0);
}

/**
 * `data.model` on a v2 envelope is `{id, providerID}`; normalize it into the
 * `{modelID, providerID}` keys `refOf` reads so one helper serves both the
 * catalog and the event stream.
 */
function pickModel(value: unknown): { modelID?: string; providerID?: string } {
  if (typeof value !== "object" || value === null) return {};
  const raw = value as Record<string, unknown>;
  const out: { modelID?: string; providerID?: string } = {};
  if (typeof raw.id === "string" && raw.id !== "") out.modelID = raw.id;
  if (typeof raw.providerID === "string" && raw.providerID !== "") out.providerID = raw.providerID;
  return out;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
