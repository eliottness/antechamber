/**
 * OpenCode MCP routes (v1 `/mcp*`, v2 `/api/mcp` and `mcp_*` integrations) backed by OmO's MCP service.
 *
 * OpenChamber scopes MCP calls by directory only, while OmO owns MCP per session process.
 * Everything therefore targets the most recently used LIVE session in the directory; a
 * dormant session is never revived just to answer an MCP request. Status reads for a
 * directory without one fall back to the most recently used live session elsewhere.
 * Authorization in a directory without one runs in an agent spawned for that flow alone
 * (`--no-session`), disposed once the flow completes, fails, is cancelled or expires.
 * OmO stores tokens globally, so a completed sign-in reconnects the server in every other
 * live session.
 *
 * Status comes from the read-only `get_loaded_surfaces` RPC. Authorization drives OmO's
 * documented `/mcp` subcommands (docs/mcp.md "Auth"):
 * - `/mcp auth <name>`: OmO opens a loopback listener and the browser, exchanges the code
 *   and reconnects. With `mcp.oauthCallbackUrl` set it parks a pending flow instead.
 * - `/mcp auth-start <name>` then `/mcp auth-complete <name> <redirect-url>`: the headless
 *   paste flow; the pending PKCE state lives in that session process, so completion must
 *   reach the same process.
 * Commands are sent straight to the agent, outside the conversation queue: they neither
 * wait behind a running turn nor create a user message, and the session is held active so
 * the reaper cannot stop the process (and its listener or pending state) mid-flow.
 * An extension that registers its own `mcp` command makes OmO rename the builtin (`mcp:1`),
 * so the builtin is found by its source, not by name.
 */

import { randomUUID } from "node:crypto";
import { errorBody } from "./http.js";
import { PiRpcClient } from "./pi-rpc.js";
import type { RouteServices } from "./route-services.js";
import type { ManagedSession, SessionManager } from "./sessions.js";

type OCMcpStatus =
  | { status: "connected" }
  | { status: "disabled" }
  | { status: "failed"; error: string }
  | { status: "needs_auth" }
  | { status: "needs_client_registration"; error: string };

type V2McpStatus =
  | { status: "connected" }
  | { status: "pending" }
  | { status: "disabled" }
  | { status: "failed"; error: string }
  | { status: "needs_auth"; error: string };

interface OmoMcpServer {
  name: string;
  status?: string;
  authStatus?: string;
}

interface RouteResult {
  status: number;
  body?: unknown;
}

interface AuthFlow {
  /** Undefined when the flow runs in an agent antechamber spawned for it alone. */
  s: ManagedSession | undefined;
  pi: PiRpcClient;
  /** The slash-command name OmO gave its builtin MCP command in this agent. */
  commandName: string;
  /** `auth` may finish in OmO (loopback); `auth-start` always waits for `auth-complete`. */
  command: "auth" | "auth-start";
  attemptID: string;
  created: number;
  /** Settles only when OmO announces a URL; completion and failure come from `done`. */
  url: Promise<string>;
  authorizationUrl?: string;
  done: Promise<void>;
  running: boolean;
  authorized: boolean;
  /** Set while `completeFlow` has a command in flight; it then owns the agent's lifetime. */
  completing: boolean;
  error?: string;
  /** A dedicated agent's last status for the server, read before the agent is disposed. */
  server?: OmoMcpServer;
  /** A dedicated agent exited or was disposed. */
  released: boolean;
  expiry?: ReturnType<typeof setTimeout>;
}

