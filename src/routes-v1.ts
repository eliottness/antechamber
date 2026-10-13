/** OpenCode v1 routes, using the services composed by AdapterServer. */

import type { IncomingMessage, ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { errorBody, json } from "./http.js";
import { miscRoute } from "./misc-routes.js";
import { getAgentName, getExposedAgentNames } from "./agent-name.js";
import { agentDefaults } from "./catalog.js";
import {
  announceSessionError,
  compactSession,
  getCommands,
  parseShellCommand,
  parseSlashCommand,
  runShellCommand,
  runSlashCommand,
  unsupportedShare,
} from "./session-commands.js";
import type { OCPromptBody, OCSession } from "./types.js";
import { modelRefFromBody, OPENCODE_COMPAT_VERSION, promptAsync, type RouteServices } from "./route-services.js";

/**
 * `archived` list filter per SDK v2 (`boolean | "true" | "false"`):
 * "true" keeps only archived sessions, "false" only live ones, absent = all.
 */
function applyArchivedFilter(sessions: OCSession[], archived: string | null) {
  if (archived === "true") return sessions.filter((s) => s.time.archived !== undefined);
  if (archived === "false") return sessions.filter((s) => s.time.archived === undefined);
  return sessions;
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
  if (method === "GET" && path === "/global/health") {
    json(
      res,
      200,
      OPENCODE_COMPAT_VERSION === null ? { healthy: true } : { healthy: true, version: OPENCODE_COMPAT_VERSION },
    );
    return;
  }

  // There is no opencode install behind this endpoint to upgrade: the adapter
  // speaks the OpenCode API itself. Answer instead of 404 so a direct upgrade
  // call gets a clear reason rather than a bare HTTP status.
  if ((method === "POST" || method === "GET") && path === "/global/upgrade") {
    json(
      res,
      409,
      errorBody(
        "UnsupportedError",
        "This endpoint is served by antechamber (a pi adapter), not a real opencode install — there is nothing to upgrade.",
      ),
    );
    return;
  }

  // --- sessions ---
  const misc = await miscRoute(method, path, url, directory);
  if (misc !== undefined) {
    json(res, misc.status, misc.body);
    return;
  }
  if (path === "/session" && method === "POST") {
    const body = (await services.body(req)) as { parentID?: string; title?: string };
    json(res, 200, await services.sessions.create(directory, body.title, body.parentID));
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
    switch (`${method} ${sub ?? ""}`) {
      case "GET /diff":
        json(res, 200, await services.sessions.diff(sessionId!));
        return;
      case "GET ":
        json(res, 200, managed.info);
        return;
      case "PATCH ": {
        const body = (await services.body(req)) as { title?: string; time?: { archived?: number } };
        json(res, 200, services.sessions.update(sessionId, { title: body.title, archived: body.time?.archived }));
        return;
      }
      case "DELETE ":
        json(res, 200, await services.sessions.remove(sessionId));
        return;
      case "GET /message":
        json(res, 200, services.sessions.messages(sessionId));
        return;
      case "GET /todo":
        json(res, 200, services.sessions.todos(sessionId!));
        return;
      case "POST /prompt_async": {
        const body = (await services.body(req)) as OCPromptBody & { variant?: string };
        const text = (body.parts ?? [])
          .filter((p) => p.type === "text" && typeof p.text === "string")
          .map((p) => p.text ?? "")
          .join("\n");
        const model = modelRefFromBody(
          body.model ?? (body.variant !== undefined ? managed.model : undefined),
          body.variant,
        );
        promptAsync(services, managed, text, model, body.noReply, body.messageID);
        res.writeHead(204).end();
        return;
      }
      case "POST /message": {
        const body = (await services.body(req)) as OCPromptBody & { variant?: string };
        const text = (body.parts ?? [])
          .filter((p) => p.type === "text" && typeof p.text === "string")
          .map((p) => p.text ?? "")
          .join("\n");
        const model = modelRefFromBody(
          body.model ?? (body.variant !== undefined ? managed.model : undefined),
          body.variant,
        );
        await services.sessions.prompt(sessionId, text, model, body.noReply, body.messageID);
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
        const command = parseShellCommand(await services.body(req));
        if (command === undefined) {
          json(res, 400, errorBody("BadRequestError", "command is required"));
          return;
        }
        const managed = services.sessions.get(sessionId);
        if (!managed) {
          json(res, 404, errorBody("NotFoundError", `session not found: ${sessionId}`));
          return;
        }
        if (managed.status.type !== "idle") {
          json(res, 409, errorBody("SessionBusyError", "session is busy"));
          return;
        }
        const result = await runShellCommand({
          sessions: services.sessions,
          session: managed,
          command,
          emit: services.broadcast,
        });
        if (result.kind === "error") {
          json(res, 400, errorBody("BadRequestError", result.message));
          return;
        }
        json(res, 200, result.message.info);
        return;
      }
      case "POST /command": {
        const input = parseSlashCommand(await services.body(req));
        if (input === undefined) {
          json(res, 400, errorBody("BadRequestError", "command is required"));
          return;
        }
        const message = await runSlashCommand(services.sessions, sessionId, input);
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
    json(res, 200, { id: directory, worktree: directory, time: { created: Date.now() } });
    return;
  }
  if (path === "/project" && method === "GET") {
    json(res, 200, [{ id: directory, worktree: directory, time: { created: Date.now() } }]);
    return;
  }
  if ((path === "/config" || path === "/global/config") && method === "GET") {
    json(res, 200, { default_agent: getAgentName() });
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
    json(res, 200, sessions);
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
  if (path === "/mcp" && method === "GET") {
    json(res, 200, {});
    return;
  }
  if (path === "/command" && method === "GET") {
    json(res, 200, await getCommands(directory));
    return;
  }
  if (path === "/path" && method === "GET") {
    json(res, 200, { home: homedir(), state: "", config: "", worktree: directory, directory });
    return;
  }
  if (path === "/vcs" && method === "GET") {
    execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: directory, timeout: 3000 }, (err, stdout) => {
      const branch = err ? undefined : stdout.trim() || undefined;
      json(res, 200, branch === undefined ? {} : { branch });
    });
    return;
  }
  if (path === "/agent" && method === "GET") {
    // pi has one agent; publish OpenChamber's conventional `build` primary
    // agent next to pi's own name so the picker — and its default resolution,
    // which looks for `build` — has a real option. Both names run the same
    // pi agent (see getExposedAgentNames).
    const piName = getAgentName();
    const defaults = agentDefaults(await services.catalog());
    json(
      res,
      200,
      getExposedAgentNames().map((name) => ({
        name,
        description:
          name === piName
            ? `${piName} (pi coding agent via antechamber)`
            : `${name} — ${piName} (pi coding agent via antechamber)`,
        mode: "primary",
        hidden: name === "build" && piName !== "build",
        options: {},
        ...defaults,
      })),
    );
    return;
  }

  json(res, 404, errorBody("NotFoundError", `no route: ${method} ${path}`));
}
