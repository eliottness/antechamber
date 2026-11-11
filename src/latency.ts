/** Operator diagnostics. Route labels contain only literals and parameter names. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import { envSetting } from "./config.js";

const SAMPLE_MS = 100;

// The router uses explicit path comparisons rather than a routing framework. Unknown
// paths get a constant label so neither identifiers nor query credentials enter logs.
const ROUTE_PATTERNS = `
  / /health /global/health /global/upgrade /event /global/event
  /session /session/status /project /project/current /config /global/config /provider
  /config/providers /experimental/session /question /permission /lsp /formatter
  /command /path /vcs /agent /file /file/content /file/status /find /find/file /find/symbol
  /provider/auth /auth/:providerID /provider/:providerID/oauth/authorize /provider/:providerID/oauth/callback
  /question/:requestID/reply /question/:requestID/reject /permission/:requestID/reply
  /api/info /api/location /api/config /api/provider /api/model /api/model/default
  /api/agent /api/agent/:agentID /api/command /api/skill /api/debug/location
  /api/credential /api/credential/:credentialID /api/credential/:credentialID/activate
  /api/integration/:integrationID /api/integration/:integrationID/connect/key
  /api/integration/:integrationID/connect/external /api/integration/:integrationID/connect/oauth
  /api/integration/:integrationID/connect/command /api/integration/:integrationID/connect/oauth/:flowID
  /api/integration/:integrationID/connect/command/:flowID
  /api/integration/:integrationID/connect/oauth/:flowID/complete
  /api/plugin /api/plugin/check /api/plugin/update /api/experimental/generate /api/experimental/generate/text
  /api/shell /api/shell/:shellID /api/shell/:shellID/output /api/websearch/provider
  /api/experimental/session/stats /api/experimental/usage/limits /api/experimental/fs/watch
  /api/fs/find /api/project /api/project/:projectID /api/permission/request /api/question/request
  /api/permission/saved /api/permission/saved/:permissionID /api/form /api/vcs/init /api/vcs
  /api/session /api/session/active /api/event /api/global/event/ws
  /api/experimental/session/:sessionID/instructions/entries/:entryID
  /antechamber/work-status/:sessionID
`
  .trim()
  .split(/\s+/);

for (const prefix of ["", "/api"]) {
  const base = `${prefix}/session/:sessionID`;
  ROUTE_PATTERNS.push(base, `${base}/message/:messageID`);
  for (const action of [
    "diff",
    "children",
    "todo",
    "message",
    "prompt_async",
    "abort",
    "fork",
    "revert",
    "unrevert",
    "summarize",
    "shell",
    "command",
    "share",
    "generate",
    "background",
    "move",
    "view",
    "compact",
    "prompt",
    "synthetic",
    "context",
    "interrupt",
    "revert/stage",
    "revert/commit",
    "agent",
    "model",
    "form",
    "question",
    "permission",
    "inbox",
  ])
    ROUTE_PATTERNS.push(`${base}/${action}`);
  for (const resource of ["form", "question", "permission"])
    for (const suffix of ["", "/reply", "/reject"]) ROUTE_PATTERNS.push(`${base}/${resource}/:requestID${suffix}`);
}

const routes = ROUTE_PATTERNS.map((pattern) => ({
  pattern,
  match: new RegExp(`^${pattern.replace(/:[A-Za-z]+/g, "[^/]+")}$`),
}));

function routePattern(req: IncomingMessage): string {
  const path = new URL(req.url ?? "/", "http://localhost").pathname.replace(/\/+$/, "") || "/";
  return routes.find((route) => route.match.test(path))?.pattern ?? "unmatched";
}

function threshold(name: string, fallback: number): number {
  const value = Number(envSetting(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export class LatencyMonitor {
  private readonly lagThreshold = threshold("EVENT_LOOP_LAG_MS", 250);
  private readonly requestThreshold = threshold("SLOW_REQUEST_MS", 1000);
  private timer: ReturnType<typeof setInterval> | undefined;

  start(): void {
    let expected = performance.now() + SAMPLE_MS;
    this.timer = setInterval(() => {
      const now = performance.now();
      const lag = now - expected;
      expected = now + SAMPLE_MS;
      if (lag > this.lagThreshold)
        console.warn(`[latency] event-loop-lag duration_ms=${Math.round(lag)} threshold_ms=${this.lagThreshold}`);
    }, SAMPLE_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async request(req: IncomingMessage, res: ServerResponse, handle: () => Promise<void>): Promise<void> {
    const start = performance.now();
    try {
      await handle();
    } finally {
      // SSE handlers return after setup; connection lifetime is not request latency.
      const duration = performance.now() - start;
      if (duration > this.requestThreshold)
        console.warn(
          `[latency] slow-request method=${req.method ?? "GET"} route=${routePattern(req)} status=${res.statusCode} duration_ms=${Math.round(duration)}`,
        );
    }
  }
}