/** Bounds how long an HTTP caller waits on a read-only RPC; the transport keeps its own budget. */
const MCP_READ_WAIT_MS = 5_000;
/** OmO announces the authorization URL before it waits for the browser. */
const MCP_AUTH_URL_WAIT_MS = 30_000;
/** OmO's loopback listener gives up after 5 minutes; leave room for the reconnect that follows. */
export const MCP_AUTH_COMMAND_TIMEOUT_MS = 10 * 60_000;
/** A pending paste flow is forgotten after this; OmO's own state is replaced by the next start. */
const MCP_AUTH_ATTEMPT_TTL_MS = 10 * 60_000;
/** Names are passed as one slash-command argument, so they must not split or quote. */
const SERVER_NAME = /^[^\s"'\\]+$/;
const INTEGRATION_PREFIX = "mcp_";
const OAUTH_METHOD_ID = "oauth";
const BUILTIN_MCP_PATH = "<builtin:mcp>";

/** How long an inventory read without a running agent is reused. */
const MCP_INVENTORY_TTL_MS = 30_000;
/** A fresh agent answers `get_state` once its extensions loaded, about 1.3 s on a typical install. */
const MCP_INVENTORY_START_MS = 15_000;
/** OmO reports each server settling separately at startup; one announcement covers the burst. */
const MCP_CHANGE_DEBOUNCE_MS = 250;

const flows = new Map<string, AuthFlow>();
const admissions = new Map<string, Promise<Admission>>();
const watchedDirectories = new Set<string>();
const inventories = new Map<string, { at: number; servers: Promise<OmoMcpServer[]> }>();
const inventoryAgents = new Set<PiRpcClient>();
let changeTimer: ReturnType<typeof setTimeout> | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const flowKey = (directory: string, name: string): string => `${directory}\0${name}`;

/** OmO's runtime states fold onto OpenCode's; lazy servers are usable, so they read as connected. */
export function openCodeMcpStatus(server: OmoMcpServer): OCMcpStatus {
  if (server.status === "needs_client_registration")
    return {
      status: "needs_client_registration",
      error: "OAuth client registration is required; configure a client ID for this server in OmO",
    };
  if (server.status === "needs_auth") return { status: "needs_auth" };
  if (server.status === "disabled" || server.status === "untrusted") return { status: "disabled" };
  if (server.status === "degraded") return { status: "failed", error: "MCP server is degraded; see /mcp logs in OmO" };
  if (server.status !== "connected" && server.authStatus === "notLoggedIn") return { status: "needs_auth" };
  return { status: "connected" };
}

export function v2McpStatus(server: OmoMcpServer): V2McpStatus {
  const status = openCodeMcpStatus(server);
  if (status.status === "needs_auth") return { status: "needs_auth", error: "Sign-in required" };
  if (status.status === "needs_client_registration") return { status: "needs_auth", error: status.error };
  if (status.status === "connected" && server.status === "connecting") return { status: "pending" };
  return status;
}

const oauthCapable = (server: OmoMcpServer): boolean =>
  server.authStatus === "notLoggedIn" || server.authStatus === "oAuth";

function liveSession(sessions: SessionManager, directory: string): { s: ManagedSession; pi: PiRpcClient } | undefined {
  const s = sessions.liveSessions(directory)[0];
  return s?.pi === undefined ? undefined : { s, pi: s.pi };
}

async function loadedServers(pi: PiRpcClient): Promise<OmoMcpServer[]> {
  const response = await pi.probe<unknown>(
    { type: "get_loaded_surfaces" },
    undefined,
    AbortSignal.timeout(MCP_READ_WAIT_MS),
  );
  // Older OmO builds have no loaded-surfaces RPC: report no servers rather than a failure.
  if (!response.success || !isRecord(response.data) || !Array.isArray(response.data.mcpServers)) return [];
  return response.data.mcpServers.flatMap((server: unknown) =>
    isRecord(server) && typeof server.name === "string"
      ? [
          {
            name: server.name,
            ...(typeof server.status === "string" ? { status: server.status } : {}),
            ...(typeof server.authStatus === "string" ? { authStatus: server.authStatus } : {}),
          },
        ]
      : [],
  );
}

/**
 * Resolves once no MCP server is still connecting, after `budgetMs`, or on abort. OmO cancels a running
 * compaction whenever a server's tools register (setActiveTools -> abortCompaction, senpi
 * chunks/chunk-NNQ7DPUD.js). A probe on 2026-10-28 found three servers connecting when get_state answered,
 * all connected within about a second, each change announced by `loaded_surfaces_changed`.
 */
export async function waitForMcpServers(pi: PiRpcClient, budgetMs: number, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + budgetMs;
  let changed = false;
  let wake = (): void => {};
  const listener = (ev: Record<string, unknown>): void => {
    if (ev.type !== "loaded_surfaces_changed") return;
    changed = true;
    wake();
  };
  pi.onEvent(listener);
  try {
    while (!signal?.aborted) {
      changed = false;
      const servers = await loadedServers(pi).catch(() => []);
      if (!servers.some((server) => server.status === "connecting")) return;
      if (changed) continue;
      const left = deadline - Date.now();
      if (left <= 0) return;
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", done);
          wake = () => {};
          resolve();
        };
        const timer = setTimeout(done, left);
        signal?.addEventListener("abort", done, { once: true });
        wake = done;
      });
    }
  } finally {
    pi.off("event", listener);
  }
}

