// Publishes the release's extension zips as Git branches whose root is the
// extension, one commit per release on top of the previous one:
//
//   antechamber-omo-graph.zip  -> extension/omo-graph
//   antechamber-omo-work.zip   -> extension/omo-work
//   antechamber-omo-compat.zip -> extension/omo-compat
//
// OpenChamber installs a Git URL such as
// https://github.com/eliottness/antechamber#extension/omo-graph by cloning that
// branch, and it checks only Git installs for updates: it compares the
// package.json version at the branch tip with the installed one. Each branch
// holds exactly the files of its zip. The working tree, the index and HEAD are
// left alone, and a zip identical to the branch tip publishes nothing, so the
// step can be re-run.
//
// usage: tsx scripts/publish-extension-branches.ts <directory holding the zips>
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const EXTENSION_BRANCHES = [
  { archive: "antechamber-omo-graph.zip", branch: "extension/omo-graph" },
  { archive: "antechamber-omo-work.zip", branch: "extension/omo-work" },
  { archive: "antechamber-omo-compat.zip", branch: "extension/omo-compat" },
] as const;

const REMOTE = "origin";

function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = {}): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function commitOf(repo: string, ref: string): string | undefined {
  const result = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    cwd: repo,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

export function publishExtensionBranches(repo: string, archives: string): string[] {
  const git = (args: readonly string[]): string => run("git", args, repo);
  const gitDir = git(["rev-parse", "--absolute-git-dir"]);
  const source = git(["rev-parse", "HEAD"]);
  git(["fetch", "--no-tags", REMOTE, `+refs/heads/extension/*:refs/remotes/${REMOTE}/extension/*`]);
  const refspecs: string[] = [];
  const lines: string[] = [];
  for (const { archive, branch } of EXTENSION_BRANCHES) {
    const scratch = mkdtempSync(join(tmpdir(), "antechamber-extension-branch-"));
    try {
      const unpacked = join(scratch, "unpacked");
      run("unzip", ["-q", join(archives, archive), "-d", unpacked], repo);
      // The pack steps wrap the extension in a single folder; that folder becomes the branch root.
      const [folder, ...rest] = readdirSync(unpacked);
      if (folder === undefined || rest.length > 0) throw new Error(`${archive} must hold exactly one folder`);
      const root = join(unpacked, folder);
      const index = { GIT_INDEX_FILE: join(scratch, "index") };
      // --force: the branch ships what the zip ships, whatever an ignore rule says.
      run("git", ["--git-dir", gitDir, "--work-tree", root, "add", "--all", "--force", "."], root, index);
      const tree = run("git", ["--git-dir", gitDir, "write-tree"], root, index);
      const parent = commitOf(repo, `refs/remotes/${REMOTE}/${branch}`);
      if (parent !== undefined && git(["rev-parse", `${parent}^{tree}`]) === tree) {
        lines.push(`${branch}: unchanged`);
        continue;
      }
      const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
      const commit = git([
        "commit-tree",
        tree,
        ...(parent === undefined ? [] : ["-p", parent]),
        "-m",
        `${folder} v${version}`,
        "-m",
        `Built from ${source}.`,
      ]);
      refspecs.push(`${commit}:refs/heads/${branch}`);
      lines.push(`${branch}: ${folder} v${version}`);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  if (refspecs.length > 0) git(["push", "--atomic", REMOTE, ...refspecs]);
  return lines;
}

function main(argv: readonly string[]): void {
  const archives = argv[0];
  if (archives === undefined) throw new Error("usage: tsx scripts/publish-extension-branches.ts <zip directory>");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  for (const line of publishExtensionBranches(root, resolve(archives))) console.log(line);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2));
