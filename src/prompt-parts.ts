/** Lossless user parts on the wire, adapted to the native text/images RPC. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defaultStateDir, envSetting } from "./config.js";
import { RequestBodyError } from "./http.js";
import type { OCPromptPart } from "./types.js";

export function isPromptPart(value: unknown): value is OCPromptPart {
  if (typeof value !== "object" || value === null || !("type" in value)) return false;
  if ("id" in value && typeof value.id !== "string") return false;
  switch (value.type) {
    case "text":
      return (
        "text" in value &&
        typeof value.text === "string" &&
        (!("synthetic" in value) || typeof value.synthetic === "boolean")
      );
    case "file":
      return (
        "mime" in value &&
        typeof value.mime === "string" &&
        "url" in value &&
        typeof value.url === "string" &&
        (!("filename" in value) || typeof value.filename === "string")
      );
    case "agent":
      return (
        "name" in value &&
        typeof value.name === "string" &&
        (!("source" in value) ||
          (typeof value.source === "object" &&
            value.source !== null &&
            "value" in value.source &&
            typeof value.source.value === "string" &&
            "start" in value.source &&
            typeof value.source.start === "number" &&
            "end" in value.source &&
            typeof value.source.end === "number"))
      );
    default:
      return false;
  }
}

export function parsePromptParts(value: unknown): OCPromptPart[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isPromptPart))
    throw new RequestBodyError(400, "parts must contain supported text, file, or agent inputs");
  return value;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** OpenChamber 2.x attachments (`files: [{uri, name?}]`, `agents: [{name, mention?}]`) as prompt parts. */
export function v2PromptParts(text: string, files: unknown, agents: unknown): OCPromptPart[] {
  const parts: OCPromptPart[] = text === "" ? [] : [{ type: "text", text }];
  if (files !== undefined) {
    if (!Array.isArray(files)) throw new RequestBodyError(400, "files must be an array");
    for (const file of files) {
      if (
        !plainRecord(file) ||
        typeof file.uri !== "string" ||
        (file.name !== undefined && typeof file.name !== "string")
      )
        throw new RequestBodyError(400, "files must contain {uri, name?} attachments");
      // v2 carries no MIME type; an inline data URI still names its own.
      const mime = /^data:([^;,]+)/.exec(file.uri)?.[1] ?? "application/octet-stream";
      parts.push({
        type: "file",
        mime,
        url: file.uri,
        ...(typeof file.name === "string" ? { filename: file.name } : {}),
      });
    }
  }
  if (agents !== undefined) {
    if (!Array.isArray(agents)) throw new RequestBodyError(400, "agents must be an array");
    for (const agent of agents) {
      const mention = plainRecord(agent) ? agent.mention : undefined;
      if (
        !plainRecord(agent) ||
        typeof agent.name !== "string" ||
        (mention !== undefined &&
          (!plainRecord(mention) ||
            typeof mention.start !== "number" ||
            typeof mention.end !== "number" ||
            typeof mention.text !== "string"))
      )
        throw new RequestBodyError(400, "agents must contain {name, mention?} references");
      parts.push({
        type: "agent",
        name: agent.name,
        ...(plainRecord(mention) &&
        typeof mention.text === "string" &&
        typeof mention.start === "number" &&
        typeof mention.end === "number"
          ? { source: { value: mention.text, start: mention.start, end: mention.end } }
          : {}),
      });
    }
  }
  return parts;
}

/** The v2 wire form of a prompt's attachments, as OpenChamber 2.x projects them back into parts. */
export function v2PromptAttachments(parts: readonly OCPromptPart[]) {
  const files = parts.flatMap((part) =>
    part.type === "file"
      ? [
          {
            mime: part.mime,
            ...(part.filename !== undefined ? { name: part.filename } : {}),
            source: { type: "uri", uri: part.url },
          },
        ]
      : [],
  );
  const agents = parts.flatMap((part) =>
    part.type === "agent"
      ? [
          {
            name: part.name,
            ...(part.source !== undefined
              ? { mention: { start: part.source.start, end: part.source.end, text: part.source.value } }
              : {}),
          },
        ]
      : [],
  );
  return { ...(files.length > 0 ? { files } : {}), ...(agents.length > 0 ? { agents } : {}) };
}

/** Native custom-message type for no-reply context (v2 synthetic, v1 noReply) admitted without a turn. */
export const CONTEXT_MESSAGE_TYPE = "antechamber.context";

/** The OpenChamber message id of a native context entry, if the entry is one. */
export function contextMessageID(entry: { type?: string; customType?: string; details?: unknown }): string | undefined {
  if (entry.type !== "custom_message" || entry.customType !== CONTEXT_MESSAGE_TYPE || !plainRecord(entry.details))
    return undefined;
  return typeof entry.details.messageID === "string" ? entry.details.messageID : undefined;
}

/**
 * Saves inline attachment bytes the native RPC cannot carry under `<state dir>/attachments`.
 * The path is content-addressed, so re-deriving a prompt (admission checks, history binding)
 * names the same file and recreates it if it was removed.
 */
function storeInlineAttachment(content: Buffer, filename: string | undefined): string {
  const digest = createHash("sha256").update(content).digest("hex");
  const root = join(resolve(envSetting("STATE_DIR") ?? defaultStateDir()), "attachments");
  const dir = join(root, digest);
  const name = basename(filename ?? "").replaceAll("\0", "");
  const path = join(dir, name === "" || name === "." || name === ".." ? "attachment" : name);
  if (!existsSync(path)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const partial = `${path}.${process.pid}.partial`;
    writeFileSync(partial, content, { mode: 0o600 });
    renameSync(partial, path);
  }
  return path;
}

export function nativePromptInput(text: string, parts: readonly OCPromptPart[]) {
  const chunks = [text];
  const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
  for (const part of parts) {
    switch (part.type) {
      case "text":
        break;
      case "agent":
        chunks.push(`@${part.name}`);
        break;
      case "file": {
        const data = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(part.url);
        if (data !== null) {
          const content = data[2]
            ? Buffer.from(data[3] ?? "", "base64")
            : Buffer.from(decodeURIComponent(data[3] ?? ""));
          if (part.mime.startsWith("image/"))
            images.push({ type: "image", data: content.toString("base64"), mimeType: part.mime });
          else if (part.mime.startsWith("text/"))
            chunks.push(`${part.filename ?? "attachment"} (${part.mime}):\n${content.toString("utf8")}`);
          else {
            // Native RPC has no generic FilePart: save the bytes and hand the agent a file
            // reference, as for workspace files below, so its own tools can read e.g. a PDF.
            const url = pathToFileURL(storeInlineAttachment(content, part.filename)).href;
            chunks.push(JSON.stringify({ filename: part.filename, mime: part.mime, url }));
          }
        } else {
          // Native RPC has no generic FilePart; retain the reference in model
          // context so the agent can read the selected workspace file.
          chunks.push(JSON.stringify({ filename: part.filename, mime: part.mime, url: part.url }));
        }
        break;
      }
    }
  }
  return { message: chunks.join("\n\n"), ...(images.length > 0 ? { images } : {}) };
}
