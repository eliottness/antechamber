/** OpenCode v1 routes, using the services composed by AdapterServer. */

import type { IncomingMessage, ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { errorBody, json } from "./http.js";
import { miscRoute } from "./misc-routes.js";
import { mcpRoute } from "./mcp.js";
import { getAgentName } from "./agent-name.js";
import { nativePromptInput, parsePromptParts } from "./prompt-parts.js";
import { RequestBodyError } from "./http.js";
import { SelfUpdateUnsupportedError } from "./self-update.js";
import { announceSessionError, compactSession, getCommands, unsupportedShare } from "./session-commands.js";
import type { ModelSelection } from "./thinking-levels.js";
import type { OCPromptBody, OCProject, OCSession } from "./types.js";
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

/**
 * `archived` list filter per SDK v2 (`boolean | "true" | "false"`):
 * "true" keeps only archived sessions, "false" only live ones, absent = all.
 */
function applyArchivedFilter(sessions: OCSession[], archived: string | null) {
  if (archived === "true") return sessions.filter((s) => s.time.archived !== undefined);
  if (archived === "false") return sessions.filter((s) => s.time.archived === undefined);
  return sessions;
}

async function handleV1GlobalRoute(
  services: RouteServices,
  res: ServerResponse,
  path: string,
  method: string,
): Promise<boolean> {
  if (method === "GET" && path === "/global/health") {
    json(
      res,
      200,
      OPENCODE_COMPAT_VERSION === null ? { healthy: true } : { healthy: true, version: OPENCODE_COMPAT_VERSION },
    );
    return true;
  }
  if (method === "POST" && path === "/global/upgrade") {
    // The requested OpenCode `target` does not apply: this upgrades antechamber itself.
    try {
      const result = await services.selfUpdate();
      json(res, 200, { success: true, version: result.to, updated: result.updated });
    } catch (error) {
      if (!(error instanceof SelfUpdateUnsupportedError)) throw error;
      json(res, 409, errorBody("UnsupportedError", error.message));
    }
    return true;
  }
  if (method === "GET" && path === "/global/upgrade") {
    json(res, 409, errorBody("UnsupportedError", "Upgrade antechamber with POST /global/upgrade."));
    return true;
  }
  return false;
}

function parseV1Prompt(body: OCPromptBody & { variant?: string }, defaultModel?: ModelSelection) {
  if (!Array.isArray(body.parts)) throw new RequestBodyError(400, "parts must be an array");
  const parts = parsePromptParts(body.parts);
  if (body.delivery !== undefined && body.delivery !== "steer" && body.delivery !== "queue")
    throw new RequestBodyError(400, "delivery must be steer or queue");
  const text = parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
  const model = modelRefFromBody(body.model ?? (body.variant !== undefined ? defaultModel : undefined), body.variant);
  const native = nativePromptInput(text, parts);
  if (native.message.trim() === "" && !native.images?.length)
    throw new RequestBodyError(400, "prompt requires non-whitespace text, file content, or an agent mention");
  return { text, model, parts, delivery: body.delivery ?? "steer" };
}

export async function handleV1(
  services: RouteServices,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  path: string,
  method: string,
  directory: string,
): Promise<void> {
  if (await handleV1GlobalRoute(services, res, path, method)) return;

  const mcp = await mcpRoute(services, method, path, directory, () => services.body(req));
  if (mcp !== undefined) {
    json(res, mcp.status, mcp.body);
    return;
  }

  // --- sessions ---
  const misc = await miscRoute(method, path, url, directory);
  if (misc !== undefined) {
    json(res, misc.status, misc.body);
    return;
  }
  if (path === "/session" && method === "POST") {
    const body = (await services.body(req)) as { parentID?: string; title?: string; metadata?: unknown };
    const metadata = sessionMetadata(body.metadata);
    json(
      res,
      200,
      await services.sessions.create(
        sessionDirectory(directory),
        body.title,
        body.parentID,
        metadata === undefined ? {} : { metadata },
      ),
    );
    return;
  }
  if (path === "/session" && method === "GET") {
    const dir = url.searchParams.get("directory") ?? undefined;
    let sessions = services.sessions.list(dir);
    sessions = applyArchivedFilter(sessions, url.searchParams.get("archived"));
    json(res, 200, sessions);
    return;
  }
  if (path === "/session/status" && method === "GET") {
    json(res, 200, services.sessions.statuses());
    return;
  }

  const sessionMatch = path.match(/^\/session\/([^/]+)(\/.*)?$/);
  if (sessionMatch) {
    const [, sessionId, sub] = sessionMatch;
    if (sessionId === undefined) {
      json(res, 404, errorBody("NotFoundError", `session not found: ${sessionId}`));
      return;
    }
    const managed = services.sessions.get(sessionId);
    if (!managed) {
      json(res, 404, errorBody("NotFoundError", `session not found: ${sessionId}`));
      return;
    }
    const messageMatch = sub?.match(/^\/message\/([^/]+)$/);
    if (messageMatch && method === "GET") {
      const messageID = decodeURIComponent(messageMatch[1]!);
      const message = (services.sessions.messages(sessionId!) ?? []).find(
        (candidate) => candidate.info.id === messageID,
      );
      if (message === undefined) json(res, 404, errorBody("NotFoundError", `message not found: ${messageID}`));
      else json(res, 200, message);
      return;
    }
    switch (`${method} ${sub ?? ""}`) {
      case "GET /diff":
        json(res, 200, await services.sessions.diff(sessionId!));
        return;
      case "GET ":
        json(res, 200, { ...managed.info, cost: managed.info.cost ?? 0 });
        return;
      case "PATCH ": {
        const body = (await services.body(req)) as { title?: string; time?: { archived?: number }; metadata?: unknown };
        json(
          res,
          200,
          await services.sessions.update(sessionId, {
            title: body.title,
            archived: body.time?.archived,
            metadata: sessionMetadata(body.metadata),
          }),
        );
        return;
      }
      case "DELETE ":
        json(res, 200, await services.sessions.remove(sessionId));
        return;
      case "GET /message": {
        // OpenCode pages backwards from the newest message: `before` is the
        // x-next-cursor of the previous page (here, its oldest message ID).
        // Without the cursor, OpenChamber's loader treats a partial page as the
        // whole history; mobile's 30-message first page then has no user
        // message to anchor a turn on, and the transcript renders blank.
        const messages = services.sessions.messages(sessionId) ?? [];
        const limit = numberParam(url.searchParams.get("limit"));
        const before = url.searchParams.get("before");
        const end = before === null ? messages.length : messages.findIndex((message) => message.info.id === before);
        if (end < 0 || limit === 0) {
          json(res, 200, []);
          return;
        }
        let start = limit === undefined ? 0 : Math.max(0, end - limit);
        // OpenChamber 1.24 widens a page with no user message only up to 120 messages
        // (150 on desktop), then renders it with no turn to anchor on: blank. A long agent
        // turn outgrows that, so a page reaches back to the prompt that opened its turn.
        if (!messages.slice(start, end).some((message) => message.info.role === "user")) {
          const prompt = messages.findLastIndex((message, index) => index < start && message.info.role === "user");
          if (prompt >= 0) start = prompt;
        }
        const page = messages.slice(start, end);
        if (start > 0 && page[0] !== undefined) res.setHeader("x-next-cursor", page[0].info.id);
        json(res, 200, page);
        return;
      }
      case "GET /children":
        json(
          res,
          200,
          services.sessions.list(directory).filter((candidate) => candidate.parentID === sessionId),
        );
        return;
      case "GET /todo":
        json(res, 200, services.sessions.todos(sessionId!));
        return;
      case "POST /prompt_async": {
        const body = (await services.body(req)) as OCPromptBody & { variant?: string };
        const { text, model, parts, delivery } = parseV1Prompt(body, managed.model);
        promptAsync(services, managed, text, model, body.noReply, body.messageID, delivery, parts);
        res.writeHead(204).end();
        return;
      }
      case "POST /message": {
        const body = (await services.body(req)) as OCPromptBody & { variant?: string };
        const { text, model, parts, delivery } = parseV1Prompt(body, managed.model);
        await services.sessions.prompt(sessionId, text, model, body.noReply, body.messageID, delivery, parts);
        const msgs = services.sessions.messages(sessionId) ?? [];
        json(res, 200, msgs[msgs.length - 1] ?? null);
        return;
      }
      case "POST /abort":
        json(res, 200, await services.sessions.abort(sessionId));
        return;
      case "POST /fork":
      case "POST /revert":
      case "POST /unrevert": {
        const body = await services.body(req);
        const messageID = body !== null && typeof body === "object" && "messageID" in body ? body.messageID : undefined;
        if (
          (sub === "/revert" && (typeof messageID !== "string" || messageID === "")) ||
          (sub === "/fork" && messageID !== undefined && (typeof messageID !== "string" || messageID === ""))
        ) {
          json(res, 400, errorBody("InvalidRequest", "messageID must be a nonempty string"));
          return;
        }
        try {
          const info =
            sub === "/fork"
              ? await services.sessions.fork(sessionId!, typeof messageID === "string" ? messageID : undefined)
              : sub === "/revert"
                ? await services.sessions.revert(sessionId!, String(messageID))
                : await services.sessions.unrevert(sessionId!);
          json(res, 200, info);
        } catch (error) {
          json(res, 400, errorBody("SessionTreeError", error instanceof Error ? error.message : String(error)));
        }
        return;
      }
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
        json(res, 200, true);
        return;
      }
      case "POST /shell": {
        const managed = services.sessions.get(sessionId);
        if (!managed) {
          json(res, 404, errorBody("NotFoundError", `session not found: ${sessionId}`));
          return;
        }
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
        json(res, 200, result.message);
        return;
      }
      case "POST /command": {
        const result = await runSessionSlash(services, sessionId, await services.body(req));
        if (result.kind === "input") {
          json(res, 400, errorBody("BadRequestError", "command is required"));
          return;
        }
        const { message } = result;
        json(
          res,
          200,
          message === undefined ? { info: null, parts: [] } : { info: message.info, parts: message.parts },
        );
        return;
      }
      case "POST /share":
      case "DELETE /share": {
        const session = services.sessions.get(sessionId);
        if (session)
          announceSessionError(
            { sessions: services.sessions, session, emit: services.broadcast },
            unsupportedShare.name,
            unsupportedShare.data.message,
          );
        json(res, 400, errorBody(unsupportedShare.name, unsupportedShare.data.message));
        return;
      }
      default:
        json(res, 501, errorBody("NotImplemented", `${method} ${path} not implemented (M1)`));
        return;
    }
  }

  // --- project / config ---
  if (path === "/project/current" && method === "GET") {
    json(res, 200, {
      id: directory,
      worktree: directory,
      vcs: "git",
      time: { created: Date.now(), updated: Date.now() },
      sandboxes: [],
    } satisfies OCProject);
    return;
  }
  if (path === "/project" && method === "GET") {
    json(res, 200, [
      {
        id: directory,
        worktree: directory,
        vcs: "git",
        time: { created: Date.now(), updated: Date.now() },
        sandboxes: [],
      } satisfies OCProject,
    ]);
    return;
  }
  if ((path === "/config" || path === "/global/config") && method === "GET") {
    const cat = await services.catalog();
    json(res, 200, {
      $schema: "https://opencode.ai/config.json",
      default_agent: getAgentName(),
      plugin: [],
      command: {},
      mode: {},
      agent: {},
      username: process.env.OPENCODE_SERVER_USERNAME ?? "opencode",
      ...(cat.default ? { model: `${cat.default.providerID}/${cat.default.modelID}` } : {}),
    });
    return;
  }

  // --- model catalog (from pi) ---
  if (path === "/provider" && method === "GET") {
    const cat = await services.catalog();
    json(res, 200, { all: cat.providers, default: cat.defaults, connected: cat.providers.map((p) => p.id) });
    return;
  }
  if (path === "/config/providers" && method === "GET") {
    const cat = await services.catalog();
    json(res, 200, { providers: cat.providers, default: cat.defaults });
    return;
  }

  // --- bootstrap probes OpenChamber expects to exist ---
  if (path === "/experimental/session" && method === "GET") {
    // OpenChamber page-loads the sidebar through this route (not /session) with
    // ?directory=…&archived=…&roots=…&limit=…. Honor directory/roots/archived:
    // ignoring them left the sidebar with only live sessions, so restored
    // history never appeared after a restart. archived=false excludes archived
    // sessions; archived=true includes them so the UI can partition both lists.
    const directoryParam =
      url.searchParams.get("directory") ?? (req.headers["x-opencode-directory"] as string | undefined);
    const rootsOnly = url.searchParams.get("roots") === "true";
    let sessions =
      directoryParam !== undefined && directoryParam !== ""
        ? services.sessions.list(directoryParam)
        : services.sessions.listAll();
    if (rootsOnly) sessions = sessions.filter((s) => s.parentID === undefined);
    // Experimental lists use archived=true to INCLUDE archived sessions.
    // The UI partitions this result itself; filtering to archived-only drops
    // the current live session from the header's global metadata store.
    if (url.searchParams.get("archived") === "false") {
      sessions = sessions.filter((s) => s.time.archived === undefined);
    }
    sessions.sort((a, b) => b.time.updated - a.time.updated || a.id.localeCompare(b.id));
    const cursor = numberParam(url.searchParams.get("cursor"));
    if (cursor !== undefined) sessions = sessions.filter((session) => session.time.updated < cursor);
    const limit = numberParam(url.searchParams.get("limit"));
    const page = limit === undefined ? sessions : sessions.slice(0, limit);
    if (limit !== undefined && page.length < sessions.length && page.at(-1)?.time.updated !== undefined)
      res.setHeader("x-next-cursor", String(page.at(-1)!.time.updated));
    json(res, 200, page);
    return;
  }
  if (path === "/question" && method === "GET") {
    json(res, 200, services.sessions.questions());
    return;
  }
  if (path === "/permission" && method === "GET") {
    json(res, 200, services.sessions.permissions());
    return;
  }
  const questionReply = path.match(/^\/question\/([^/]+)\/reply$/);
  if (questionReply && method === "POST") {
    const requestID = decodeURIComponent(questionReply[1]!);
    const body = (await services.body(req)) as { answers?: Array<string[]>; comment?: string };
    const pending = services.sessions.questions().find((question) => question.id === requestID);
    if (!pending) {
      json(res, 404, errorBody("QuestionNotFoundError", `question not found: ${requestID}`));
      return;
    }
    if (!(await services.sessions.replyQuestion(pending.sessionID, requestID, body.answers ?? [], body.comment))) {
      json(res, 409, errorBody("QuestionReplyError", "native question response refused"));
      return;
    }
    json(res, 200, true);
    return;
  }
  const questionReject = path.match(/^\/question\/([^/]+)\/reject$/);
  if (questionReject && method === "POST") {
    const requestID = decodeURIComponent(questionReject[1]!);
    const pending = services.sessions.questions().find((question) => question.id === requestID);
    if (!pending) {
      json(res, 404, errorBody("QuestionNotFoundError", `question not found: ${requestID}`));
      return;
    }
    if (!(await services.sessions.rejectQuestion(pending.sessionID, requestID))) {
      json(res, 409, errorBody("QuestionReplyError", "native question cancellation refused"));
      return;
    }
    json(res, 200, true);
    return;
  }
  const permissionReply = path.match(/^\/permission\/([^/]+)\/reply$/);
  if (permissionReply && method === "POST") {
    const requestID = decodeURIComponent(permissionReply[1]!);
    const body = (await services.body(req)) as { reply?: "once" | "always" | "reject"; message?: string };
    const pending = services.sessions.permissions().find((permission) => permission.id === requestID);
    if (
      !pending ||
      !body.reply ||
      !services.sessions.replyPermission(pending.sessionID, requestID, body.reply, body.message)
    ) {
      json(res, 404, errorBody("PermissionNotFoundError", `permission not found: ${requestID}`));
      return;
    }
    json(res, 200, true);
    return;
  }
  if (path === "/lsp" && method === "GET") {
    json(res, 200, []);
    return;
  }
  if (path === "/formatter" && method === "GET") {
    json(res, 200, []);
    return;
  }
  if (path === "/command" && method === "GET") {
    json(
      res,
      200,
      (await getCommands(directory)).map((command) => ({
        ...command,
        source: "command",
        hints: [],
        subtask: false,
      })),
    );
    return;
  }
  if (path === "/path" && method === "GET") {
    json(res, 200, { home: homedir(), state: "", config: "", worktree: directory, directory });
    return;
  }
  if (path === "/vcs" && method === "GET") {
    execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: directory, timeout: 3000 }, (err, stdout) => {
      const branch = err ? undefined : stdout.trim() || undefined;
      json(res, 200, { branch: branch ?? null, default_branch: null });
    });
    return;
  }
  if (path === "/agent" && method === "GET") {
    json(res, 200, await agentDescriptors(services));
    return;
  }

  json(res, 404, errorBody("NotFoundError", `no route: ${method} ${path}`));
}