async function directoryServers(sessions: SessionManager, directory: string): Promise<OmoMcpServer[]> {
  watchedDirectories.add(directory);
  // A directory whose sessions are all dormant reads a running session elsewhere: its servers are
  // mostly the user's global and built-in ones. An agent that just exited is skipped.
  const agents = new Set([liveSession(sessions, directory)?.pi, ...sessions.liveSessions().map((s) => s.pi)]);
  for (const pi of agents) {
    if (pi === undefined) continue;
    try {
      return await loadedServers(pi);
    } catch {}
  }
  return inventory(directory);
}

/** With no running agent, a short-lived `--no-session` agent reads the inventory, shared for a while. */
function inventory(directory: string): Promise<OmoMcpServer[]> {
  const cached = inventories.get(directory);
  if (cached !== undefined && Date.now() - cached.at < MCP_INVENTORY_TTL_MS) return cached.servers;
  const servers: Promise<OmoMcpServer[]> = readInventory(directory).catch((error: unknown) => {
    if (inventories.get(directory)?.servers === servers) inventories.delete(directory);
    console.error(`[mcp] listing servers for ${directory} failed: ${errorMessage(error)}`);
    return [];
  });
  inventories.set(directory, { at: Date.now(), servers });
  return servers;
}

async function readInventory(directory: string): Promise<OmoMcpServer[]> {
  const pi = new PiRpcClient({ cwd: directory, args: ["--no-session"] });
  inventoryAgents.add(pi);
  try {
    await pi.command({ type: "get_state" }, MCP_INVENTORY_START_MS);
    return await loadedServers(pi);
  } finally {
    inventoryAgents.delete(pi);
    await pi.dispose();
  }
}

/**
 * An agent started, stopped or reported new MCP state. Every directory a client read is told to read
 * again: with the cross-directory fallback, one agent can change the answer for all of them.
 */
export function mcpSurfacesChanged(broadcast: RouteServices["broadcast"]): void {
  inventories.clear();
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => {
    for (const directory of watchedDirectories)
      broadcast(directory, { type: "mcp.tools.changed", properties: { server: "" } });
  }, MCP_CHANGE_DEBOUNCE_MS);
  changeTimer.unref();
}

/** The builtin MCP command's name in this agent; builds without `sourceInfo` only know it as `mcp`. */
async function mcpCommandName(pi: PiRpcClient): Promise<string | undefined> {
  const response = await pi.probe<unknown>({ type: "get_commands" }, undefined, AbortSignal.timeout(MCP_READ_WAIT_MS));
  if (!response.success || !isRecord(response.data) || !Array.isArray(response.data.commands)) return undefined;
  const commands = response.data.commands.flatMap((command: unknown) =>
    isRecord(command) && command.source === "extension" && typeof command.name === "string"
      ? [{ name: command.name, builtin: isRecord(command.sourceInfo) && command.sourceInfo.path === BUILTIN_MCP_PATH }]
      : [],
  );
  return (commands.find((command) => command.builtin) ?? commands.find((command) => command.name === "mcp"))?.name;
}

/** The URL OmO prints on its own line after naming the server (`auth` and `auth-start` both do). */
export function authorizationUrl(text: string, name: string): string | undefined {
  if (!text.includes(name)) return undefined;
  const candidate = /(?:^|\n)(https?:\/\/\S+)/.exec(text)?.[1];
  if (candidate === undefined) return undefined;
  try {
    return new URL(candidate).toString();
  } catch {
    return undefined;
  }
}

