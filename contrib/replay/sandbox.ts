import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { SessionRegistryEntry } from "../../src/session-store.js";

export function copyReplayState(
  stateDir: string,
  state: string,
  agent: string,
  registry: Record<string, SessionRegistryEntry>,
  selected: readonly (readonly [string, SessionRegistryEntry])[],
): void {
  cpSync(stateDir, state, {
    recursive: true,
    dereference: true,
    filter: (path) => !path.startsWith(join(stateDir, "run")),
  });
  const included = new Set(selected.map(([id]) => id));
  for (const id of included) {
    for (const [childID, record] of Object.entries(registry)) {
      if (record.parentID === id) included.add(childID);
    }
  }

  const paths = new Map<string, string>();
  for (const entry of readdirSync(state, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || entry.name === "sessions.json") continue;
    const local = join(entry.parentPath, entry.name);
    paths.set(join(stateDir, relative(state, local)), local);
  }
  const copyPath = (source: string, destination: string): string => {
    const known = paths.get(source);
    if (known !== undefined) return known;
    paths.set(source, destination);
    if (existsSync(source)) {
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(source, destination);
    }
    return destination;
  };
  const copied: Record<string, SessionRegistryEntry> = {};
  for (const id of included) {
    const record = registry[id];
    if (record === undefined) continue;
    const piPath = copyPath(record.piPath, join(agent, "sessions", id, basename(record.piPath)));
    copied[id] = { ...record, piPath };
  }

  const remap = (key: string, value: unknown): unknown => {
    if (typeof value !== "string" || !isAbsolute(value)) return value;
    if (value.startsWith(`${state}${sep}`) || value.startsWith(`${agent}${sep}`)) return value;
    const known = paths.get(value);
    if (known !== undefined) return known;
    if (value.startsWith(`${stateDir}${sep}`)) return join(state, relative(stateDir, value));
    if (!/^(?:piPath|session_?(?:path|file)|transcript_?(?:path|file)|record_?path|parentSession)$/i.test(key))
      return value;
    return copyPath(value, join(agent, "references", value.slice(1)));
  };
  writeFileSync(join(state, "sessions.json"), JSON.stringify(copied, remap));
  // References found in task metadata and transcripts can add more files to this queue.
  for (const [source, destination] of paths) {
    if (!existsSync(destination) || !/\.jsonl?$/.test(source)) continue;
    const raw = readFileSync(destination, "utf8");
    const lines = source.endsWith(".jsonl") ? raw.split("\n") : [raw];
    const rewritten = lines.map((line) => {
      if (line.trim() === "") return line;
      try {
        const value: unknown = JSON.parse(line);
        const updated = JSON.stringify(value, remap);
        return JSON.stringify(value) === updated ? line : updated;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        return line;
      }
    });
    const output = rewritten.join(source.endsWith(".jsonl") ? "\n" : "");
    if (output !== raw) writeFileSync(destination, output);
  }
}
