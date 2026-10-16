import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { AdapterServer } from "../src/server.js";
import { bugHarness } from "./bug-harness.js";
import { SessionStore } from "../src/session-store.js";

test("an explicit placeholder title remains user owned after the first prompt", async (t) => {
  const h = bugHarness(t);
  const session = await h.manager.create(h.root, "New session");
  await h.manager.prompt(session.id, "normal");
  assert.equal(h.manager.get(session.id)?.info.title, "New session");
});

test("get_state supplies a native title without a session name event", async (t) => {
  const h = bugHarness(t);
  const previous = process.env.ANTECHAMBER_TEST_NATIVE_TITLE;
  process.env.ANTECHAMBER_TEST_NATIVE_TITLE = "Existing native title";
  t.after(() => {
    if (previous === undefined) delete process.env.ANTECHAMBER_TEST_NATIVE_TITLE;
    else process.env.ANTECHAMBER_TEST_NATIVE_TITLE = previous;
  });
  const session = await h.manager.create(h.root);
  assert.equal(session.title, "Existing native title");
  assert.ok(h.events.some((e) => e.type === "session.updated" && e.properties.info.title === session.title));
});

test("native titles replace fallback after idle without rename feedback and preserve user ownership on revive", async (t) => {
  const h = bugHarness(t);
  const session = await h.manager.create(h.root);
  await h.manager.prompt(session.id, "normal");
  const pi = h.manager.get(session.id)?.pi;
  assert.ok(pi);
  await pi.command({ type: "native_title", name: "  Native task\nname  " });
  assert.equal(h.manager.get(session.id)?.info.title, "Native task name");
  assert.ok(h.events.some((e) => e.type === "session.updated" && e.properties.info.title === "Native task name"));
  assert.ok(h.frames.some((e) => e.type === "session.renamed" && e.data.title === "Native task name"));
  const inspection = await pi.command<{ commands: Array<{ type: string }> }>({ type: "inspect" });
  assert.equal(inspection.data?.commands.filter((c) => c.type === "set_session_name").length, 0);
  h.manager.update(session.id, { title: "My override" });
  await pi.command({ type: "native_title", name: "Delayed native title" });
  assert.equal(h.manager.get(session.id)?.info.title, "My override");
  const renamed = await pi.command<{ commands: Array<{ type: string }> }>({ type: "inspect" });
  assert.equal(renamed.data?.commands.filter((c) => c.type === "set_session_name").length, 1);
  await h.restart();
  assert.equal(h.manager.get(session.id)?.info.title, "My override");
  h.manager.update(session.id, { title: "Dormant override" });
  await h.manager.prompt(session.id, "normal");
  const revived = await h.manager
    .get(session.id)
    ?.pi?.command<{ commands: Array<{ type: string; name?: string }> }>({ type: "inspect" });
  assert.deepEqual(
    revived?.data?.commands.filter((c) => c.type === "set_session_name").map((c) => c.name),
    ["Dormant override"],
  );
  assert.equal(h.manager.get(session.id)?.info.title, "Dormant override");
});

test("slash prompts title from their arguments because OmO skips slash-led title prompts", async (t) => {
  const h = bugHarness(t);
  const session = await h.manager.create(h.root);
  await h.manager.prompt(session.id, "/skill:plan  Build the\nimporter ");
  await h.manager.prompt(session.id, "/compact");
  await h.manager.prompt(session.id, "/skill:plan /etc/hosts");
  await h.manager.prompt(session.id, "normal");
  const inspection = await h.manager
    .get(session.id)
    ?.pi?.command<{ commands: Array<{ type: string; sessionTitlePrompt?: string }> }>({ type: "inspect" });
  assert.deepEqual(
    inspection?.data?.commands.filter((c) => c.type === "prompt").map((c) => c.sessionTitlePrompt),
    ["Build the\nimporter", undefined, undefined, undefined],
  );
});