/**
 * The redirect `/mcp auth-complete` expects. OpenChamber sends either the bare code (callback
 * page, v1 paste box) or the whole redirect address; a bare code is rebuilt from the
 * authorization request's own `redirect_uri` and `state`.
 */
export function redirectInput(authorization: string, input: string): string | undefined {
  const pasted = input.trim();
  if (pasted === "" || /\s/.test(pasted)) return undefined;
  try {
    const url = new URL(pasted);
    if (url.searchParams.has("code") || url.searchParams.has("error")) return url.toString();
  } catch {
    // Not an address: treat it as the authorization code itself.
  }
  const request = new URL(authorization).searchParams;
  const redirect = request.get("redirect_uri");
  if (redirect === null) return undefined;
  const url = new URL(redirect);
  url.searchParams.set("code", pasted);
  const state = request.get("state");
  if (state !== null) url.searchParams.set("state", state);
  return url.toString();
}

/** Only the listener OmO announced for this flow may receive the pasted redirect. */
function sameCallback(target: URL, authorization: string): boolean {
  const announced = new URL(authorization).searchParams.get("redirect_uri");
  if (announced === null) return false;
  const expected = new URL(announced);
  return target.origin === expected.origin && target.pathname === expected.pathname;
}

function runMcpCommand(
  sessions: SessionManager,
  s: ManagedSession | undefined,
  pi: PiRpcClient,
  name: string,
  commandName: string,
  args: string,
  observe: { url?: (url: string) => void; authorized?: () => void } = {},
): Promise<void> {
  const errors: string[] = [];
  const onEvent = (event: Record<string, unknown>): void => {
    const entry = event.entry;
    if (event.type !== "entry_appended" || !isRecord(entry)) return;
    if (entry.type !== "custom" || entry.customType !== "mcp-auth" || typeof entry.data !== "string") return;
    const done = `MCP server ${name} `;
    if (entry.data.startsWith(`${done}authorized`) || entry.data.startsWith(`${done}authenticated`))
      observe.authorized?.();
    const found = authorizationUrl(entry.data, name);
    if (found !== undefined) observe.url?.(found);
  };
  const onNotify = (request: Record<string, unknown>): void => {
    if (request.method !== "notify" || request.notifyType !== "error" || typeof request.message !== "string") return;
    if (request.message.includes(`MCP server ${name} `) || request.message.includes(`MCP server: ${name}`))
      errors.push(request.message);
  };
  pi.onEvent(onEvent);
  pi.onExtensionUI(onNotify);
  const send = () =>
    pi.command<unknown>(
      { type: "prompt", message: `/${commandName} ${args}`, expandPromptTemplates: true },
      MCP_AUTH_COMMAND_TIMEOUT_MS,
    );
  return (s === undefined ? send() : sessions.lifecycle.use(s, send))
    .then((response) => {
      if (!response.success) throw new Error(response.error ?? "OmO rejected the /mcp command");
      const disposition = isRecord(response.data) ? response.data.disposition : undefined;
      if (disposition !== "handled") throw new Error(`OmO did not handle /mcp (disposition: ${String(disposition)})`);
      if (errors.length > 0) throw new Error(errors.join("\n"));
    })
    .finally(() => {
      pi.off("event", onEvent);
      pi.off("extension_ui_request", onNotify);
    });
}

function announce(services: RouteServices, directory: string, name: string): void {
  services.broadcast(directory, { type: "mcp.tools.changed", properties: { server: name } });
}

/** Other live sessions keep their own connection, which still lacks the new token until it reconnects. */
function authorized(services: RouteServices, directory: string, name: string, flow: AuthFlow): void {
  announce(services, directory, name);
  const reconnects = services.sessions.liveSessions().flatMap((s) => {
    const pi = s.pi;
    if (pi === undefined || pi === flow.pi) return [];
    return [
      mcpCommandName(pi)
        .then((commandName) =>
          commandName === undefined
            ? undefined
            : runMcpCommand(services.sessions, s, pi, name, commandName, `reconnect ${name}`),
        )
        .catch((error: unknown) =>
          console.error(`[mcp] reconnecting ${name} in session ${s.info.id} failed: ${errorMessage(error)}`),
        ),
    ];
  });
  if (reconnects.length > 0) void Promise.all(reconnects).then(() => announce(services, directory, name));
}

