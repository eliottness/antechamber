/** OpenCode v2 (/api/*) routes and their response adapters. */

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { errorBody, json } from "./http.js";
import { debugLog } from "./misc-routes.js";
import { OPENCODE_API_VERSION } from "./version.js";
import { toV2Permission } from "./approvals.js";
import { formQuestionAnswer, questionFormID, toQuestionForm } from "./question-forms.js";
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
import { defaultV2Model, flattenModels, toV2Message, toV2Session, type V2Session } from "./v2.js";
import type { OCSession } from "./types.js";
import {
  modelRefFromBody,
  numberParam,
  OPENCODE_COMPAT_VERSION,
  promptAsync,
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
    model?: { providerID: string; modelID: string };
    variant?: string;
  }>
> {
  const piName = getAgentName();
  const defaults = agentDefaults(await services.catalog());
  return getExposedAgentNames().map((name) => ({
    id: name,
    name,
    description:
      name === piName
        ? `${piName} (pi coding agent via antechamber)`
        : `${name} — ${piName} (pi coding agent via antechamber)`,
    mode: "primary",
    hidden: name === "build" && piName !== "build",
    options: {},
    ...defaults,
  }));
}

function v2Session(services: RouteServices, info: OCSession): V2Session {
  const managed = services.sessions.get(info.id);
  return toV2Session(info, { model: managed?.model, agent: getAgentName() });
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
    time: { created: now, updated: now },
    sandboxes: [],
  }));
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
  if (path === "/api/info" && method === "GET") {
    json(res, 200, {
      version: OPENCODE_COMPAT_VERSION ?? OPENCODE_API_VERSION,
      pid: process.pid,
      urls: [services.url],
      paths: { tmp: tmpdir() },
    });
    return;
  }
  if (path === "/api/location" && method === "GET") {
    json(res, 200, { directory, project: { id: directory, directory, canonical: directory } });
    return;
  }
  if (path === "/api/config" && method === "GET") {
    json(res, 200, withLocation({ default_agent: getAgentName() }));
    return;
  }
  if (path === "/api/provider" && method === "GET") {
    const cat = await services.catalog();
    json(res, 200, withLocation(cat.providers.map((p) => ({ ...p, activation: "enabled" }))));
    return;
  }
  if (path === "/api/model" && method === "GET") {
    const cat = await services.catalog();
    json(res, 200, withLocation(flattenModels(cat)));
    return;
  }
  if (path === "/api/model/default" && method === "GET") {
    const cat = await services.catalog();
    json(res, 200, withLocation(defaultV2Model(cat) ?? null));
    return;
  }
  if (path === "/api/agent" && method === "GET") {
    json(res, 200, withLocation(await v2Agents(services)));
    return;
  }
  const agentMatch = path.match(/^\/api\/agent\/([^/]+)$/);
  if (agentMatch && method === "GET") {
    const agentId = decodeURIComponent(agentMatch[1]!);
    const agent = (await v2Agents(services)).find((a) => a.id === agentId);
    if (!agent) {
      json(res, 404, errorBody("NotFoundError", `agent not found: ${agentId}`));
      return;
    }
    json(res, 200, withLocation(agent));
    return;
  }
  if (path === "/api/command" && method === "GET") {
    json(res, 200, withLocation(await getCommands(directory)));
    return;
  }
  if (path === "/api/skill" && method === "GET") {
    json(res, 200, withLocation([]));
    return;
  }

  // --- project / vcs / permission / form (2.0.4 bootstrap) ---
  if (path === "/api/project" && method === "GET") {
    json(res, 200, v2Projects(services));
    return;
  }
  const projectMatch = path.match(/^\/api\/project\/([^/]+)$/);
  if (projectMatch && method === "PATCH") {
    const projectId = decodeURIComponent(projectMatch[1]!);
    const body = (await services.body(req)) as { canonical?: string };
    json(res, 200, {
      id: projectId,
      canonical: body.canonical ?? projectId,
      time: { created: 0, updated: Date.now() },
      sandboxes: [],
    });
    return;
  }
  if (path === "/api/permission/request" && method === "GET") {
    json(res, 200, withLocation(services.sessions.permissions().map(toV2Permission)));
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
  if (path === "/api/vcs" && method === "GET") {
    json(res, 200, withLocation({ branch: {} }));
    return;
  }
  if (path === "/api/vcs/base" && method === "GET") {
    json(res, 200, withLocation(null));
    return;
  }
  if (path === "/api/vcs/status" && method === "GET") {
    json(res, 200, withLocation([]));
    return;
  }
  if (path === "/api/vcs/branch" && method === "GET") {
    json(res, 200, withLocation([]));
    return;
  }
  if (path === "/api/vcs/diff" && method === "GET") {
    json(res, 200, withLocation(""));
    return;
  }

  // --- sessions ---
  if (path === "/api/session" && method === "GET") {
    const dir = url.searchParams.get("directory") ?? url.searchParams.get("location");
    const search = url.searchParams.get("search");
    const limit = numberParam(url.searchParams.get("limit"));
    let infos = dir !== null && dir !== "" ? services.sessions.list(dir) : services.sessions.listAll();
    if (search) infos = infos.filter((s) => s.title.toLowerCase().includes(search.toLowerCase()));
    const sessions = infos.map((info) => v2Session(services, info));
    sessions.sort((a, b) => b.time.updated - a.time.updated);
    const page = limit !== undefined ? sessions.slice(0, limit) : sessions;
    // The 2.0.4 UI reads `cursor.previous` unconditionally — a list body
    // without a cursor throws "Cannot read properties of undefined".
    json(res, 200, { data: page, cursor: { previous: null, next: null } });
    return;
  }
  if (path === "/api/session" && method === "POST") {
    const body = (await services.body(req)) as {
      title?: string;
      parentID?: string;
      location?: { directory?: string };
    };
    const dir = body.location?.directory ?? directory;
    const info = await services.sessions.create(dir, body.title, body.parentID);
    json(res, 200, { data: v2Session(services, info) });
    return;
  }
  if (path === "/api/session/active" && method === "GET") {
    const data: Record<string, { type: "running" }> = {};
    for (const [id, status] of Object.entries(services.sessions.statuses())) {
      if (status.type !== "idle") data[id] = { type: "running" };
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
        const body = (await services.body(req)) as { reply?: "once" | "always" | "reject"; message?: string };
        if (!body.reply || !services.sessions.replyPermission(sessionId, requestId, body.reply, body.message)) {
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
      case "GET /todo":
        json(res, 200, { data: services.sessions.todos(sessionId) });
        return;
      case "GET ": {
        json(res, 200, { data: v2Session(services, managed.info) });
        return;
      }
      case "PATCH ": {
        const body = (await services.body(req)) as { title?: string; time?: { archived?: number } };
        services.sessions.update(sessionId, { title: body.title, archived: body.time?.archived });
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
        if (limit !== undefined) messages = messages.slice(0, limit);
        json(res, 200, { data: messages, cursor: { previous: null, next: null } });
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
        json(res, 200, { data: true });
        return;
      }
      case "POST /shell": {
        const command = parseShellCommand(await services.body(req));
        if (command === undefined) {
          json(res, 400, errorBody("BadRequestError", "command is required"));
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
        json(res, 200, { data: toV2Message(result.message) });
        return;
      }
      case "POST /command": {
        const input = parseSlashCommand(await services.body(req));
        if (input === undefined) {
          json(res, 400, errorBody("BadRequestError", "command is required"));
          return;
        }
        const message = await runSlashCommand(services.sessions, sessionId, input);
        json(res, 200, {
          data:
            message === undefined ? { info: null, parts: [] } : { info: toV2Message(message), parts: message.parts },
        });
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
          text?: string;
          model?: { providerID?: string; id?: string; modelID?: string; variant?: string };
          variant?: string;
          delivery?: string;
        };
        const text = typeof body.text === "string" ? body.text : "";
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
        promptAsync(services, managed, text, model, false, messageID, delivery);
        json(res, 200, {
          data: {
            id: messageID,
            sessionID: sessionId,
            time: { created: Date.now() },
            type: "user",
            text,
            payload: { text },
            delivery,
          },
        });
        return;
      }
      case "POST /interrupt": {
        await services.sessions.abort(sessionId);
        json(res, 200, { data: true });
        return;
      }
      case "POST /agent": {
        await services.body(req); // agent is fixed per connector — acknowledge and ignore
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
        json(res, 200, { data: await services.sessions.diff(sessionId) });
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