test("legacy provisional metadata yields to native names while legacy overrides win", async (t) => {
  const h = bugHarness(t);
  const session = await h.manager.create(h.root);
  await h.manager.prompt(session.id, "normal");
  await h.manager.get(session.id)?.pi?.command({ type: "native_title", name: "Native name" });
  const store = new SessionStore(join(h.root, "state"));
  const entry = store.get(session.id);
  assert.ok(entry);
  await h.restart();
  const legacy = { ...entry, title: "normal" };
  delete legacy.titleSource;
  store.set(session.id, legacy);
  await h.restart();
  assert.equal(h.manager.get(session.id)?.info.title, "Native name");
  store.set(session.id, { ...legacy, title: "Manual name" });
  await h.restart();
  assert.equal(h.manager.get(session.id)?.info.title, "Manual name");
});

test("create reconciles get_state names and advertises merged capabilities under both brand prefixes", async (t) => {
  const h = bugHarness(t);
  const keys = ["OMO_RPC_CLIENT_CAPABILITIES", "SENPI_RPC_CLIENT_CAPABILITIES"] as const;
  const previous = keys.map((key) => process.env[key]);
  t.after(() =>
    keys.forEach((key, i) => {
      if (previous[i] === undefined) delete process.env[key];
      else process.env[key] = previous[i];
    }),
  );
  process.env.OMO_RPC_CLIENT_CAPABILITIES = "extension_events, question";
  process.env.SENPI_RPC_CLIENT_CAPABILITIES = "custom_ui,extension_events";
  const session = await h.manager.create(h.root, "Explicit title");
  const inspection = await h.manager
    .get(session.id)
    ?.pi?.command<{ capabilities: string[]; commands: Array<{ type: string; name?: string }> }>({ type: "inspect" });
  assert.ok(inspection?.data);
  for (const value of inspection.data.capabilities) {
    assert.deepEqual(
      new Set(value.split(",")),
      new Set(["extension_events", "custom_ui", "auto_title_sessions", "question"]),
    );
  }
  assert.deepEqual(
    inspection.data.commands.filter((c) => c.type === "set_session_name").map((c) => c.name),
    ["Explicit title"],
  );
  const pi = h.manager.get(session.id)?.pi;
  assert.ok(pi);
  h.manager.get(session.id)?.unwirePi?.();
  await pi.command({ type: "native_title", name: "Unobserved title" });
  // The persisted native name is adopted without needing another name event.
  const second = await h.manager.create(h.root);
  await h.manager.get(second.id)?.pi?.command({ type: "native_title", name: "Existing native" });
  await h.restart();
  assert.equal(h.manager.get(second.id)?.info.title, "Existing native");
});

