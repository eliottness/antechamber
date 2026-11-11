/** Unprefixed compatibility routes retained for evidenced or uncertain callers. */

import type { IncomingMessage, ServerResponse } from "node:http";
import { errorBody, json } from "./http.js";
import { mcpRoute } from "./mcp.js";
import { miscRoute } from "./misc-routes.js";
import { OPENCODE_COMPAT_VERSION, type RouteServices } from "./route-services.js";

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
  if (method === "GET" && path === "/global/upgrade") {
    json(res, 409, errorBody("UnsupportedError", "Upgrade antechamber with the upgrade CLI command."));
    return;
  }

  // MCP OAuth and the remaining unprefixed probes are deliberately retained
  // until their complete caller chain is established; see .omo/v1-removal-map.md.
  const mcp = await mcpRoute(services, method, path, directory, () => services.body(req));
  if (mcp !== undefined) {
    json(res, mcp.status, mcp.body);
    return;
  }
  if ((method === "GET" && ["/skill", "/formatter", "/file"].includes(path)) || path.startsWith("/mcp/")) {
    const misc = await miscRoute(method, path, url, directory);
    if (misc !== undefined) {
      json(res, misc.status, misc.body);
      return;
    }
  }

  const sessionResource = method === "GET" ? path.match(/^\/session\/([^/]+)\/(diff|children|message\/[^/]+)$/) : null;
  if (sessionResource) {
    const sessionID = sessionResource[1]!;
    const resource = sessionResource[2]!;
    if (!services.sessions.get(sessionID)) {
      json(res, 404, errorBody("NotFoundError", `session not found: ${sessionID}`));
      return;
    }
    if (resource === "diff") {
      json(res, 200, await services.sessions.diff(sessionID));
    } else if (resource === "children") {
      json(
        res,
        200,
        services.sessions.list(directory).filter((candidate) => candidate.parentID === sessionID),
      );
    } else {
      const messageID = decodeURIComponent(resource.slice("message/".length));
      const message = services.sessions.messages(sessionID)?.find((candidate) => candidate.info.id === messageID);
      if (message === undefined) json(res, 404, errorBody("NotFoundError", `message not found: ${messageID}`));
      else json(res, 200, message);
    }
    return;
  }

  json(res, 404, errorBody("NotFoundError", `no route: ${method} ${path}`));
}
