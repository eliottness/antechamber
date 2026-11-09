import { existsSync, type FSWatcher, watch } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { OCEvent } from "./types.js";

export class FileWatchError extends Error {
  constructor(
    readonly status: number,
    readonly kind: string,
    message: string,
  ) {
    super(message);
  }
}

export class FileWatchRegistry {
  private watches = new Map<string, { watcher: FSWatcher; users: number }>();

  constructor(private emit: (directory: string, event: OCEvent) => void) {}

  async file(directory: string, path: string, required: boolean): Promise<string> {
    const root = await realpath(directory);
    const target = resolve(root, path);
    const inside = relative(root, target);
    if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside))
      throw new FileWatchError(400, "BadRequestError", "Path must remain inside the selected directory");
    try {
      const actual = await realpath(required ? target : dirname(target));
      const canonical = required ? actual : resolve(actual, basename(target));
      const rel = relative(root, canonical);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
        throw new FileWatchError(400, "BadRequestError", "Path must remain inside the selected directory");
      if (required && !(await stat(canonical)).isFile())
        throw new FileWatchError(404, "FileNotFoundError", `File not found: ${path}`);
      return canonical;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        throw new FileWatchError(404, "FileNotFoundError", `File not found: ${path}`);
      throw error;
    }
  }

  watch(directory: string, file: string, reportedFile: string): void {
    const key = JSON.stringify([directory, file]);
    const existing = this.watches.get(key);
    if (existing !== undefined) {
      existing.users++;
      return;
    }
    const watcher = watch(dirname(file), (_event, changed) => {
      if (changed !== null && changed.toString() !== basename(file)) return;
      this.emit(directory, {
        type: "filesystem.changed",
        properties: { file: reportedFile, event: existsSync(file) ? "change" : "unlink" },
      });
    });
    watcher.on("error", () => {
      watcher.close();
      this.watches.delete(key);
    });
    this.watches.set(key, { watcher, users: 1 });
  }

  unwatch(directory: string, file: string): void {
    const key = JSON.stringify([directory, file]);
    const entry = this.watches.get(key);
    if (entry === undefined || --entry.users > 0) return;
    entry.watcher.close();
    this.watches.delete(key);
  }

  close(): void {
    for (const entry of this.watches.values()) entry.watcher.close();
    this.watches.clear();
  }
}