type Admission = { flow: AuthFlow } | { error: RouteResult };

function agentCurrent(flow: AuthFlow): boolean {
  return flow.s === undefined ? !flow.released : flow.s.pi === flow.pi;
}

function release(flow: AuthFlow): void {
  if (flow.s !== undefined) return;
  flow.released = true;
  clearTimeout(flow.expiry);
  void flow.pi
    .dispose()
    .catch((error: unknown) => console.error(`[mcp] stopping an auth agent failed: ${errorMessage(error)}`));
}

/** Stops the agents spawned for sign-ins and inventories; live sessions are stopped by their own manager. */
export async function disposeMcpAgents(): Promise<void> {
  clearTimeout(changeTimer);
  inventories.clear();
  const dedicated = [...flows.values()].filter((flow) => flow.s === undefined && !flow.released);
  for (const flow of dedicated) {
    flow.released = true;
    clearTimeout(flow.expiry);
  }
  await Promise.all([...dedicated.map((flow) => flow.pi.dispose()), ...[...inventoryAgents].map((pi) => pi.dispose())]);
}

async function flowStatus(flow: AuthFlow, name: string): Promise<OmoMcpServer | undefined> {
  if (flow.server !== undefined || !agentCurrent(flow)) return flow.server;
  return currentStatus(flow.pi, name);
}

function pruneFlows(): void {
  const now = Date.now();
  for (const [key, flow] of flows)
    if (!flow.running && (!agentCurrent(flow) || now - flow.created > MCP_AUTH_ATTEMPT_TTL_MS)) {
      flows.delete(key);
      release(flow);
    }
}

/** Concurrent clicks share one admission, so a second `/mcp auth` never races the first. */
function admitFlow(
  services: RouteServices,
  directory: string,
  name: string,
  command: AuthFlow["command"],
): Promise<Admission> {
  const key = flowKey(directory, name);
  const pending = admissions.get(key);
  if (pending !== undefined)
    return pending.then((admission) =>
      "flow" in admission && admission.flow.command !== command ? inProgress(name) : admission,
    );
  const admission = startFlow(services, directory, name, command).finally(() => admissions.delete(key));
  admissions.set(key, admission);
  return admission;
}

const inProgress = (name: string): Admission => ({
  error: { status: 409, body: errorBody("McpAuthError", `MCP server ${name} authorization is already in progress`) },
});

