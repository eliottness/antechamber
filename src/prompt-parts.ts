/** Lossless user parts on the wire, adapted to the native text/images RPC. */
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
          else throw new RequestBodyError(400, `Unsupported inline attachment MIME type: ${part.mime}`);
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
