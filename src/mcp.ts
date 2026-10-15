/**
 * OpenCode MCP routes (v1 `/mcp*`, v2 `/api/mcp` and `mcp_*` integrations) backed by OmO's MCP service.
 *
 * OpenChamber scopes MCP calls by directory only, while OmO owns MCP per session process.
 * Everything therefore targets the most recently used LIVE session in the directory; a
 * dormant session is never revived just to answer an MCP request.
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
 */

import { randomUUID } from "node:crypto";
import { errorBody } from "./http.js";
import type { PiRpcClient } from "./pi-rpc.js";
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
  s: ManagedSession;
  pi: PiRpcClient;
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
  error?: string;
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

const flows = new Map<string, AuthFlow>();
const admissions = new Map<string, Promise<Admission>>();

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
  const response = await pi.command<unknown>(
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

async function directoryServers(sessions: SessionManager, directory: string): Promise<OmoMcpServer[]> {
  const live = liveSession(sessions, directory);
  return live === undefined ? [] : loadedServers(live.pi).catch(() => []);
}

async function hasMcpCommand(pi: PiRpcClient): Promise<boolean> {
  const response = await pi.command<unknown>(
    { type: "get_commands" },
    undefined,
    AbortSignal.timeout(MCP_READ_WAIT_MS),
  );
  if (!response.success || !isRecord(response.data) || !Array.isArray(response.data.commands)) return false;
  return response.data.commands.some(
    (command: unknown) => isRecord(command) && command.name === "mcp" && command.source === "extension",
  );
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
  s: ManagedSession,
  pi: PiRpcClient,
  name: string,
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
  return sessions.lifecycle
    .use(s, () =>
      pi.command<unknown>(
        { type: "prompt", message: `/mcp ${args}`, expandPromptTemplates: true },
        MCP_AUTH_COMMAND_TIMEOUT_MS,
      ),
    )
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

type Admission = { flow: AuthFlow } | { error: RouteResult };

function pruneFlows(): void {
  const now = Date.now();
  for (const [key, flow] of flows)
    if (!flow.running && (flow.s.pi !== flow.pi || now - flow.created > MCP_AUTH_ATTEMPT_TTL_MS)) flows.delete(key);
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
  const live = liveSession(services.sessions, directory);
  if (live === undefined)
    return {
      error: {
        status: 400,
        body: errorBody("McpUnavailableError", "MCP authorization needs a running OmO session in this directory"),
      },
    };
  const { s, pi } = live;
  const key = flowKey(directory, name);
  pruneFlows();
  const existing = flows.get(key);
  if (existing?.running && existing.pi === pi)
    return existing.command === command ? { flow: existing } : inProgress(name);
  const servers = await loadedServers(pi);
  if (!servers.some((server) => server.name === name))
    return { error: { status: 404, body: errorBody("McpServerNotFoundError", `MCP server not found: ${name}`) } };
  if (!(await hasMcpCommand(pi)))
    return { error: { status: 400, body: errorBody("UnsupportedError", "This OmO build has no /mcp command") } };
  const url = Promise.withResolvers<string>();
  const flow: AuthFlow = {
    s,
    pi,
    command,
    attemptID: randomUUID(),
    created: Date.now(),
    url: url.promise,
    done: Promise.resolve(),
    running: true,
    authorized: false,
  };
  flow.done = runMcpCommand(services.sessions, s, pi, name, `${command} ${name}`, {
    url: (found) => {
      flow.authorizationUrl ??= found;
      url.resolve(found);
    },
    authorized: () => {
      flow.authorized = true;
    },
  })
    .then(() => {
      if (flow.authorized) announce(services, directory, name);
    })
    .catch((error: unknown) => {
      flow.error = errorMessage(error);
      throw error;
    })
    .finally(() => {
      flow.running = false;
    });
  // The caller that started the flow may already have its URL; a later failure is still reported.
  void flow.done.catch((error: unknown) =>
    console.error(`[mcp] authorization of ${name} failed: ${errorMessage(error)}`),
  );
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
  if (flow === undefined || flow.s.pi !== flow.pi || Date.now() - flow.created > MCP_AUTH_ATTEMPT_TTL_MS)
    return fail(400, "McpAuthError", `No pending authorization for ${name}; start it again`);
  if (flow.authorized) return { server: await currentStatus(flow.pi, name) };
  if (flow.error !== undefined)
    return fail(400, "McpAuthError", `Authorization of ${name} failed (${flow.error}); start it again`);
  if (typeof input !== "string" || flow.authorizationUrl === undefined)
    return fail(400, "InvalidRequestError", "code is required");
  const redirect = redirectInput(flow.authorizationUrl, input);
  if (redirect === undefined)
    return fail(400, "InvalidRequestError", "code must be an authorization code or redirect URL");
  try {
    if (flow.running && flow.command === "auth") {
      const target = new URL(redirect);
      if (!sameCallback(target, flow.authorizationUrl))
        return fail(400, "McpAuthError", `OmO is waiting for ${name} on its loopback callback; paste that redirect`);
      const delivered = await fetch(target, { redirect: "manual", signal: AbortSignal.timeout(MCP_READ_WAIT_MS) });
      if (!delivered.ok)
        return fail(400, "McpAuthError", `OmO rejected the authorization response for ${name}; start it again`);
      await flow.done;
    } else {
      await runMcpCommand(services.sessions, flow.s, flow.pi, name, `auth-complete ${name} ${redirect}`, {
        authorized: () => {
          flow.authorized = true;
        },
      });
      announce(services, directory, name);
    }
  } catch (error) {
    flow.error = errorMessage(error);
    return fail(400, "McpAuthError", flow.error);
  }
  if (!flow.authorized)
    return fail(400, "McpAuthError", flow.error ?? `MCP server ${name} did not complete authorization`);
  return { server: await currentStatus(flow.pi, name) };
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
    const server = await currentStatus(flow.pi, name);
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
    if (flow !== undefined) flows.delete(flowKey(directory, name));
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
