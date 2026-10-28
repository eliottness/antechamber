import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { openCodeMcpStatus, redirectInput, v2McpStatus } from "../src/mcp.js";
import { PiRpcClient } from "../src/pi-rpc.js";
import { AdapterServer } from "../src/server.js";
import { V2EventTranslator } from "../src/v2.js";

const fixture = resolve("test/fixtures/mcp-omo.mjs");

async function startServer(t: TestContext, env: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "antechamber-mcp-"));
  const saved = new Map(
    ["ANTECHAMBER_PI_BINARY", "ANTECHAMBER_STATE_DIR", "PI_CODING_AGENT_DIR", ...Object.keys(env)].map((key) => [
      key,
      process.env[key],
    ]),
  );
  Object.assign(process.env, env);
  process.env.ANTECHAMBER_PI_BINARY = fixture;
  process.env.ANTECHAMBER_STATE_DIR = join(root, "state");
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const server = new AdapterServer({ port: 0, host: "127.0.0.1", defaultDirectory: root });
  await server.start();
  t.after(async () => {
    await server.stop();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { server, url: server.url, root };
}

async function call(url: string, method: string, path: string, body?: unknown) {
  const response = await fetch(`${url}${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
  const text = await response.text();
  return { status: response.status, body: (text === "" ? undefined : JSON.parse(text)) as unknown };
}

const at = (value: unknown, ...keys: string[]): unknown =>
  keys.reduce<unknown>(
    (current, key) =>
      current !== null && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined,
    value,
  );
const named = (value: unknown, name: string): unknown =>
  (Array.isArray(value) ? value : []).find((entry: unknown) => at(entry, "name") === name);

async function liveSession(server: AdapterServer, url: string): Promise<{ id: string; pi: PiRpcClient }> {
  const created = await call(url, "POST", "/session");
  const id = at(created.body, "id") as string;
  const pi = server["sessions"].get(id)?.pi;
  assert.ok(pi, "session must have a running agent");
  return { id, pi };
}

function nextEvent(pi: PiRpcClient, match: (event: Record<string, unknown>) => boolean): Promise<void> {
  const seen = Promise.withResolvers<void>();
  const timer = setTimeout(() => seen.reject(new Error("timed out waiting for agent event")), 5_000);
  const listener = (event: Record<string, unknown>): void => {
    if (!match(event)) return;
    clearTimeout(timer);
    pi.off("event", listener);
    seen.resolve();
  };
  pi.onEvent(listener);
  return seen.promise;
}

const authEntry = (event: Record<string, unknown>): boolean =>
  event.type === "entry_appended" && (event.entry as { customType?: string } | undefined)?.customType === "mcp-auth";

test("OmO runtime states fold onto OpenCode v1 and v2 MCP statuses", () => {
  assert.deepEqual(openCodeMcpStatus({ name: "a", status: "connected", authStatus: "oAuth" }), { status: "connected" });
  assert.deepEqual(openCodeMcpStatus({ name: "a", status: "idle", authStatus: "unsupported" }), {
    status: "connected",
  });
  assert.deepEqual(openCodeMcpStatus({ name: "a", status: "idle", authStatus: "notLoggedIn" }), {
    status: "needs_auth",
  });
  assert.deepEqual(openCodeMcpStatus({ name: "a", status: "untrusted" }), { status: "disabled" });
  assert.equal(openCodeMcpStatus({ name: "a", status: "degraded" }).status, "failed");
  assert.equal(
    openCodeMcpStatus({ name: "a", status: "needs_client_registration" }).status,
    "needs_client_registration",
  );
  assert.deepEqual(v2McpStatus({ name: "a", status: "needs_auth" }), {
    status: "needs_auth",
    error: "Sign-in required",
  });
  assert.deepEqual(v2McpStatus({ name: "a", status: "connecting", authStatus: "unsupported" }), { status: "pending" });
});

test("a bare code is rebuilt into the redirect auth-complete expects; a pasted redirect passes through", () => {
  const authorization =
    "https://auth.example.test/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A0%2Fcallback&state=s1";
  assert.equal(redirectInput(authorization, "abc"), "http://127.0.0.1:0/callback?code=abc&state=s1");
  assert.equal(
    redirectInput(authorization, "http://127.0.0.1:0/callback?code=abc&state=s1&iss=x"),
    "http://127.0.0.1:0/callback?code=abc&state=s1&iss=x",
  );
  assert.equal(redirectInput(authorization, "two words"), undefined);
});

test("v2 announces MCP status changes as mcp.status.changed", () => {
  const [frame] = new V2EventTranslator().translate("/w", { type: "mcp.tools.changed", properties: { server: "x" } });
  assert.equal(frame?.type, "mcp.status.changed");
  assert.deepEqual(frame?.data, { server: "x" });
});

test("v1 status comes from a live session, preferring the directory's, and is empty without one", async (t) => {
  const { server, url, root } = await startServer(t);
  assert.deepEqual(await call(url, "GET", "/mcp"), { status: 200, body: {} });
  await liveSession(server, url);
  const expected = {
    linear: { status: "needs_auth" },
    github: { status: "needs_auth" },
    notion: { status: "needs_auth" },
    local: { status: "connected" },
    broken: { status: "needs_auth" },
  };
  assert.deepEqual((await call(url, "GET", "/mcp")).body, expected);
  // A directory whose sessions are all dormant reads the servers from the live one elsewhere.
  const elsewhere = encodeURIComponent(join(root, "dormant-project"));
  assert.deepEqual((await call(url, "GET", `/mcp?directory=${elsewhere}`)).body, expected);
  assert.equal((await call(url, "POST", `/mcp/linear/auth?directory=${elsewhere}`)).status, 400);
});

test("v1 auth start returns OmO's URL, completes in OmO, and leaves the conversation untouched", async (t) => {
  const { server, url } = await startServer(t);
  const { id, pi } = await liveSession(server, url);
  const started = await call(url, "POST", "/mcp/linear/auth");
  assert.equal(started.status, 200);
  const authorization = new URL(at(started.body, "authorizationUrl") as string);
  assert.equal(at(started.body, "oauthState"), "state-linear");
  assert.match(authorization.searchParams.get("redirect_uri") ?? "", /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.equal(pi.isBusy, true, "the pending flow keeps the idle reaper away");
  assert.equal(
    at((await call(url, "POST", "/mcp/linear/auth")).body, "authorizationUrl"),
    at(started.body, "authorizationUrl"),
    "a second click joins the running flow",
  );
  const changed = nextEvent(pi, (event) => event.type === "loaded_surfaces_changed");
  pi.notify({ type: "fixture_approve", name: "linear" });
  await changed;
  assert.deepEqual(at((await call(url, "GET", "/mcp")).body, "linear"), { status: "connected" });
  assert.deepEqual(server["sessions"].messages(id), []);
  assert.equal(server["sessions"].get(id)?.status.type, "idle");
});

test("concurrent clicks share one OmO flow", async (t) => {
  const { server, url } = await startServer(t);
  const { pi } = await liveSession(server, url);
  const original = pi.command.bind(pi);
  const prompts: string[] = [];
  t.mock.method(pi, "command", (...args: Parameters<PiRpcClient["command"]>) => {
    if (args[0].type === "prompt") prompts.push(String(args[0].message));
    return original(...args);
  });
  const [first, second] = await Promise.all([
    call(url, "POST", "/mcp/linear/auth"),
    call(url, "POST", "/mcp/linear/auth"),
  ]);
  assert.equal(first.status, 200);
  assert.deepEqual(second, first);
  assert.deepEqual(prompts, ["/mcp auth linear"]);
  const done = await call(url, "POST", "/mcp/linear/auth/callback", { code: "good-code" });
  assert.deepEqual(done, { status: 200, body: { status: "connected" } });
});

test("v1 native authenticate waits for the whole OmO flow", async (t) => {
  const { server, url } = await startServer(t);
  const { pi } = await liveSession(server, url);
  const announced = nextEvent(pi, authEntry);
  const authenticated = call(url, "POST", "/mcp/github/auth/authenticate");
  await announced;
  pi.notify({ type: "fixture_approve", name: "github" });
  assert.deepEqual(await authenticated, { status: 200, body: { status: "connected" } });
});

test("v1 callback hands a pasted code to OmO's waiting loopback listener", async (t) => {
  const { server, url } = await startServer(t);
  await liveSession(server, url);
  assert.equal((await call(url, "POST", "/mcp/notion/auth/callback", { code: "good-code" })).status, 400);
  const started = await call(url, "POST", "/mcp/notion/auth");
  assert.equal(started.status, 200);
  const elsewhere = await call(url, "POST", "/mcp/notion/auth/callback", {
    code: "http://127.0.0.1:1/other?code=good-code&state=state-notion",
  });
  assert.equal(elsewhere.status, 400, "only the announced listener receives a pasted redirect");
  const rejected = await call(url, "POST", "/mcp/notion/auth/callback", { code: "bad-code" });
  assert.equal(rejected.status, 400);
  const retry = await call(url, "POST", "/mcp/notion/auth/callback", { code: "good-code" });
  assert.equal(retry.status, 400);
  assert.match(JSON.stringify(retry.body), /start it again/);
  assert.equal((await call(url, "POST", "/mcp/notion/auth")).status, 200);
  assert.deepEqual(await call(url, "POST", "/mcp/notion/auth/callback", { code: "good-code" }), {
    status: 200,
    body: { status: "connected" },
  });
});

test("v2 lists OmO servers and signs in through auth-start and auth-complete", async (t) => {
  const { server, url, root } = await startServer(t);
  assert.deepEqual(at((await call(url, "GET", "/api/mcp")).body, "data"), []);
  const { id } = await liveSession(server, url);
  const listed = await call(url, "GET", "/api/mcp");
  assert.deepEqual(at(listed.body, "location"), { directory: root });
  assert.deepEqual(named(at(listed.body, "data"), "linear"), {
    name: "linear",
    status: { status: "needs_auth", error: "Sign-in required" },
    integrationID: "mcp_linear",
  });
  assert.deepEqual(named(at(listed.body, "data"), "local"), { name: "local", status: { status: "connected" } });
  const integrations = at((await call(url, "GET", "/api/integration")).body, "data") as Array<{ id: string }>;
  assert.deepEqual(integrations.map((integration) => integration.id).sort(), [
    "mcp_broken",
    "mcp_github",
    "mcp_linear",
    "mcp_notion",
  ]);
  assert.equal(at((await call(url, "GET", "/api/integration/mcp_linear")).body, "data", "metadata", "source"), "mcp");
  assert.equal((await call(url, "GET", "/api/integration/mcp_local")).status, 404);

  const base = "/api/integration/mcp_linear/connect/oauth";
  const first = at((await call(url, "POST", base, { methodID: "oauth" })).body, "data");
  const firstID = at(first, "attemptID") as string;
  assert.equal(at(first, "mode"), "code");
  assert.equal(new URL(at(first, "url") as string).searchParams.get("redirect_uri"), "http://127.0.0.1:0/callback");
  assert.equal(at((await call(url, "GET", `${base}/${firstID}`)).body, "data", "status"), "pending");
  const rejected = await call(url, "POST", `${base}/${firstID}/complete`, { code: "bad-code" });
  assert.equal(rejected.status, 400);
  assert.match(JSON.stringify(rejected.body), /rejected or expired/);
  assert.equal(at((await call(url, "GET", `${base}/${firstID}`)).body, "data", "status"), "failed");

  assert.equal((await call(url, "DELETE", `${base}/${firstID}`)).status, 204);
  assert.equal((await call(url, "GET", `${base}/${firstID}`)).status, 404);
  const secondID = at((await call(url, "POST", base, { methodID: "oauth" })).body, "data", "attemptID") as string;
  const completed = await call(url, "POST", `${base}/${secondID}/complete`, {
    code: "http://127.0.0.1:0/callback?code=good-code&state=state-linear",
  });
  assert.equal(completed.status, 204);
  assert.equal(at((await call(url, "GET", `${base}/${secondID}`)).body, "data", "status"), "complete");
  assert.deepEqual(at(named(at((await call(url, "GET", "/api/mcp")).body, "data"), "linear"), "status"), {
    status: "connected",
  });
  assert.deepEqual(server["sessions"].messages(id), []);
});

test("signing in without a running session uses an agent of its own, stopped once the flow completes", async (t) => {
  const { server, url } = await startServer(t);
  // The catalog and command list spawn agents of their own; only the ones asked about MCP count.
  const mcpAgents = new Set<PiRpcClient>();
  const disposed = new Set<PiRpcClient>();
  const command = PiRpcClient.prototype.command;
  const dispose = PiRpcClient.prototype.dispose;
  t.mock.method(
    PiRpcClient.prototype,
    "command",
    function (this: PiRpcClient, ...args: Parameters<PiRpcClient["command"]>) {
      if (args[0].type === "get_loaded_surfaces") mcpAgents.add(this);
      return command.apply(this, args);
    },
  );
  t.mock.method(PiRpcClient.prototype, "dispose", function (this: PiRpcClient) {
    disposed.add(this);
    return dispose.call(this);
  });
  const stopped = () => [...mcpAgents].filter((agent) => disposed.has(agent)).length;
  const base = "/api/integration/mcp_linear/connect/oauth";
  const started = await call(url, "POST", base, { methodID: "oauth" });
  assert.equal(started.status, 200);
  const attemptID = at(started.body, "data", "attemptID") as string;
  assert.equal(mcpAgents.size, 1);
  assert.equal(stopped(), 0, "the agent holds OmO's pending state until the code arrives");
  const completed = await call(url, "POST", `${base}/${attemptID}/complete`, { code: "good-code" });
  assert.equal(completed.status, 204);
  assert.equal(at((await call(url, "GET", `${base}/${attemptID}`)).body, "data", "status"), "complete");
  assert.equal(stopped(), 1);
  assert.deepEqual(server["sessions"].list(), []);
  assert.equal((await call(url, "POST", `/mcp/missing/auth`)).status, 404);
  assert.equal(mcpAgents.size, 2);
  assert.equal(stopped(), 2, "a refused start stops its agent too");
});

test("the builtin MCP command is found when an extension also registers mcp", async (t) => {
  const { server, url } = await startServer(t, { FAKE_MCP_COMMAND_COLLISION: "1" });
  const { pi } = await liveSession(server, url);
  const original = pi.command.bind(pi);
  const prompts: string[] = [];
  t.mock.method(pi, "command", (...args: Parameters<PiRpcClient["command"]>) => {
    if (args[0].type === "prompt") prompts.push(String(args[0].message));
    return original(...args);
  });
  assert.equal((await call(url, "POST", "/mcp/linear/auth")).status, 200);
  const done = await call(url, "POST", "/mcp/linear/auth/callback", { code: "good-code" });
  assert.deepEqual(done, { status: 200, body: { status: "connected" } });
  assert.deepEqual(prompts, ["/mcp:1 auth linear"]);
});

test("a sign-in reconnects the server in the other running sessions", async (t) => {
  const { server, url, root } = await startServer(t);
  const { pi } = await liveSession(server, url);
  const elsewhere = join(root, "other-project");
  mkdirSync(elsewhere);
  const query = `?directory=${encodeURIComponent(elsewhere)}`;
  const base = `/api/integration/mcp_linear/connect/oauth`;
  const attemptID = at((await call(url, "POST", `${base}${query}`, { methodID: "oauth" })).body, "data", "attemptID");
  const reconnected = nextEvent(pi, (event) => event.type === "loaded_surfaces_changed");
  const completed = await call(url, "POST", `${base}/${String(attemptID)}/complete${query}`, { code: "good-code" });
  assert.equal(completed.status, 204);
  await reconnected;
  assert.deepEqual(at(named(at((await call(url, "GET", `/api/mcp${query}`)).body, "data"), "linear"), "status"), {
    status: "connected",
  });
});

test("v1 auth failures, unknown servers and unsafe names are rejected", async (t) => {
  const { server, url } = await startServer(t);
  await liveSession(server, url);
  const failed = await call(url, "POST", "/mcp/broken/auth");
  assert.equal(failed.status, 400);
  assert.match(JSON.stringify(failed.body), /state did not match/);
  assert.equal((await call(url, "POST", "/mcp/missing/auth")).status, 404);
  assert.equal((await call(url, "POST", `/mcp/${encodeURIComponent("linear extra")}/auth`)).status, 400);
  for (const [method, path] of [
    ["POST", "/mcp/linear/connect"],
    ["POST", "/mcp/linear/disconnect"],
    ["DELETE", "/mcp/linear/auth"],
  ] as const) {
    const response = await call(url, method, path);
    assert.equal(response.status, 400, `${method} ${path}`);
    assert.equal(at(response.body, "name"), "UnsupportedError");
  }
});
