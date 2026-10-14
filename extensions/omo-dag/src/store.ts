import { lstatSync, readdirSync, readFileSync, type Stats, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeRegistry, normalizeTask, type Registry, type TaskRecord } from "./graph.ts";

export interface StoreRoots {
  agentDirs: string[];
  stateDirs: string[];
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/** Same defaults as the connector (`agent-dir.ts`, `config.ts`): OmO first, then plain pi. */
export function defaultRoots(): StoreRoots {
  const home = homedir();
  return {
    agentDirs: [join(home, ".omo", "agent"), join(home, ".pi", "agent")],
    stateDirs: [join(home, ".config", "antechamber"), join(home, ".config", "openchamber-pi-connector")],
  };
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR", "EACCES"].includes(String(error.code));
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

interface Cached<T> {
  mtimeMs: number;
  size: number;
  value: T | undefined;
}

/** Re-reads a JSON file only when its mtime or size changed; torn writes keep the last good value. */
class JsonCache<T> {
  private readonly entries = new Map<string, Cached<T>>();

  read(path: string, accept: (value: unknown) => T | undefined): T | undefined {
    let stat: Stats;
    try {
      stat = statSync(path);
    } catch (error) {
      if (isMissing(error)) {
        this.entries.delete(path);
        return undefined;
      }
      throw error;
    }
    const hit = this.entries.get(path);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.value;
    let value: T | undefined;
    try {
      value = accept(JSON.parse(readFileSync(path, "utf8")));
    } catch (error) {
      if (error instanceof SyntaxError || isMissing(error)) return hit?.value;
      throw error;
    }
    this.entries.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, value });
    return value;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export class TaskStore {
  private readonly tasks = new JsonCache<TaskRecord>();
  private readonly json = new JsonCache<Record<string, unknown>>();
  private readonly registries = new JsonCache<Registry>();

  constructor(private readonly roots: StoreRoots) {}

  private storeDirs(): string[] {
    const dirs = new Set<string>();
    for (const agent of this.roots.agentDirs) {
      const registry = this.json.read(join(agent, "rpc", "task-stores.json"), (v) => (isRecord(v) ? v : undefined));
      if (isRecord(registry?.stores)) for (const dir of Object.keys(registry.stores)) dirs.add(dir);
      for (const project of list(join(agent, "projects"))) dirs.add(join(agent, "projects", project, "senpi-task"));
    }
    return [...dirs];
  }

  loadTasks(): TaskRecord[] {
    const out = new Map<string, TaskRecord>();
    for (const dir of this.storeDirs()) {
      for (const file of list(join(dir, "tasks"))) {
        if (!file.endsWith(".json")) continue;
        const path = join(dir, "tasks", file);
        if (!isRegularFile(path)) continue;
        const task = this.tasks.read(path, normalizeTask);
        if (task) out.set(task.task_id, task);
      }
    }
    return [...out.values()];
  }

  loadRegistry(): Registry {
    const merged: Registry = {};
    for (const dir of [...this.roots.stateDirs].reverse()) {
      const reg = this.registries.read(join(dir, "sessions.json"), normalizeRegistry);
      if (reg) Object.assign(merged, reg);
    }
    return merged;
  }
}
