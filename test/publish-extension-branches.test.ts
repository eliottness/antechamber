import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EXTENSION_BRANCHES, publishExtensionBranches } from "../scripts/publish-extension-branches.js";

// The script inherits this environment; keep the developer's git config out of it.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

function run(cwd: string, command: string, ...args: string[]): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `${command} ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

// One release's zips, laid out like the pack steps write them: one folder holding the extension.
function writeArchives(parent: string, version: string): string {
  const dir = mkdtempSync(join(parent, "zips-"));
  for (const { archive } of EXTENSION_BRANCHES) {
    const folder = archive.replace(/\.zip$/, "");
    mkdirSync(join(dir, folder, "panel"), { recursive: true });
    writeFileSync(join(dir, folder, "package.json"), `${JSON.stringify({ name: folder, version })}\n`);
    writeFileSync(join(dir, folder, "panel", "main.js"), `// ${folder}\n`);
    run(dir, "zip", "-qrX", archive, folder);
  }
  return dir;
}

test("publishExtensionBranches puts each zip's folder at its branch root, one commit per release", (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "extension-branches-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const remote = join(scratch, "remote.git");
  const repo = join(scratch, "repo");
  run(scratch, "git", "init", "-q", "--bare", remote);
  run(scratch, "git", "init", "-q", "-b", "main", repo);
  run(repo, "git", "config", "user.name", "Release Test");
  run(repo, "git", "config", "user.email", "release@example.invalid");
  run(repo, "git", "config", "commit.gpgsign", "false");
  run(repo, "git", "commit", "-q", "--allow-empty", "-m", "chore(release): v1.0.1");
  run(repo, "git", "remote", "add", "origin", remote);
  const tips = () => EXTENSION_BRANCHES.map(({ branch }) => run(remote, "git", "rev-parse", branch));
  const version = (branch: string) => JSON.parse(run(remote, "git", "show", `${branch}:package.json`)).version;

  publishExtensionBranches(repo, writeArchives(scratch, "1.0.1"));
  for (const { branch } of EXTENSION_BRANCHES) {
    const files = run(remote, "git", "ls-tree", "-r", "--name-only", branch).split("\n");
    assert.deepEqual(files, ["package.json", "panel/main.js"]);
    assert.equal(version(branch), "1.0.1");
  }
  const first = tips();

  // Re-running a release publishes nothing.
  assert.deepEqual(
    publishExtensionBranches(repo, writeArchives(scratch, "1.0.1")),
    EXTENSION_BRANCHES.map(({ branch }) => `${branch}: unchanged`),
  );
  assert.deepEqual(tips(), first);

  // The next release fast-forwards every branch.
  publishExtensionBranches(repo, writeArchives(scratch, "1.0.2"));
  EXTENSION_BRANCHES.forEach(({ branch }, i) => {
    assert.equal(run(remote, "git", "rev-parse", `${branch}^`), first[i]);
    assert.equal(version(branch), "1.0.2");
  });
  assert.equal(run(repo, "git", "status", "--porcelain"), "");
  assert.equal(run(repo, "git", "rev-list", "--count", "HEAD"), "1");
});
