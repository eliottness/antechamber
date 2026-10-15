#!/usr/bin/env node
// Fake OmO for MCP routes: loaded-surfaces inventory plus the native `/mcp auth`, `auth-start`
// and `auth-complete` commands. `/mcp auth` listens on a real loopback callback like OmO;
// `fixture_approve` stands in for the browser reaching it.
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const sessionId = randomUUID();
const sessionFile = join(process.cwd(), `fake-mcp-${sessionId}.jsonl`);
writeFileSync(
  sessionFile,
  `${JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: process.cwd(), timestamp: new Date().toISOString() })}\n`,
);

const servers = new Map([
  ["linear", { status: "needs_auth", authStatus: "notLoggedIn" }],
  ["github", { status: "idle", authStatus: "notLoggedIn" }],
  ["notion", { status: "needs_auth", authStatus: "notLoggedIn" }],
  ["local", { status: "idle", authStatus: "unsupported" }],
  ["broken", { status: "needs_auth", authStatus: "notLoggedIn" }],
]);
const pendingAuth = new Map();
const pasteStates = new Map();

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function reply(command, success, data, error) {
  send({
    type: "response",
    id: command.id,
    command: command.type,
    success,
    ...(data !== undefined ? { data } : {}),
    ...(error !== undefined ? { error } : {}),
  });
}

function authEntry(text) {
  send({
    type: "entry_appended",
    entry: { type: "custom", customType: "mcp-auth", id: randomUUID(), timestamp: Date.now(), data: text },
  });
}

function notifyError(message) {
  send({ type: "extension_ui_request", id: randomUUID(), method: "notify", message, notifyType: "error" });
}

function authorize(name) {
  servers.set(name, { status: "connected", authStatus: "oAuth" });
  authEntry(`MCP server ${name} authorized`);
  send({ type: "loaded_surfaces_changed" });
}

function authorizeUrl(name, redirect) {
  const url = new URL("https://auth.example.test/authorize");
  url.searchParams.set("client_id", "fixture");
  url.searchParams.set("redirect_uri", redirect);
  url.searchParams.set("state", `state-${name}`);
  return url.toString();
}

function finishLoopback(name) {
  const pending = pendingAuth.get(name);
  if (pending === undefined) return;
  pendingAuth.delete(name);
  pending.listener.close();
  authorize(name);
  reply(pending.command, true, { disposition: "handled" });
}

function mcpCommand(command, subcommand, name, redirect) {
  send({ type: "command_invocation", command: { name: "mcp", source: "extension", syntax: "slash" } });
  if (name === "broken") {
    notifyError(`MCP server ${name} authorization state did not match; restart the auth flow.`);
    reply(command, true, { disposition: "handled" });
    return;
  }
  if (subcommand === "auth-start") {
    pasteStates.set(name, `state-${name}`);
    authEntry(
      `Open this URL, approve, then run /mcp auth-complete ${name} <redirect-url>:\n${authorizeUrl(name, "http://127.0.0.1:0/callback")}`,
    );
    reply(command, true, { disposition: "handled" });
    return;
  }
  if (subcommand === "auth-complete") {
    const url = new URL(redirect);
    if (pasteStates.get(name) === undefined || url.searchParams.get("state") !== pasteStates.get(name)) {
      notifyError(`MCP server ${name} authorization state did not match (possible CSRF or a stale/replayed link).`);
    } else if (url.searchParams.get("code") !== "good-code") {
      notifyError(`MCP server ${name} authorization code was rejected or expired.`);
    } else {
      pasteStates.delete(name);
      authorize(name);
    }
    reply(command, true, { disposition: "handled" });
    return;
  }
  const listener = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const ok = url.searchParams.get("state") === `state-${name}` && url.searchParams.get("code") === "good-code";
    response.writeHead(ok ? 200 : 400).end();
    if (ok) {
      finishLoopback(name);
      return;
    }
    // Like OmO's LoopbackCallbackServer: a rejected callback ends the whole flow.
    const pending = pendingAuth.get(name);
    pendingAuth.delete(name);
    listener.close();
    notifyError(`MCP server ${name} authorization state did not match (possible CSRF or a stale/replayed link).`);
    if (pending !== undefined) reply(pending.command, true, { disposition: "handled" });
  });
  listener.listen(0, "127.0.0.1", () => {
    pendingAuth.set(name, { command, listener });
    authEntry(
      `Open this URL to authorize ${name}:\n${authorizeUrl(name, `http://127.0.0.1:${listener.address().port}/callback`)}`,
    );
  });
}

function handle(command) {
  switch (command.type) {
    case "get_state":
      reply(command, true, {
        model: { provider: "fake", id: "fake-model" },
        sessionId,
        sessionFile,
        isStreaming: false,
      });
      return;
    case "get_available_models":
      reply(command, true, { models: [] });
      return;
    case "get_entries":
      reply(command, true, { entries: [], leafId: null });
      return;
    case "get_commands":
      reply(command, true, {
        commands: [{ name: "mcp", description: "Inspect and manage MCP servers.", source: "extension" }],
      });
      return;
    case "get_loaded_surfaces":
      reply(command, true, {
        extensions: [],
        mcpServers: [...servers].map(([name, state]) => ({ name, toolCount: 0, ...state })),
      });
      return;
    case "fixture_approve":
      finishLoopback(command.name);
      return;
    case "prompt": {
      const match = /^\/mcp (auth|auth-start|auth-complete) (\S+)(?: (\S+))?$/.exec(command.message);
      if (match === null || command.expandPromptTemplates !== true) {
        reply(command, false, undefined, `fixture refuses model prompt: ${command.message}`);
        return;
      }
      mcpCommand(command, match[1], match[2], match[3]);
      return;
    }
    default:
      reply(command, true, {});
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim() !== "") handle(JSON.parse(line));
    newline = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