/** Validates the target and starts (or joins) a flow; never sends a prompt without a `/mcp` command. */
async function startFlow(
  services: RouteServices,
  directory: string,
  name: string,
  command: AuthFlow["command"],
): Promise<Admission> {
  if (!SERVER_NAME.test(name))
    return { error: { status: 400, body: errorBody("InvalidRequestError", "invalid MCP server name") } };
  const key = flowKey(directory, name);
  pruneFlows();
  const existing = flows.get(key);
  if (existing?.running && agentCurrent(existing))
    return existing.command === command ? { flow: existing } : inProgress(name);
  const live = liveSession(services.sessions, directory);
  const s = live?.s;
  const pi = live?.pi ?? new PiRpcClient({ cwd: directory, args: ["--no-session"] });
  const refuse = async (status: number, error: string, message: string): Promise<Admission> => {
    if (live === undefined) await pi.dispose();
    return { error: { status, body: errorBody(error, message) } };
  };
  let servers: OmoMcpServer[];
  let commandName: string | undefined;
  try {
    // A spawned agent answers its first RPC only once it has started.
    if (live === undefined) await pi.command({ type: "get_state" });
    servers = await loadedServers(pi);
    commandName = await mcpCommandName(pi);
  } catch (error) {
    return refuse(400, "McpUnavailableError", `OmO could not start for MCP authorization: ${errorMessage(error)}`);
  }
  if (!servers.some((server) => server.name === name))
    return refuse(404, "McpServerNotFoundError", `MCP server not found: ${name}`);
  if (commandName === undefined) return refuse(400, "UnsupportedError", "This OmO build has no /mcp command");
  const url = Promise.withResolvers<string>();
  const flow: AuthFlow = {
    s,
    pi,
    commandName,
    command,
    attemptID: randomUUID(),
    created: Date.now(),
    url: url.promise,
    done: Promise.resolve(),
    running: true,
    authorized: false,
    completing: false,
    released: false,
  };
  if (live === undefined) {
    pi.onExit(() => {
      flow.released = true;
    });
    flow.expiry = setTimeout(() => release(flow), MCP_AUTH_ATTEMPT_TTL_MS);
    flow.expiry.unref();
  }
  flow.done = runMcpCommand(services.sessions, s, pi, name, commandName, `${command} ${name}`, {
    url: (found) => {
      flow.authorizationUrl ??= found;
      url.resolve(found);
    },
    authorized: () => {
      flow.authorized = true;
    },
  })
    .then(async () => {
      if (!flow.authorized) return;
      // A completion in flight set `authorized` and owns the agent: stopping it now would kill its command.
      if (live === undefined && !flow.completing) {
        const server = await currentStatus(pi, name).catch(() => undefined);
        if (server !== undefined) flow.server = server;
        release(flow);
      }
      authorized(services, directory, name, flow);
    })
    .catch((error: unknown) => {
      flow.error = errorMessage(error);
      release(flow);
      throw error;
    })
    .finally(() => {
      flow.running = false;
    });
  // The caller that started the flow may already have its URL; a later failure is still reported.
  void flow.done.catch((error: unknown) =>
    console.error(`[mcp] authorization of ${name} failed: ${errorMessage(error)}`),
  );
  if (existing !== undefined) release(existing);
  flows.set(key, flow);
  return { flow };
}

