import { execFile } from "node:child_process";
import { devNull } from "node:os";
import { promisify } from "node:util";

const exec = promisify(execFile);
const GIT_EXEC_TIMEOUT_MS = 5_000;
const GIT_EXEC_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/** OpenCode 2.0.28 VcsFileStatus / FileDiffInfo (patch only belongs to diff). */
interface VcsFileStatus {
  file: string;
  additions: number;
  deletions: number;
  status: "added" | "deleted" | "modified";
}

interface FileDiffInfo extends VcsFileStatus {
  patch: string;
}

interface VcsBase {
  name: string;
  ref: string;
  source: "reflog" | "default";
}

export class VcsError extends Error {
  override name = "BadRequestError";
}

async function git(directory: string, args: string[], difference = false): Promise<string> {
  try {
    const { stdout } = await exec("git", args, {
      cwd: directory,
      timeout: GIT_EXEC_TIMEOUT_MS,
      maxBuffer: GIT_EXEC_MAX_BUFFER_BYTES,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1", LC_ALL: "C" },
    });
    return stdout;
  } catch (error) {
    // git diff --no-index exits 1 when it successfully finds a difference.
    if (
      difference &&
      error instanceof Error &&
      "code" in error &&
      error.code === 1 &&
      "stdout" in error &&
      typeof error.stdout === "string"
    ) {
      return error.stdout;
    }
    throw error;
  }
}

async function optionalRef(directory: string, args: string[]): Promise<string | undefined> {
  try {
    return (await git(directory, args)).trim() || undefined;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === 1) return undefined;
    throw error;
  }
}