test("unwritable debug log preserves health and agent events with exactly one warning", {
  timeout: 15_000,
}, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "antechamber-t12-debug-"));
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "serve", "--port", "0", "--directory", dir], {
    env: {
      ...process.env,
      ANTECHAMBER_DEBUG: "1",
      ANTECHAMBER_DEBUG_LOG: "/proc/nope.log",
      ANTECHAMBER_STATE_DIR: join(dir, "state"),
      PI_CODING_AGENT_DIR: join(dir, "agent"),
      ANTECHAMBER_PI_BINARY: resolve("test/fixtures/diff-omo.mjs"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  t.after(async () => {
    child.kill("SIGTERM");
    await exited;
    rmSync(dir, { recursive: true, force: true });
  });
  const url = await new Promise<string>((resolveUrl, reject) => {
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const match = stdout.match(/listening on (http:\/\/\S+)/);
      if (match?.[1]) resolveUrl(match[1]);
    });
    child.once("exit", () => reject(new Error("connector exited before listening")));
    AbortSignal.timeout(5000).addEventListener("abort", () => reject(new Error("startup deadline")), { once: true });
  });
  assert.equal((await fetch(`${url}/global/health`)).status, 200);
  const session = (await (await fetch(`${url}/session`, { method: "POST", body: "{}" })).json()) as { id: string };
  const prompted = await fetch(`${url}/session/${session.id}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parts: [{ type: "text", text: "[]" }] }),
  });
  assert.equal(prompted.status, 200);
  assert.equal((await fetch(`${url}/global/health`)).status, 200);
  child.kill("SIGTERM");
  assert.equal((await exited)[0], 0);
  assert.equal(stderr.split("\n").filter((line) => line.startsWith("[debug] logging disabled:")).length, 1);
});

test("title matches GET, sidebar lists and session.updated through prompts, rename and reload", {
  timeout: 15_000,
}, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "antechamber-t12-title-"));
  const prior = {
    binary: process.env.ANTECHAMBER_PI_BINARY,
    state: process.env.ANTECHAMBER_STATE_DIR,
    agent: process.env.PI_CODING_AGENT_DIR,
  };
  process.env.ANTECHAMBER_PI_BINARY = resolve("test/fixtures/diff-omo.mjs");
  process.env.ANTECHAMBER_STATE_DIR = join(dir, "state");
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  let server = new AdapterServer({ host: "127.0.0.1", port: 0, defaultDirectory: dir });
  t.after(async () => {
    await server.stop();
    if (prior.binary === undefined) delete process.env.ANTECHAMBER_PI_BINARY;
    else process.env.ANTECHAMBER_PI_BINARY = prior.binary;
    if (prior.state === undefined) delete process.env.ANTECHAMBER_STATE_DIR;
    else process.env.ANTECHAMBER_STATE_DIR = prior.state;
    if (prior.agent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prior.agent;
    rmSync(dir, { recursive: true, force: true });
  });
  await server.start();
  const session = (await (
    await fetch(`${server.url}/session`, { method: "POST", body: JSON.stringify({ title: "   " }) })
  ).json()) as { id: string };
  const controller = new AbortController();
  const stream = await fetch(`${server.url}/event`, { signal: controller.signal });
  assert.ok(stream.body);
  const reader = stream.body.getReader();
  await reader.read(); // server.connected: subscription is armed before the prompt.
  const updated = (async () => {
    let text = "";
    const deadline = AbortSignal.timeout(5000);
    deadline.addEventListener("abort", () => controller.abort(), { once: true });
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("SSE ended before title");
      text += new TextDecoder().decode(chunk.value);
      const frames = text.split("\n\n");
      text = frames.pop() ?? "";
      for (const frame of frames) {
        if (!frame.startsWith("data: ")) continue;
        const event = JSON.parse(frame.slice(6));
        if (event.type === "session.updated" && event.properties.info.title === "[]") return event.properties.info;
      }
    }
  })();
  await fetch(`${server.url}/session/${session.id}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parts: [{ type: "text", text: "  []  " }] }),
  });
  const eventInfo = await updated;
  controller.abort();
  assert.equal(eventInfo.title, "[]");
  for (const path of [
    `/session/${session.id}`,
    "/session",
    "/experimental/session",
    "/experimental/session?archived=true",
  ]) {
    const body = (await (await fetch(server.url + path)).json()) as
      | { title: string }
      | Array<{ id: string; title: string }>;
    assert.equal((Array.isArray(body) ? body.find((entry) => entry.id === session.id) : body)!.title, "[]");
  }
  await fetch(`${server.url}/session/${session.id}`, {
    method: "PATCH",
    body: JSON.stringify({ title: "Renamed session" }),
  });
  await fetch(`${server.url}/session/${session.id}/message`, {
    method: "POST",
    body: JSON.stringify({ parts: [{ type: "text", text: "[]" }] }),
  });
  assert.equal(
    ((await (await fetch(`${server.url}/session/${session.id}`)).json()) as { title: string }).title,
    "Renamed session",
  );
  await server.stop();
  server = new AdapterServer({ host: "127.0.0.1", port: 0, defaultDirectory: dir });
  await server.start();
  assert.equal(
    ((await (await fetch(`${server.url}/session/${session.id}`)).json()) as { title: string }).title,
    "Renamed session",
  );
});