async function awaitAuthorizationUrl(flow: AuthFlow, name: string): Promise<{ url: string } | { error: string }> {
  const wait = AbortSignal.timeout(MCP_AUTH_URL_WAIT_MS);
  const timedOut = new Promise<"timeout">((resolve) => wait.addEventListener("abort", () => resolve("timeout")));
  try {
    const url = await Promise.race([flow.url, flow.done.then(() => undefined), timedOut]);
    if (url === "timeout") return { error: `OmO did not produce an authorization URL for ${name}` };
    if (url === undefined) return { error: `MCP server ${name} finished without a browser step` };
    return { url };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

async function currentStatus(pi: PiRpcClient, name: string): Promise<OmoMcpServer | undefined> {
  return (await loadedServers(pi)).find((server) => server.name === name);
}

/**
 * Finishes a flow with the code or redirect the browser produced. A flow still waiting on
 * OmO's loopback listener receives the redirect there (antechamber always runs beside its
 * agent); a parked flow is finished with `/mcp auth-complete` in the process that holds its state.
 */
async function completeFlow(
  services: RouteServices,
  directory: string,
  name: string,
  input: unknown,
): Promise<{ server: OmoMcpServer | undefined } | { error: RouteResult }> {
  const key = flowKey(directory, name);
  const flow = flows.get(key);
  const fail = (status: number, name_: string, message: string) => ({
    error: { status, body: errorBody(name_, message) },
  });
  if (flow === undefined || Date.now() - flow.created > MCP_AUTH_ATTEMPT_TTL_MS)
    return fail(400, "McpAuthError", `No pending authorization for ${name}; start it again`);
  if (flow.authorized) return { server: await flowStatus(flow, name) };
  if (!agentCurrent(flow)) return fail(400, "McpAuthError", `No pending authorization for ${name}; start it again`);
  if (flow.error !== undefined)
    return fail(400, "McpAuthError", `Authorization of ${name} failed (${flow.error}); start it again`);
  if (typeof input !== "string" || flow.authorizationUrl === undefined)
    return fail(400, "InvalidRequestError", "code is required");
  const redirect = redirectInput(flow.authorizationUrl, input);
  if (redirect === undefined)
    return fail(400, "InvalidRequestError", "code must be an authorization code or redirect URL");
  // OmO consumes the pending state on any answer, so a dedicated agent has nothing left to wait for.
  let attempted = false;
  let server: OmoMcpServer | undefined;
  flow.completing = true;
  try {
    if (flow.running && flow.command === "auth") {
      const target = new URL(redirect);
      if (!sameCallback(target, flow.authorizationUrl))
        return fail(400, "McpAuthError", `OmO is waiting for ${name} on its loopback callback; paste that redirect`);
      attempted = true;
      const delivered = await fetch(target, { redirect: "manual", signal: AbortSignal.timeout(MCP_READ_WAIT_MS) });
      if (!delivered.ok) {
        // OmO ends the flow on a rejected callback; settle it so a retry cannot join the dead flow.
        await flow.done.catch(() => undefined);
        return fail(400, "McpAuthError", `OmO rejected the authorization response for ${name}; start it again`);
      }
      await flow.done;
    } else {
      attempted = true;
      await runMcpCommand(
        services.sessions,
        flow.s,
        flow.pi,
        name,
        flow.commandName,
        `auth-complete ${name} ${redirect}`,
        {
          authorized: () => {
            flow.authorized = true;
          },
        },
      );
      if (flow.authorized) authorized(services, directory, name, flow);
      else announce(services, directory, name);
    }
    if (!flow.authorized)
      return fail(400, "McpAuthError", flow.error ?? `MCP server ${name} did not complete authorization`);
    server = await flowStatus(flow, name);
  } catch (error) {
    flow.error = errorMessage(error);
    return fail(400, "McpAuthError", flow.error);
  } finally {
    flow.completing = false;
    if (attempted) release(flow);
  }
  return { server };
}

function decodeName(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

const invalidName: RouteResult = { status: 400, body: errorBody("InvalidRequestError", "invalid MCP server name") };

export async function mcpRoute(
  services: RouteServices,
  method: string,
  path: string,
  directory: string,
  body: () => Promise<unknown>,
): Promise<RouteResult | undefined> {
  if (method === "GET" && path === "/mcp") {
    const servers = await directoryServers(services.sessions, directory);
    return { status: 200, body: Object.fromEntries(servers.map((server) => [server.name, openCodeMcpStatus(server)])) };
  }
  const match = /^\/mcp\/([^/]+)\/auth(\/authenticate|\/callback)?$/.exec(path);
  if (method !== "POST" || match === null) return undefined;
  const name = decodeName(match[1]!);
  if (name === undefined) return invalidName;
  if (match[2] === "/callback") {
    const payload = await body();
    const result = await completeFlow(services, directory, name, isRecord(payload) ? payload.code : undefined);
    if ("error" in result) return result.error;
    return {
      status: 200,
      body: result.server === undefined ? { status: "disabled" } : openCodeMcpStatus(result.server),
    };
  }
  const admitted = await admitFlow(services, directory, name, "auth");
  if ("error" in admitted) return admitted.error;
  const { flow } = admitted;
  if (match[2] === "/authenticate") {
    try {
      await flow.done;
    } catch (error) {
      return { status: 400, body: errorBody("McpAuthError", errorMessage(error)) };
    }
    if (!flow.authorized)
      return {
        status: 400,
        body: errorBody("McpAuthError", `MCP server ${name} is waiting for its authorization code; paste it to finish`),
      };
    const server = await flowStatus(flow, name);
    return { status: 200, body: server === undefined ? { status: "disabled" } : openCodeMcpStatus(server) };
  }
  const announced = await awaitAuthorizationUrl(flow, name);
  if ("error" in announced) return { status: 400, body: errorBody("McpAuthError", announced.error) };
  return {
    status: 200,
    body: { authorizationUrl: announced.url, oauthState: new URL(announced.url).searchParams.get("state") ?? "" },
  };
}

function integrationInfo(server: OmoMcpServer): Record<string, unknown> {
  return {
    id: `${INTEGRATION_PREFIX}${server.name}`,
    name: server.name,
    metadata: { source: "mcp" },
    methods: [{ id: OAUTH_METHOD_ID, type: "oauth", label: "Sign in with OAuth" }],
    connections: [],
  };
}

function attemptTime(flow: AuthFlow): { created: number; expires: number } {
  return { created: flow.created, expires: flow.created + MCP_AUTH_ATTEMPT_TTL_MS };
}

function flowForAttempt(directory: string, name: string, attemptID: string): AuthFlow | undefined {
  const flow = flows.get(flowKey(directory, name));
  return flow?.attemptID === attemptID ? flow : undefined;
}

export async function mcpRouteV2(
  services: RouteServices,
  method: string,
  path: string,
  directory: string,
  body: () => Promise<unknown>,
): Promise<RouteResult | undefined> {
  const located = (status: number, data: unknown): RouteResult => ({ status, body: { location: { directory }, data } });
  if (method === "GET" && path === "/api/mcp") {
    const servers = await directoryServers(services.sessions, directory);
    return located(
      200,
      servers.map((server) => ({
        name: server.name,
        status: v2McpStatus(server),
        ...(oauthCapable(server) ? { integrationID: `${INTEGRATION_PREFIX}${server.name}` } : {}),
      })),
    );
  }
  if (method === "GET" && path === "/api/integration") {
    const servers = await directoryServers(services.sessions, directory);
    return located(200, servers.filter(oauthCapable).map(integrationInfo));
  }
  const match = /^\/api\/integration\/mcp_([^/]+)(\/connect\/oauth(?:\/([^/]+)(\/complete)?)?)?$/.exec(path);
  if (match === null) return undefined;
  const name = decodeName(match[1]!);
  if (name === undefined) return invalidName;
  const [, , connect, rawAttempt, complete] = match;
  if (connect === undefined) {
    if (method !== "GET") return undefined;
    const server = (await directoryServers(services.sessions, directory)).find(
      (candidate) => candidate.name === name && oauthCapable(candidate),
    );
    if (server === undefined)
      return { status: 404, body: errorBody("NotFoundError", `integration not found: ${INTEGRATION_PREFIX}${name}`) };
    return located(200, integrationInfo(server));
  }
  if (rawAttempt === undefined) {
    if (method !== "POST") return undefined;
    const payload = await body();
    if (isRecord(payload) && payload.methodID !== undefined && payload.methodID !== OAUTH_METHOD_ID)
      return { status: 404, body: errorBody("IntegrationMethodNotFoundError", "unknown integration method") };
    const admitted = await admitFlow(services, directory, name, "auth-start");
    if ("error" in admitted) return admitted.error;
    const announced = await awaitAuthorizationUrl(admitted.flow, name);
    if ("error" in announced) return { status: 400, body: errorBody("McpAuthError", announced.error) };
    return located(200, {
      attemptID: admitted.flow.attemptID,
      url: announced.url,
      instructions:
        "Approve access in the browser, then paste the final redirect URL (or the code it carries) to finish.",
      mode: "code",
      time: attemptTime(admitted.flow),
    });
  }
  const attemptID = decodeName(rawAttempt);
  const flow = attemptID === undefined ? undefined : flowForAttempt(directory, name, attemptID);
  const missing: RouteResult = {
    status: 404,
    body: errorBody("IntegrationAttemptNotFoundError", `authorization attempt not found: ${rawAttempt}`),
  };
  if (complete !== undefined) {
    if (method !== "POST") return undefined;
    if (flow === undefined) return missing;
    const payload = await body();
    const result = await completeFlow(services, directory, name, isRecord(payload) ? payload.code : undefined);
    return "error" in result ? result.error : { status: 204 };
  }
  if (method === "DELETE") {
    if (flow !== undefined) {
      flows.delete(flowKey(directory, name));
      release(flow);
    }
    return { status: 204 };
  }
  if (method !== "GET") return undefined;
  if (flow === undefined) return missing;
  const time = attemptTime(flow);
  if (flow.authorized) return located(200, { status: "complete", time });
  if (flow.error !== undefined) return located(200, { status: "failed", message: flow.error, time });
  if (Date.now() > time.expires) return located(200, { status: "expired", time });
  return located(200, { status: "pending", time });
}
