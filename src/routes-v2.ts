/** OpenCode v2 (/api/*) routes and their response adapters. */

import type { IncomingMessage, ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { errorBody, json, RequestBodyError } from "./http.js";
import { nativePromptInput, parsePromptParts, v2PromptAttachments, v2PromptParts } from "./prompt-parts.js";
import { debugLog, miscRoute } from "./misc-routes.js";
import { mcpRouteV2 } from "./mcp.js";
import { OPENCODE_API_VERSION } from "./version.js";
import { toV2Permission } from "./approvals.js";
import { formQuestionAnswer, questionFormID, toQuestionForm } from "./question-forms.js";
import { getAgentName } from "./agent-name.js";
import { vcsRead, VcsError } from "./vcs.js";
import { announceSessionError, compactSession, getCommands, unsupportedShare } from "./session-commands.js";
import { defaultV2Model, flattenModels, toV2Message, toV2Session, type V2Session } from "./v2.js";
import type { OCSession } from "./types.js";
import {
  agentDescriptors,
  modelRefFromBody,
  numberParam,
  OPENCODE_COMPAT_VERSION,
  promptAsync,
  runSessionShell,
  runSessionSlash,
  sessionDirectory,
  sessionMetadata,
  type RouteServices,
} from "./route-services.js";

async function v2Agents(services: RouteServices): Promise<
  Array<{
    id: string;
    name: string;
    description: string;
    mode: string;
    hidden: boolean;
    options: Record<string, unknown>;
    model?: { id: string; providerID: string; variant?: string };
  }>
> {
  return (await agentDescriptors(services)).map(({ model, variant, ...agent }) => ({
    id: agent.name,
    ...agent,
    // v2 nests the effort in the agent's ModelRef; OpenChamber 2.x preselects only `model.id` + `model.variant`.
    ...(model !== undefined
      ? { model: { id: model.modelID, providerID: model.providerID, ...(variant !== undefined ? { variant } : {}) } }
      : {}),
    request: { settings: {}, headers: {}, body: {} },
    permissions: agent.permission.map((rule) => ({
      action: rule.permission,
      resource: rule.pattern,
      effect: rule.action,
    })),
    system: agent.prompt,
  }));
}

function v2Session(services: RouteServices, info: OCSession): V2Session {
  const managed = services.sessions.get(info.id);
  return toV2Session(info, { model: managed?.model, agent: info.agent ?? getAgentName() });
}

const execFileAsync = promisify(execFile);

type V2SessionCursor = { updated: number; id: string };

function encodeSessionCursor(session: V2Session): string {
  return Buffer.from(JSON.stringify({ updated: session.time.updated, id: session.id })).toString("base64url");
}

function decodeSessionCursor(value: string | null): V2SessionCursor | undefined {
  if (value === null || value === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "updated" in parsed &&
      "id" in parsed &&
      typeof parsed.updated === "number" &&
      Number.isFinite(parsed.updated) &&
      typeof parsed.id === "string"
    ) {
      return { updated: parsed.updated, id: parsed.id };
    }
  } catch {
    // A malformed continuation cursor starts a fresh listing, as OpenCode's
    // clients may retain a cursor across a restarted local server.
  }
  return undefined;
}

function compareSessions(left: V2Session, right: V2Session, order: "asc" | "desc"): number {
  const comparison = left.time.updated - right.time.updated || left.id.localeCompare(right.id);
  return order === "asc" ? comparison : -comparison;
}

function followsCursor(session: V2Session, cursor: V2SessionCursor, order: "asc" | "desc"): boolean {
  const comparison = session.time.updated - cursor.updated || session.id.localeCompare(cursor.id);
  return order === "asc" ? comparison > 0 : comparison < 0;
}

