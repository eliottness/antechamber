/** Shared HTTP body, response, authentication, and CORS plumbing. */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { ApprovalInputError } from "./approvals.js";
import { envSetting } from "./config.js";
import { UpstreamProtocolError } from "./pi-rpc.js";

const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;

export class RequestBodyError extends Error {
  constructor(
    readonly status: 400 | 413,
    message: string,
  ) {
    super(message);
    this.name = status === 413 ? "PayloadTooLargeError" : "InvalidRequestError";
  }
}

export function serverPassword(): string | undefined {
  return process.env.OPENCODE_SERVER_PASSWORD || envSetting("SERVER_PASSWORD");
}

export function isLoopbackHost(host: string): boolean {
  if (["localhost", "::1", "[::1]"].includes(host.toLowerCase())) return true;
  return /^127(?:\.\d{1,3}){3}$/.test(host) && host.split(".").every((part) => Number(part) <= 255);
}

function allowedOrigin(origin: string, serverOrigin?: string): boolean {
  try {
    const url = new URL(origin);
    if (
      !/^https?:\/\/[^/?#]+$/.test(origin) ||
      url.pathname !== "/" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    )
      return false;
    return (
      origin === serverOrigin ||
      isLoopbackHost(url.hostname) ||
      (envSetting("ALLOWED_ORIGINS") ?? "").split(",").some((entry) => entry.trim() === origin)
    );
  } catch {
    return false;
  }
}

export function errorBody(name: string, message: string): { name: string; data: { message: string } } {
  return { name, data: { message } };
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" }).end(payload);
}

export class Http {
  private readonly credentials: Buffer | undefined;
  private readonly maxBodyBytes: number;

  constructor(private serverOrigin?: () => string) {
    const maxBodyBytes = Number(envSetting("MAX_BODY_BYTES"));
    this.maxBodyBytes = Number.isSafeInteger(maxBodyBytes) && maxBodyBytes > 0 ? maxBodyBytes : DEFAULT_MAX_BODY_BYTES;
    const password = serverPassword();
    this.credentials =
      password === undefined
        ? undefined
        : createHash("sha256")
            .update(`${process.env.OPENCODE_SERVER_USERNAME || "opencode"}:${password}`)
            .digest();
  }

  allowsUpgrade(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigin(origin, this.serverOrigin?.()) && this.credentials === undefined)
      return false;
    return this.authorized(req);
  }

  async route(req: IncomingMessage, res: ServerResponse, handle: () => Promise<void>): Promise<void> {
    res.setHeader("Vary", "Origin");
    const origin = req.headers.origin;
    if (origin !== undefined) {
      if (allowedOrigin(origin, this.serverOrigin?.())) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
      } else if (this.credentials === undefined) {
        // Without a password the Origin check is the only guard against
        // drive-by browser requests. With one, the password is the boundary:
        // OpenChamber's proxy forwards its own clients' Origin (LAN pages,
        // the desktop app), which must not be rejected.
        json(res, 403, errorBody("ForbiddenError", "Origin is not allowed"));
        return;
      }
    }
    if (!this.authorized(req)) {
      res.setHeader("WWW-Authenticate", 'Basic realm="OpenCode"');
      json(res, 401, errorBody("UnauthorizedError", "Authentication required"));
      return;
    }
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-opencode-directory");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    try {
      await handle();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof RequestBodyError && err.status === 413) {
        res.setHeader("Connection", "close");
        res.once("finish", () => req.destroy());
      }
      json(
        res,
        err instanceof UpstreamProtocolError
          ? 502
          : err instanceof RequestBodyError
            ? err.status
            : err instanceof ApprovalInputError || err instanceof URIError
              ? 400
              : 500,
        errorBody(
          err instanceof UpstreamProtocolError
            ? err.name
            : err instanceof RequestBodyError
              ? err.name
              : err instanceof ApprovalInputError
                ? "InvalidRequestError"
                : err instanceof URIError
                  ? "BadRequestError"
                  : "UnknownError",
          err instanceof URIError ? "invalid URL encoding" : message,
        ),
      );
    }
  }

  body(req: IncomingMessage): Promise<unknown> {
    if (Number(req.headers["content-length"]) > this.maxBodyBytes) {
      req.pause();
      return Promise.reject(new RequestBodyError(413, `Request body exceeds ${this.maxBodyBytes} bytes`));
    }
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      const cleanup = (): void => {
        req.off("data", onData);
        req.off("end", onEnd);
        req.off("error", onError);
        req.off("aborted", onAborted);
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onAborted = (): void => onError(new RequestBodyError(400, "Request body was aborted"));
      const onData = (chunk: Buffer): void => {
        bytes += chunk.length;
        if (bytes > this.maxBodyBytes) {
          req.pause();
          chunks.length = 0;
          onError(new RequestBodyError(413, `Request body exceeds ${this.maxBodyBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      };
      const onEnd = (): void => {
        cleanup();
        if (bytes === 0) {
          resolve({});
          return;
        }
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
        } catch {
          reject(new RequestBodyError(400, "Request body must be valid JSON"));
          return;
        }
        if (
          body === null ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          Object.getPrototypeOf(body) !== Object.prototype
        ) {
          reject(new RequestBodyError(400, "Request body must be a JSON object"));
          return;
        }
        resolve(body);
      };
      req.on("data", onData);
      req.once("end", onEnd);
      req.once("error", onError);
      req.once("aborted", onAborted);
    });
  }

  private authorized(req: IncomingMessage): boolean {
    if (this.credentials === undefined) return true;
    const match = req.headers.authorization?.match(/^Basic\s+([A-Za-z0-9+/]+=*)$/i);
    const supplied = createHash("sha256")
      .update(Buffer.from(match?.[1] ?? "", "base64"))
      .digest();
    return match !== null && match !== undefined && timingSafeEqual(this.credentials, supplied);
  }
}