async function base(directory: string): Promise<VcsBase | null> {
  if ((await optionalRef(directory, ["rev-parse", "--verify", "--quiet", "HEAD"])) === undefined) return null;
  const current = await optionalRef(directory, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (current !== undefined) {
    const reflog = await git(directory, ["reflog", "show", "--format=%gs", "--max-count=100", "HEAD"]);
    for (const line of reflog.split("\n")) {
      const checkout = line.match(/^checkout: moving from (.+) to (.+)$/);
      if (!checkout || checkout[2] !== current || checkout[1] === current) continue;
      const name = checkout[1]!;
      const ref = await optionalRef(directory, ["show-ref", "--verify", "--hash", `refs/heads/${name}`]);
      if (ref !== undefined) return { name, ref, source: "reflog" };
    }
  }
  const remote = await optionalRef(directory, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  for (const name of [...(remote === undefined ? [] : [remote]), "main", "master"]) {
    const ref = await optionalRef(directory, ["rev-parse", "--verify", "--quiet", `${name}^{commit}`]);
    if (ref !== undefined) return { name, ref, source: "default" };
  }
  return null;
}

function nonNegativeInteger(url: URL, key: string, fallback: number): number {
  const value = url.searchParams.get(key);
  if (value === null) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new VcsError(`${key} must be a non-negative integer`);
  }
  return Number(value);
}

async function diffs(
  directory: string,
  revision: string,
  committed: boolean,
  context: number,
  patches: boolean,
): Promise<FileDiffInfo[]> {
  const args = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", revision];
  if (committed) args.push("HEAD");
  const names = (await git(directory, [...args, "--name-status", "-z", "--"])).split("\0");
  const statuses = new Map<string, VcsFileStatus["status"]>();
  for (let i = 0; i + 1 < names.length; i += 2) {
    const file = names[i + 1]!;
    statuses.set(file, names[i] === "A" ? "added" : names[i] === "D" ? "deleted" : "modified");
  }
  const counts = (await git(directory, [...args, "--numstat", "-z", "--"])).split("\0").filter(Boolean);
  const result: FileDiffInfo[] = [];
  let bytes = 0;
  const append = (entry: FileDiffInfo) => {
    bytes += Buffer.byteLength(entry.patch);
    if (bytes > GIT_EXEC_MAX_BUFFER_BYTES) throw new VcsError("Git diff exceeds the output limit");
    result.push(entry);
  };
  for (const entry of counts) {
    const first = entry.indexOf("\t");
    const second = entry.indexOf("\t", first + 1);
    const file = entry.slice(second + 1);
    append({
      file,
      additions: Number(entry.slice(0, first)) || 0,
      deletions: Number(entry.slice(first + 1, second)) || 0,
      status: statuses.get(file) ?? "modified",
      patch: patches ? await git(directory, [...args, `--unified=${context}`, "--", file]) : "",
    });
  }
  if (!committed) {
    const untracked = (await git(directory, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0");
    for (const file of untracked.filter(Boolean)) {
      const args = ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", `--unified=${context}`];
      const counts = await git(directory, [...args, "--numstat", "--", devNull, file], true);
      const [additions, deletions] = counts.split("\t");
      append({
        file,
        additions: Number(additions) || 0,
        deletions: Number(deletions) || 0,
        status: "added",
        patch: patches ? await git(directory, [...args, "--", devNull, file], true) : "",
      });
    }
  }
  return result.sort((left, right) => left.file.localeCompare(right.file));
}

/** Read-only VCS operations; the router supplies the same directory as vcs.get. */
export async function vcsRead(directory: string, operation: string, url: URL): Promise<unknown> {
  const mode = url.searchParams.get("mode");
  if (operation === "diff" && !["working", "branch", "committed"].includes(mode ?? "")) {
    throw new VcsError("mode must be working, branch, or committed");
  }
  const context = operation === "diff" ? nonNegativeInteger(url, "context", 3) : 0;
  const limit = operation === "branch" ? nonNegativeInteger(url, "limit", 100) : 0;
  try {
    let root: string;
    try {
      root = (await git(directory, ["rev-parse", "--show-toplevel"])).trim();
    } catch (error) {
      if (
        error instanceof Error &&
        "stderr" in error &&
        typeof error.stderr === "string" &&
        error.stderr.startsWith("fatal: not a git repository")
      ) {
        return operation === "base" ? null : [];
      }
      throw error;
    }
    if (operation === "base") return await base(root);
    if (operation === "branch") {
      const search = url.searchParams.get("search") ?? "";
      return (await git(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]))
        .split("\n")
        .filter((name) => name !== "" && name.includes(search))
        .sort()
        .slice(0, limit);
    }
    let revision = await optionalRef(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    if (operation === "diff" && mode !== "working") {
      const requestedBase = url.searchParams.get("base") ?? (await base(root))?.name;
      if (requestedBase === undefined) throw new VcsError("No base branch is available");
      const ref = await optionalRef(root, [
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        `${requestedBase}^{commit}`,
      ]);
      if (ref === undefined) throw new VcsError("Base must identify an existing commit");
      revision = (await git(root, ["merge-base", ref, "HEAD"])).trim();
    }
    // Without HEAD, git's empty tree is the baseline for staged and untracked files.
    revision ??= (await git(root, ["hash-object", "-t", "tree", devNull])).trim();
    const files = await diffs(
      root,
      revision,
      operation === "diff" && mode === "committed",
      context,
      operation === "diff",
    );
    if (operation !== "status") return files;
    const statuses = new Map(files.map(({ patch: _patch, ...status }) => [status.file, status]));
    // Index and worktree changes can cancel in the HEAD diff while still dirty.
    const porcelain = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]);
    for (const entry of porcelain.split("\0").filter(Boolean)) {
      const file = entry.slice(3);
      if (statuses.has(file)) continue;
      const code = entry.slice(0, 2);
      statuses.set(file, {
        file,
        additions: 0,
        deletions: 0,
        status: code.includes("D") ? "deleted" : code.includes("A") || code === "??" ? "added" : "modified",
      });
    }
    return [...statuses.values()].sort((left, right) => left.file.localeCompare(right.file));
  } catch (error) {
    if (error instanceof VcsError) throw error;
    throw new VcsError(`Git VCS operation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
