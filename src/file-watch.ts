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

const LEASE_MS = 24 * 60 * 60 * 1000;
const MAX_PER_DIRECTORY = 256;

type FileWatchLease = { watcher: FSWatcher; expires: number; timer: ReturnType<typeof setTimeout> };

export class FileWatchRegistry {
  private watches = new Map<string, Map<string, FileWatchLease>>();

  constructor(private emit: (directory: string, event: OCEvent) => void) {}

  async file(directory: string, path: string, required: boolean): Promise<string> {
    const root = await realpath(directory);
    const target = resolve(root, path);
    const inside = relative(root, target);
    if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside))
      throw new FileWatchError(400, "BadRequestError", "Path must remain inside the selected directory");
    // Removal uses the registered path even when the file or symlink no longer exists.
    if (!required) return resolve(directory, path);
    try {
      const canonical = await realpath(target);
      const rel = relative(root, canonical);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
        throw new FileWatchError(400, "BadRequestError", "Path must remain inside the selected directory");
      if (!(await stat(canonical)).isFile())
        throw new FileWatchError(404, "FileNotFoundError", `File not found: ${path}`);
      return canonical;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        throw new FileWatchError(404, "FileNotFoundError", `File not found: ${path}`);
      throw error;
    }
  }

  watch(directory: string, file: string, reportedFile: string): void {
    const files = this.watches.get(directory) ?? new Map<string, FileWatchLease>();
    const existing = files.get(reportedFile);
    if (existing !== undefined) {
      existing.expires = Date.now() + LEASE_MS;
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => this.unwatch(directory, reportedFile), LEASE_MS);
      existing.timer.unref();
      return;
    }
    if (files.size >= MAX_PER_DIRECTORY) {
      const [soonest] = [...files].reduce((a, b) => (b[1].expires < a[1].expires ? b : a));
      this.unwatch(directory, soonest);
    }
    const timer = setTimeout(() => this.unwatch(directory, reportedFile), LEASE_MS);
    timer.unref();
    const lease: FileWatchLease = {
      watcher: this.arm(directory, file, reportedFile),
      expires: Date.now() + LEASE_MS,
      timer,
    };
    files.set(reportedFile, lease);
    this.watches.set(directory, files);
  }

  /**
   * Watch the file itself, not its directory. On macOS a directory watch goes through FSEvents, whose stream
   * starts asynchronously and under load missed a write made right after the 204 (reproduced: every run failed
   * with eight test processes in parallel); a file watch (kqueue there, inotify on Linux) is registered before
   * fs.watch returns. An editor's atomic save replaces the inode and ends the watch with "rename", so a
   * replacement file is watched again; a removed file releases its lease.
   */
  private arm(directory: string, file: string, reportedFile: string): FSWatcher {
    const watcher = watch(file, (event) => {
      const exists = existsSync(file);
      this.emit(directory, {
        type: "filesystem.changed",
        properties: { file: reportedFile, event: exists ? "change" : "unlink" },
      });
      const lease = this.watches.get(directory)?.get(reportedFile);
      if (event !== "rename" || lease?.watcher !== watcher) return;
      if (!exists) {
        this.unwatch(directory, reportedFile);
        return;
      }
      watcher.close();
      lease.watcher = this.arm(directory, file, reportedFile);
    });
    watcher.on("error", () => {
      if (this.watches.get(directory)?.get(reportedFile)?.watcher === watcher) this.unwatch(directory, reportedFile);
      else watcher.close();
    });
    return watcher;
  }

  unwatch(directory: string, file: string): void {
    const files = this.watches.get(directory);
    const entry = files?.get(file);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    entry.watcher.close();
    files?.delete(file);
    if (files?.size === 0) this.watches.delete(directory);
  }

  close(): void {
    for (const files of this.watches.values()) {
      for (const entry of files.values()) {
        clearTimeout(entry.timer);
        entry.watcher.close();
      }
    }
    this.watches.clear();
  }
}
