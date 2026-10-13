import { appendFileSync } from "node:fs";
import { opendir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { envSetting } from "./config.js";

let loggingDisabled = false;
const MAX_DIRECTORY_ENTRIES = 1000;
const MAX_SEARCH_DIRECTORIES = 1024;
const MAX_SEARCH_DEPTH = 32;
const MAX_SEARCH_RESULTS = 1000;

/** One shared failure latch for HTTP and agent-event diagnostics. */
export function debugLog(line: string): void {
  if (!envSetting("DEBUG") || loggingDisabled) return;
  try {
    appendFileSync(
      envSetting("DEBUG_LOG") ?? join(tmpdir(), `antechamber-debug-${process.getuid?.() ?? "user"}.log`),
      line + "\n",
      { flag: "a", mode: 0o600 },
    );
  } catch (error) {
    loggingDisabled = true;
    console.error(`[debug] logging disabled: ${error instanceof Error ? error.message : String(error)}`);
  }
}

interface RouteResult {
  status: number;
  body: unknown;
}

export function errorBody(name: string, message: string): { name: string; data: { message: string } } {
  return { name, data: { message } };
}

function unsupported(message: string): RouteResult {
  return { status: 400, body: errorBody("UnsupportedError", message) };
}

async function confinedDirectory(root: string, path: string): Promise<string | undefined> {
  const candidate = resolve(root, path);
  const rel = relative(root, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  try {
    const actual = await realpath(candidate);
    const actualRel = relative(root, actual);
    return actualRel === ".." || actualRel.startsWith(`..${sep}`) || isAbsolute(actualRel) ? undefined : actual;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    return undefined;
  }
}

export async function miscRoute(
  method: string,
  path: string,
  url: URL,
  directory: string,
): Promise<RouteResult | undefined> {
  if (method === "GET" && ["/skill", "/lsp", "/formatter", "/experimental/tool/ids"].includes(path)) {
    return { status: 200, body: [] };
  }
  if (method === "GET" && ["/provider/auth", "/mcp"].includes(path)) return { status: 200, body: {} };
  if (
    (method === "PUT" && /^\/auth\/[^/]+$/.test(path)) ||
    (method === "POST" && /^\/provider\/[^/]+\/oauth\/(authorize|callback)$/.test(path)) ||
    (method === "PATCH" && path === "/config")
  ) {
    return unsupported("Not supported with OmO; configure providers in OmO");
  }
  if (
    (["POST", "DELETE"].includes(method) &&
      /^\/mcp\/[^/]+\/(connect|disconnect|auth(?:\/(?:callback|authenticate))?)$/.test(path)) ||
    (method === "POST" && path === "/experimental/control-plane/move-session")
  ) {
    return unsupported("Not supported with OmO; configure MCP and session directories in OmO");
  }
  if (method !== "GET" || !["/file", "/find/file"].includes(path)) return undefined;
  const root = await realpath(directory);
  if (path === "/file") {
    const target = await confinedDirectory(root, url.searchParams.get("path") ?? "");
    if (target === undefined) return unsupported("Path must remain inside the session directory");
    const body = [];
    let scanned = 0;
    for await (const entry of await opendir(target)) {
      if (++scanned > MAX_DIRECTORY_ENTRIES) break;
      if (entry.isSymbolicLink() || entry.name === ".git" || (!entry.isFile() && !entry.isDirectory())) continue;
      const absolute = resolve(target, entry.name);
      body.push({
        name: entry.name,
        path: relative(root, absolute).split(sep).join("/"),
        absolute,
        type: entry.isDirectory() ? "directory" : "file",
        ignored: false,
      });
    }
    body.sort((a, b) => a.path.localeCompare(b.path));
    return { status: 200, body };
  }
  const query = url.searchParams.get("query") ?? "";
  if (
    isAbsolute(query) ||
    query.split(/[\\/]/).includes("..") ||
    (url.searchParams.has("path") && (await confinedDirectory(root, url.searchParams.get("path") ?? "")) === undefined)
  ) {
    return unsupported("Path must remain inside the session directory");
  }
  const limitValue = Number(url.searchParams.get("limit") ?? "100");
  const limit = Number.isFinite(limitValue) ? Math.min(MAX_SEARCH_RESULTS, Math.max(0, Math.floor(limitValue))) : 100;
  const dirs = url.searchParams.get("dirs") !== "false" && url.searchParams.get("type") !== "file";
  const onlyDirs = url.searchParams.get("type") === "directory";
  const files: string[] = [];
  let visited = 0;
  const lowerQuery = query.toLowerCase();
  async function visit(directory: string, depth: number): Promise<void> {
    if (visited >= MAX_SEARCH_DIRECTORIES || depth > MAX_SEARCH_DEPTH || files.length >= limit) return;
    visited++;
    let scanned = 0;
    for await (const entry of await opendir(directory)) {
      if (++scanned > MAX_DIRECTORY_ENTRIES || files.length >= limit || visited >= MAX_SEARCH_DIRECTORIES) return;
      if (entry.isSymbolicLink() || entry.name === ".git") continue;
      const absolute = resolve(directory, entry.name);
      const path = relative(root, absolute).split(sep).join("/");
      if (((entry.isFile() && !onlyDirs) || (entry.isDirectory() && dirs)) && path.toLowerCase().includes(lowerQuery))
        files.push(path);
      if (entry.isDirectory() && entry.name !== "node_modules") await visit(absolute, depth + 1);
    }
  }
  await visit(root, 0);
  return { status: 200, body: files.sort() };
}