async function currentGitBranch(directory: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["symbolic-ref", "--short", "HEAD"], {
      cwd: directory,
      timeout: 3000,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function initializeGit(directory: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: directory, timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/** v2 `/api/project` list: the adapter has no project registry, so expose the
 * directories it knows about (the default plus every restorable session). */
function v2Projects(services: RouteServices): Array<Record<string, unknown>> {
  const dirs = new Set<string>([services.defaultDirectory]);
  for (const s of services.sessions.listAll()) dirs.add(s.directory);
  const now = Date.now();
  return [...dirs].map((dir) => ({
    id: dir,
    canonical: dir,
    time: { created: now, updated: now, active: now },
    sandboxes: [],
    vcs: "git",
  }));
}

async function handleV2Bootstrap(
  services: RouteServices,
  res: ServerResponse,
  path: string,
  method: string,
  directory: string,
): Promise<boolean> {
  const withLocation = (data: unknown) => ({ location: { directory }, data });
  if (path === "/api/info" && method === "GET") {
    json(res, 200, {
      version: OPENCODE_COMPAT_VERSION ?? OPENCODE_API_VERSION,
      pid: process.pid,
      urls: [services.url],
      paths: { tmp: tmpdir() },
    });
    return true;
  }
  if (path === "/api/location" && method === "GET") {
    json(res, 200, { directory, project: { id: directory, directory, canonical: directory } });
    return true;
  }
  if (path === "/api/config" && method === "GET") {
    // OpenCode 2.x returns a bare ConfigEntry[]; OpenChamber folds each document's `info` into one config.
    json(res, 200, [{ type: "document", path: "antechamber", info: { default_agent: getAgentName() } }]);
    return true;
  }
  if (path === "/api/provider" && method === "GET") {
    const cat = await services.catalog();
    json(res, 200, withLocation(cat.providers.map((p) => ({ ...p, activation: "enabled" }))));
    return true;
  }
  if (path === "/api/model" && method === "GET") {
    const cat = await services.catalog();
    json(res, 200, withLocation(flattenModels(cat)));
    return true;
  }
  if (path === "/api/model/default" && method === "GET") {
    const cat = await services.catalog();
    json(res, 200, withLocation(defaultV2Model(cat) ?? null));
    return true;
  }
  if (path === "/api/agent" && method === "GET") {
    json(res, 200, withLocation(await v2Agents(services)));
    return true;
  }
  const agentMatch = path.match(/^\/api\/agent\/([^/]+)$/);
  if (agentMatch && method === "GET") {
    const agentId = decodeURIComponent(agentMatch[1]!);
    const agent = (await v2Agents(services)).find((a) => a.id === agentId);
    if (!agent) json(res, 404, errorBody("NotFoundError", `agent not found: ${agentId}`));
    else json(res, 200, withLocation(agent));
    return true;
  }
  if (path === "/api/command" && method === "GET") {
    json(
      res,
      200,
      withLocation(
        (await getCommands(directory)).map((command) => ({
          ...command,
          source: "command",
          hints: [],
          subtask: false,
        })),
      ),
    );
    return true;
  }
  if (path === "/api/skill" && method === "GET") {
    json(res, 200, withLocation([]));
    return true;
  }
  return false;
}

export async function handleV2(
  services: RouteServices,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  path: string,
  method: string,
  directory: string,
): Promise<void> {
  const location = { directory };
  const withLocation = (data: unknown) => ({ location, data });

  // --- bootstrap ---
  if (await handleV2Bootstrap(services, res, path, method, directory)) return;
  if (path === "/api/debug/location" && method === "DELETE") {
    // OpenChamber evicts a location after git worktree changes so OpenCode re-reads it. antechamber
    // keeps no per-location instance (project and VCS reads are fresh per request): nothing to evict.
    res.writeHead(204).end();
    return;
  }

  // --- project / vcs / permission / form (2.0.4 bootstrap) ---
  if (path === "/api/credential" && method === "GET") {
    json(res, 200, withLocation([]));
    return;
  }
  const credentialMatch = path.match(/^\/api\/credential\/([^/]+)(\/activate)?$/);
  if (
    (path === "/api/credential" && method === "POST") ||
    (credentialMatch && method === (credentialMatch[2] ? "POST" : "PATCH"))
  ) {
    await services.body(req);
    json(res, 400, errorBody("UnsupportedError", "Credential management is not available; configure providers in OmO"));
    return;
  }
  if (credentialMatch && !credentialMatch[2] && method === "DELETE") {
    res.writeHead(204).end();
    return;
  }
  const mcp = await mcpRouteV2(services, method, path, directory, () => services.body(req));
  if (mcp !== undefined) {
    if (mcp.status === 204) res.writeHead(204).end();
    else json(res, mcp.status, mcp.body);
    return;
  }
  const integrationMatch = path.match(/^\/api\/integration\/([^/]+)$/);
  if (integrationMatch && method === "GET") {
    json(res, 404, errorBody("NotFoundError", `integration not found: ${decodeURIComponent(integrationMatch[1]!)}`));
    return;
  }
  if (
    (method === "POST" && /^\/api\/integration\/[^/]+\/connect\/(key|external|oauth|command)$/.test(path)) ||
    ((method === "GET" || method === "DELETE") &&
      /^\/api\/integration\/[^/]+\/connect\/(oauth|command)\/[^/]+$/.test(path)) ||
    (method === "POST" && /^\/api\/integration\/[^/]+\/connect\/oauth\/[^/]+\/complete$/.test(path))
  ) {
    json(
      res,
      400,
      errorBody("UnsupportedError", "Integration connections are not available; configure providers in OmO"),
    );
    return;
  }
  if ((path === "/api/plugin" && method === "GET") || (path === "/api/plugin/check" && method === "POST")) {
    if (method === "POST") await services.body(req);
    json(res, 200, withLocation([]));
    return;
  }
  if (path === "/api/plugin/update" && method === "POST") {
    json(res, 400, errorBody("UnsupportedError", "Plugin updates are not available with OmO"));
    return;
  }
  if (path === "/api/experimental/generate" && method === "POST") {
    json(res, 503, {
      _tag: "ServiceUnavailableError",
      message: "No generation model is available through antechamber/OmO",
      service: "opencode",
    });
    return;
  }
  // Read-only inventories OpenChamber loads at bootstrap. OmO has no OpenCode-style shells or
  // web-search providers, so each is an honest empty list (mutations stay 400);
  // OmO monitors appear in the OmO Work status section instead (work-status.ts).
  if ((path === "/api/shell" || path === "/api/websearch/provider") && method === "GET") {
    json(res, 200, withLocation([]));
    return;
  }
  if (path === "/api/experimental/session/stats" && method === "GET") {
    json(res, 400, errorBody("UnsupportedError", "Session statistics are not available with OmO"));
    return;
  }
  if (path === "/api/mcp" || path.startsWith("/api/mcp/") || path.startsWith("/api/experimental/mcp/")) {
    json(res, 400, errorBody("UnsupportedError", "MCP is not available with OmO"));
    return;
  }
  if (path === "/api/fs/find" && method === "GET") {
    const result = await miscRoute("GET", "/find/file", url, directory);
    if (result === undefined) {
      json(res, 500, errorBody("UnknownError", "file search route is unavailable"));
      return;
    }
    if (result.status !== 200) {
      json(res, result.status, result.body);
      return;
    }
    const files = Array.isArray(result.body)
      ? result.body
          .filter((entry): entry is string => typeof entry === "string")
          .map((path) => ({ path, type: "file" }))
      : [];
    json(res, 200, withLocation(files));
    return;
  }
  if (path === "/api/project" && method === "GET") {
    json(res, 200, v2Projects(services));
    return;
  }
  const projectMatch = path.match(/^\/api\/project\/([^/]+)$/);
  if (projectMatch && method === "PATCH") {
    await services.body(req);
    json(res, 400, errorBody("UnsupportedError", "Project updates are not available with OmO"));
    return;
  }
  if (path === "/api/permission/request" && method === "GET") {
    json(
      res,
      200,
      withLocation(
        services.sessions
          .permissions()
          .filter((permission) => services.sessions.get(permission.sessionID)?.info.directory === directory)
          .map((permission) => ({ ...toV2Permission(permission), ...permission })),
      ),
    );
    return;
  }
  if (path === "/api/question/request" && method === "GET") {
    json(res, 200, withLocation(services.sessions.questions()));
    return;
  }
  if (path === "/api/permission/saved" && method === "GET") {
    json(res, 200, { data: [] });
    return;
  }
  if (path.match(/^\/api\/permission\/saved\/[^/]+$/) && method === "DELETE") {
    res.writeHead(204).end();
    return;
  }
  if (path === "/api/form" && method === "GET") {
    json(res, 200, withLocation(services.sessions.questions().map(toQuestionForm)));
    return;
  }
  if (path === "/api/vcs/init" && method === "POST") {
    if (!(await initializeGit(directory))) {
      json(res, 400, errorBody("BadRequestError", "Git initialization failed"));
      return;
    }
    res.writeHead(204).end();
    return;
  }
  if (path === "/api/vcs" && method === "GET") {
    const current = await currentGitBranch(directory);
    json(res, 200, withLocation({ provider: "git", branch: current === undefined ? {} : { current } }));
    return;
  }
  if (method === "GET" && ["/api/vcs/base", "/api/vcs/status", "/api/vcs/branch", "/api/vcs/diff"].includes(path)) {
    try {
      json(res, 200, withLocation(await vcsRead(directory, path.slice("/api/vcs/".length), url)));
    } catch (error) {
      if (!(error instanceof VcsError)) throw error;
      json(res, 400, errorBody(error.name, error.message));
    }
    return;
  }

  // --- sessions ---
  if (path === "/api/session" && method === "GET") {
    const dir = url.searchParams.get("directory") ?? url.searchParams.get("location");
    const search = url.searchParams.get("search");
    const parentID = url.searchParams.get("parentID");
    const order = url.searchParams.get("order") === "asc" ? "asc" : "desc";
    const limit = numberParam(url.searchParams.get("limit"));
    let infos = (dir !== null && dir !== "" ? services.sessions.list(dir) : services.sessions.listAll()).filter(
      // OmO monitors are a child session only for v1 clients; 2.x shows them in the OmO Work section.
      (session) => !services.sessions.monitors.owns(session.id),
    );
    if (search) infos = infos.filter((s) => s.title.toLowerCase().includes(search.toLowerCase()));
    if (parentID !== null) infos = infos.filter((session) => session.parentID === parentID);
    let sessions = infos.map((info) => v2Session(services, info));
    sessions.sort((left, right) => compareSessions(left, right, order));
    const cursor = decodeSessionCursor(url.searchParams.get("cursor"));
    if (cursor !== undefined) sessions = sessions.filter((session) => followsCursor(session, cursor, order));
    const page = limit !== undefined ? sessions.slice(0, limit) : sessions;
    // The 2.0.4 UI reads `cursor.previous` unconditionally — a list body
    // without a cursor throws "Cannot read properties of undefined".
    const next =
      limit !== undefined && page.length < sessions.length && page.at(-1) !== undefined
        ? encodeSessionCursor(page.at(-1)!)
        : null;
    json(res, 200, { data: page, cursor: { previous: null, next } });
    return;
  }
  if (path === "/api/session" && method === "POST") {
    const body = (await services.body(req)) as {
      id?: string;
      agent?: string;
      model?: { providerID?: string; id?: string; modelID?: string; variant?: string };
      metadata?: unknown;
      title?: string;
      parentID?: string;
      location?: { directory?: string };
    };
    for (const field of ["id", "agent", "title", "parentID"] as const) {
      if (body[field] !== undefined && typeof body[field] !== "string")
        throw new RequestBodyError(400, `${field} must be a string`);
    }
    if (
      body.location !== undefined &&
      (typeof body.location !== "object" || body.location === null || Array.isArray(body.location))
    )
      throw new RequestBodyError(400, "location must be an object");
    const dir = sessionDirectory(body.location?.directory ?? directory);
    const metadata = sessionMetadata(body.metadata);
    const model = modelRefFromBody(body.model);
    if (body.model !== undefined && model === undefined)
      throw new RequestBodyError(400, "model requires providerID and id or modelID");
    const info = await services.sessions.create(dir, body.title, body.parentID, {
      ...(body.id !== undefined ? { id: body.id } : {}),
      ...(body.agent !== undefined ? { agent: body.agent } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
    });
    json(res, 200, { data: v2Session(services, info) });
    return;
  }
  if (path === "/api/session/active" && method === "GET") {
    const data: Record<string, { type: "running" }> = {};
    for (const [id, status] of Object.entries(services.sessions.statuses())) {
      if (status.type !== "idle" && !services.sessions.monitors.owns(id)) data[id] = { type: "running" };
    }
    json(res, 200, { data });
    return;
  }

  const sessionMatch = path.match(/^\/api\/session\/([^/]+)(\/.+)?$/);
  if (sessionMatch) {
    const sessionId = decodeURIComponent(sessionMatch[1]!);
    const sub = sessionMatch[2] ?? "";
    const managed = services.sessions.get(sessionId);
    if (!managed) {
      json(res, 404, errorBody("NotFoundError", `session not found: ${sessionId}`));
      return;
    }

    const messageMatch = sub.match(/^\/message\/([^/]+)$/);
    if (messageMatch && method === "GET") {
      const messageId = decodeURIComponent(messageMatch[1]!);
      const found = (services.sessions.messages(sessionId) ?? []).find((m) => m.info.id === messageId);
      if (!found) {
        json(res, 404, errorBody("MessageNotFoundError", `message not found: ${messageId}`));
        return;
      }
      json(res, 200, { data: toV2Message(found) });
      return;
    }

    const formMatch = sub.match(/^\/form\/([^/]+)(\/reply)?$/);
    if (formMatch) {
      const formId = decodeURIComponent(formMatch[1]!);
      const pending = services.sessions.questions(sessionId).find((q) => questionFormID(q.id) === formId);
      if (!pending) {
        json(res, 404, errorBody("FormNotFoundError", `form not found: ${formId}`));
        return;
      }
      if (formMatch[2] === "/reply" && method === "POST") {
        const body = (await services.body(req)) as { answer?: unknown };
        const reply = formQuestionAnswer(pending, body.answer);
        if (!(await services.sessions.replyQuestion(sessionId, pending.id, reply.answers, reply.comment))) {
          json(res, 409, errorBody("FormReplyError", "native question response refused"));
          return;
        }
        res.writeHead(204).end();
        return;
      }
      if (method === "DELETE") {
        if (!(await services.sessions.rejectQuestion(sessionId, pending.id))) {
          json(res, 409, errorBody("FormReplyError", "native question cancellation refused"));
          return;
        }
        res.writeHead(204).end();
        return;
      }
      if (method === "GET") {
        json(res, 200, { data: { ...toQuestionForm(pending), state: { status: "pending" } } });
        return;
      }
    }
    const questionMatch = sub.match(/^\/question\/([^/]+)(\/reply|\/reject)?$/);
    if (questionMatch) {
      const requestId = decodeURIComponent(questionMatch[1]!);
      if (questionMatch[2] === "/reply" && method === "POST") {
        const body = (await services.body(req)) as { answers?: Array<string[]>; comment?: string };
        if (!services.sessions.questions(sessionId).some((q) => q.id === requestId)) {
          json(res, 404, errorBody("QuestionNotFoundError", `question not found: ${requestId}`));
          return;
        }
        if (!(await services.sessions.replyQuestion(sessionId, requestId, body.answers ?? [], body.comment))) {
          json(res, 409, errorBody("QuestionReplyError", "native question response refused"));
          return;
        }
        res.writeHead(204).end();
        return;
      }
      if (questionMatch[2] === "/reject" && method === "POST") {
        if (!services.sessions.questions(sessionId).some((q) => q.id === requestId)) {
          json(res, 404, errorBody("QuestionNotFoundError", `question not found: ${requestId}`));
          return;
        }
        if (!(await services.sessions.rejectQuestion(sessionId, requestId))) {
          json(res, 409, errorBody("QuestionReplyError", "native question cancellation refused"));
          return;
        }
        res.writeHead(204).end();
        return;
      }
      if (method === "GET") {
        const question = services.sessions.questions(sessionId).find((entry) => entry.id === requestId);
        if (question === undefined)
          json(res, 404, errorBody("QuestionNotFoundError", `question not found: ${requestId}`));
        else json(res, 200, { data: question });
        return;
      }
    }
    const permissionMatch = sub.match(/^\/permission\/([^/]+)(\/reply)?$/);
    if (permissionMatch) {
      const requestId = decodeURIComponent(permissionMatch[1]!);
      if (permissionMatch[2] === "/reply" && method === "POST") {
        const body = (await services.body(req)) as {
          decision?: "once" | "always" | "reject";
          reply?: "once" | "always" | "reject";
          message?: string;
        };
        const decision = body.decision ?? body.reply;
        if (!decision || !services.sessions.replyPermission(sessionId, requestId, decision, body.message)) {
          json(res, 404, errorBody("PermissionNotFoundError", `permission not found: ${requestId}`));
          return;
        }
        res.writeHead(204).end();
        return;
      }
      if (method === "GET") {
        const permission = services.sessions.permissions(sessionId).find((entry) => entry.id === requestId);
        if (permission === undefined)
          json(res, 404, errorBody("PermissionNotFoundError", `permission not found: ${requestId}`));
        else json(res, 200, { data: toV2Permission(permission) });
        return;
      }
    }

    switch (`${method} ${sub}`) {
      case "POST /generate":
      case "POST /background":
      case "POST /move":
        json(res, 400, errorBody("UnsupportedError", `Session ${sub.slice(1)} is not available with OmO`));
        return;
      case "GET /todo":
        json(res, 200, { data: services.sessions.todos(sessionId) });
        return;
      case "GET ": {
        json(res, 200, { data: v2Session(services, managed.info) });
        return;
      }
      case "PATCH ": {
        const body = (await services.body(req)) as {
          title?: string;
          archived?: unknown;
          time?: { archived?: number };
          metadata?: unknown;
        };
        // OpenCode 2.1 takes `archived: boolean` (repeating the current state is a no-op);
        // older clients send `time.archived` as a timestamp, 0 to unarchive.
        const archived =
          typeof body.archived === "boolean"
            ? body.archived
              ? (managed.info.time.archived ?? Date.now())
              : 0
            : body.time?.archived;
        await services.sessions.update(sessionId, {
          title: body.title,
          archived,
          metadata: sessionMetadata(body.metadata),
        });
        res.writeHead(204).end();
        return;
      }
      case "DELETE ": {
        await services.sessions.remove(sessionId);
        res.writeHead(204).end();
        return;
      }
      case "GET /message": {
        const order = url.searchParams.get("order");
        const limit = numberParam(url.searchParams.get("limit"));
        let messages = (services.sessions.messages(sessionId) ?? []).map((m) => toV2Message(m));
        if (order !== "asc") messages = messages.reverse(); // v2 default is newest-first
        const cursor = url.searchParams.get("cursor");
        if (cursor !== null) {
          const boundary = messages.findIndex((message) => message.id === cursor);
          if (boundary >= 0) messages = messages.slice(boundary + 1);
        }
        const page = limit === undefined ? messages : messages.slice(0, limit);
        const last = page.at(-1);
        json(res, 200, {
          data: page,
          cursor: { previous: null, next: last && page.length < messages.length ? last.id : null },
        });
        return;
      }
      case "POST /compact":
      case "POST /summarize": {
        await services.body(req);
        const result = await compactSession(services.sessions, sessionId);
        if (result.kind === "error") {
          announceSessionError(
            { sessions: services.sessions, session: managed, emit: services.broadcast },
            "BadRequestError",
            result.message,
          );
          json(res, 400, errorBody("BadRequestError", result.message));
          return;
        }
        json(res, 200, { data: true });
        return;
      }
      case "POST /shell": {
        const result = await runSessionShell(services, managed, await services.body(req));
        if (result.kind === "input") {
          json(res, 400, errorBody("BadRequestError", "command is required"));
          return;
        }
        if (result.kind === "busy") {
          json(res, 409, errorBody("SessionBusyError", "session is busy"));
          return;
        }
        if (result.kind === "error") {
          json(res, 400, errorBody("BadRequestError", result.message));
          return;
        }
        res.writeHead(204).end();
        return;
      }
      case "POST /command": {
        const body = (await services.body(req)) as { name?: string; text?: string; id?: string };
        const result = await runSessionSlash(services, sessionId, {
          command: body.name,
          arguments: body.text ?? "",
          messageID: body.id,
        });
        if (result.kind === "input") {
          json(res, 400, errorBody("BadRequestError", "command is required"));
          return;
        }
        res.writeHead(204).end();
        return;
      }
      case "POST /share":
      case "DELETE /share":
        announceSessionError(
          { sessions: services.sessions, session: managed, emit: services.broadcast },
          unsupportedShare.name,
          unsupportedShare.data.message,
        );
        json(res, 400, errorBody(unsupportedShare.name, unsupportedShare.data.message));
        return;
      case "POST /prompt": {
        const body = (await services.body(req)) as {
          id?: string;
          text?: unknown;
          parts?: unknown;
          files?: unknown;
          agents?: unknown;
          skills?: unknown;
          metadata?: unknown;
          model?: { providerID?: string; id?: string; modelID?: string; variant?: string };
          variant?: string;
          delivery?: string;
        };
        if (typeof body.text !== "string") {
          json(res, 400, { _tag: "InvalidRequestError", message: "text must be a string" });
          return;
        }
        const explicit = parsePromptParts(body.parts);
        const text = body.text;
        const parts =
          explicit.length > 0
            ? [...explicit, ...v2PromptParts("", body.files, body.agents)]
            : v2PromptParts(text, body.files, body.agents);
        if (text.trim() === "" && !parts.some((part) => part.type === "file" || part.type === "agent")) {
          json(res, 400, {
            _tag: "InvalidRequestError",
            message: "prompt requires non-whitespace text, files, or agents",
          });
          return;
        }
        const metadata = sessionMetadata(body.metadata);
        if (body.skills !== undefined) {
          if (!Array.isArray(body.skills)) throw new RequestBodyError(400, "skills must be an array");
          const skill: unknown = body.skills[0];
          if (skill !== undefined) {
            if (typeof skill !== "object" || skill === null || !("id" in skill) || typeof skill.id !== "string")
              throw new RequestBodyError(400, "skills must contain {id} references");
            // GET /api/skill lists none, so any reference is unknown. OpenChamber retries without
            // the attachment on exactly this tagged OpenCode error.
            json(res, 400, { _tag: "InvalidRequestError", message: `Skill not found: ${skill.id}` });
            return;
          }
        }
        // Reject an attachment the native RPC cannot carry before acknowledging the prompt.
        nativePromptInput(text, parts);
        const messageID =
          typeof body.id === "string" && body.id !== "" ? body.id : `msg_${randomUUID().replaceAll("-", "")}`;
        const model = modelRefFromBody(
          body.model ?? (body.variant !== undefined ? managed.model : undefined),
          body.variant,
        );
        if (body.delivery !== undefined && body.delivery !== "steer" && body.delivery !== "queue") {
          json(res, 400, errorBody("BadRequestError", 'delivery must be "steer" or "queue"'));
          return;
        }
        const delivery = body.delivery ?? "steer";
        promptAsync(
          services,
          managed,
          text,
          model,
          false,
          messageID,
          delivery,
          parts.length > 0 ? parts : undefined,
          metadata,
        );
        json(res, 200, {
          data: {
            id: messageID,
            sessionID: sessionId,
            time: { created: Date.now() },
            type: "user",
            text,
            payload: { text, ...v2PromptAttachments(parts) },
            delivery,
            ...(metadata !== undefined ? { metadata } : {}),
          },
        });
        return;
      }
      case "POST /synthetic":
      case "POST /context": {
        const body = (await services.body(req)) as {
          id?: string;
          text?: unknown;
          metadata?: unknown;
          delivery?: string;
        };
        if (typeof body.text !== "string" || body.text.trim() === "") {
          json(res, 400, { _tag: "InvalidRequestError", message: "text must be a non-whitespace string" });
          return;
        }
        if (body.delivery !== undefined && body.delivery !== "steer" && body.delivery !== "queue") {
          json(res, 400, errorBody("BadRequestError", 'delivery must be "steer" or "queue"'));
          return;
        }
        const metadata = sessionMetadata(body.metadata);
        const messageID =
          typeof body.id === "string" && body.id !== "" ? body.id : `msg_${randomUUID().replaceAll("-", "")}`;
        const text = body.text;
        promptAsync(services, managed, text, undefined, true, messageID, body.delivery ?? "steer", undefined, metadata);
        // OpenChamber 2.3.2 treats anything but 200 + the admitted record as a failed send (captured OpenCode shape).
        json(res, 200, {
          data: {
            id: messageID,
            sessionID: sessionId,
            time: { created: Date.now() },
            type: "synthetic",
            payload: { text },
          },
        });
        return;
      }
      case "POST /interrupt": {
        const interrupted = await services.sessions.abort(sessionId);
        // Bare body, as captured from OpenCode 2.x: OpenChamber reads `result.interrupted` directly.
        json(res, 200, { interrupted });
        return;
      }
      case "POST /fork":
      case "POST /revert":
      case "POST /revert/stage":
      case "POST /revert/commit":
      case "DELETE /revert": {
        const body = method === "DELETE" ? {} : await services.body(req);
        const target =
          typeof body === "object" && body !== null
            ? "before" in body
              ? body.before
              : "messageID" in body
                ? body.messageID
                : undefined
            : undefined;
        if (
          (sub === "/revert" || sub === "/revert/stage") &&
          method === "POST" &&
          (typeof target !== "string" || target === "")
        ) {
          json(res, 400, errorBody("InvalidRequestError", "messageID is required"));
          return;
        }
        try {
          if (sub === "/fork") {
            if (target !== undefined && (typeof target !== "string" || target === ""))
              throw new Error("before must be a nonempty message id");
            const info = await services.sessions.fork(sessionId, typeof target === "string" ? target : undefined);
            json(res, 200, { data: v2Session(services, info) });
          } else if (method === "DELETE") {
            await services.sessions.unrevert(sessionId);
            res.writeHead(204).end();
          } else if (sub === "/revert/commit") {
            await services.sessions.commitRevert(sessionId);
            res.writeHead(204).end();
          } else {
            const info = await services.sessions.revert(sessionId, String(target));
            json(res, 200, { data: info.revert });
          }
        } catch (error) {
          json(res, 400, errorBody("SessionTreeError", error instanceof Error ? error.message : String(error)));
        }
        return;
      }
      case "POST /agent": {
        const body = (await services.body(req)) as { agent?: unknown };
        if (typeof body.agent !== "string") {
          json(res, 400, errorBody("InvalidRequestError", "agent must be a string"));
          return;
        }
        await services.sessions.update(sessionId, { agent: body.agent });
        res.writeHead(204).end();
        return;
      }
      case "POST /model": {
        // The UI awaits this before every prompt (applySendSelection →
        // switchModel), so it is the only route from the bottom-right picker
        // to pi. Dropping the body used to leave the UI showing a model pi
        // never ran. 204 empty is the contract; 400/404 are the statuses the
        // client declares, and a loud failure beats a silent drift.
        const body = (await services.body(req)) as {
          model?: { providerID?: string; id?: string; modelID?: string; variant?: string };
          variant?: string;
        };
        const ref = modelRefFromBody(body.model, body.variant);
        if (ref === undefined) {
          json(res, 400, errorBody("BadRequestError", "model is required: {providerID, modelID}"));
          return;
        }
        try {
          const resolved = await services.sessions.setModel(sessionId, ref);
          if (resolved.modelID !== ref.modelID || resolved.providerID !== ref.providerID) {
            // pi resolved the request to a different concrete model (alias or
            // provider-reported id). Not an error, but the reason the UI ends
            // up showing something other than what was picked.
            debugLog(
              `[model] session ${sessionId}: pi resolved ${ref.providerID}/${ref.modelID} -> ${resolved.providerID}/${resolved.modelID}`,
            );
          }
          res.writeHead(204).end();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[model] session ${sessionId} → ${ref.providerID}/${ref.modelID} failed:`, message);
          json(
            res,
            message.startsWith("unknown session:") ? 404 : 400,
            errorBody(message.startsWith("unknown session:") ? "NotFoundError" : "BadRequestError", message),
          );
        }
        return;
      }
      case "GET /form": {
        json(res, 200, { data: services.sessions.questions(sessionId).map(toQuestionForm) });
        return;
      }
      case "GET /question": {
        json(res, 200, { data: services.sessions.questions(sessionId) });
        return;
      }
      case "GET /permission": {
        json(res, 200, { data: services.sessions.permissions(sessionId).map(toV2Permission) });
        return;
      }
      case "GET /inbox": {
        json(res, 200, { data: [] });
        return;
      }
      case "GET /diff":
        json(res, 200, {
          data: await services.sessions.diff(sessionId, {
            from: url.searchParams.get("from") ?? undefined,
            to: url.searchParams.get("to") ?? undefined,
            context: numberParam(url.searchParams.get("context")),
          }),
        });
        return;
      case "GET /context": {
        json(res, 501, errorBody("NotImplemented", `${method} ${path} is not implemented by this connector`));
        return;
      }
      default:
        json(res, 501, errorBody("NotImplemented", `${method} ${path} not implemented`));
        return;
    }
  }

  json(res, 404, errorBody("NotFoundError", `no route: ${method} ${path}`));
}
