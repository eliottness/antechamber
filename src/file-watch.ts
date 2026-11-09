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

/** While the file exists `watcher` is a native watch on it; while it is missing `missing` checks for it. */
type FileWatchLease = {
  watcher: FSWatcher | null;
  missing: ReturnType<typeof setInterval> | null;
  expires: number;
  timer: ReturnType<typeof setTimeout>;
};

/** How often a missing watched file is checked for (existsSync, nothing spawned). */
const MISSING_POLL_MS = 1000;

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
    const lease: FileWatchLease = { watcher: null, missing: null, expires: Date.now() + LEASE_MS, timer };
    files.set(reportedFile, lease);
    this.watches.set(directory, files);
    lease.watcher = this.armFile(directory, file, reportedFile);
  }

  /**
   * Watch the file itself, not its directory: on macOS a directory watch goes through FSEvents, which starts
   * asynchronously and under load missed a write made right after the 204, and missed a delete-and-recreate for
   * seconds (reproduced: every run failed with eight test processes in parallel). A file watch (kqueue there,
   * inotify on Linux) starts within a tick. An editor's atomic save replaces the inode and ends the watch with
   * "rename"; the replacement is watched. A removed file keeps its lease, as OpenCode's does: a stat watch looks for
   * it until it exists again, then the native watch resumes.
   */
  private armFile(directory: string, file: string, reportedFile: string): FSWatcher {
    const watcher = watch(file, (event) => {
      const exists = existsSync(file);
      this.emit(directory, {
        type: "filesystem.changed",
        properties: { file: reportedFile, event: exists ? "change" : "unlink" },
      });
      const lease = this.watches.get(directory)?.get(reportedFile);
      // A rename replaced the inode; an absent file ended the watch, whatever the event (macOS reports a write and
      // a delete arriving together as one "change").
      if (lease?.watcher !== watcher || (exists && event !== "rename")) return;
      watcher.close();
      lease.watcher = null;
      if (exists) this.rearm(directory, file, reportedFile, lease);
      else this.awaitFile(directory, file, reportedFile, lease);
    });
    watcher.on("error", () => {
      if (this.watches.get(directory)?.get(reportedFile)?.watcher === watcher) this.unwatch(directory, reportedFile);
      else watcher.close();
    });
    return watcher;
  }

  /**
   * Check for the missing file on a timer. Not fs.watchFile: it takes its baseline stat asynchronously and never
   * reports a file that came back before that stat finished.
   */
  private awaitFile(directory: string, file: string, reportedFile: string, lease: FileWatchLease): void {
    const check = () => {
      if (!existsSync(file) || this.watches.get(directory)?.get(reportedFile) !== lease) return;
      if (lease.missing !== null) clearInterval(lease.missing);
      lease.missing = null;
      this.emit(directory, { type: "filesystem.changed", properties: { file: reportedFile, event: "change" } });
      this.rearm(directory, file, reportedFile, lease);
    };
    lease.missing = setInterval(check, MISSING_POLL_MS);
    lease.missing.unref();
    check();
  }

  /**
   * Runs inside a watch listener, where a throw would end the process: fs.watch throws synchronously for a
   * replacement it cannot open (EACCES, a file gone again, ENOSPC/EMFILE). Such a lease is released instead.
   */
  private rearm(directory: string, file: string, reportedFile: string, lease: FileWatchLease): void {
    try {
      lease.watcher = this.armFile(directory, file, reportedFile);
    } catch (error) {
      // Gone again between the check and the watch: keep the lease and wait for it once more.
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        this.awaitFile(directory, file, reportedFile, lease);
        return;
      }
      console.error(`[file-watch] stopped watching ${reportedFile}:`, error);
      this.unwatch(directory, reportedFile);
    }
  }

  private release(lease: FileWatchLease): void {
    clearTimeout(lease.timer);
    lease.watcher?.close();
    if (lease.missing !== null) clearInterval(lease.missing);
  }

  unwatch(directory: string, file: string): void {
    const files = this.watches.get(directory);
    const entry = files?.get(file);
    if (entry === undefined) return;
    this.release(entry);
    files?.delete(file);
    if (files?.size === 0) this.watches.delete(directory);
  }

  close(): void {
    for (const files of this.watches.values()) {
      for (const entry of files.values()) {
        this.release(entry);
      }
    }
    this.watches.clear();
  }
}
