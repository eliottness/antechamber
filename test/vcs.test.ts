import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { AdapterServer } from "../src/server.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function fixture(t: TestContext, repository = true) {
  const directory = mkdtempSync(join(tmpdir(), "antechamber-vcs-"));
  const repo = join(directory, "repo");
  mkdirSync(repo);
  const previousState = process.env.ANTECHAMBER_STATE_DIR;
  process.env.ANTECHAMBER_STATE_DIR = join(directory, "state");
  const server = new AdapterServer({ host: "127.0.0.1", port: 0, defaultDirectory: directory });
  t.after(async () => {
    try {
      await server.stop();
    } finally {
      if (previousState === undefined) delete process.env.ANTECHAMBER_STATE_DIR;
      else process.env.ANTECHAMBER_STATE_DIR = previousState;
      rmSync(directory, { recursive: true, force: true });
    }
  });
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    }).trim();
  if (repository) {
    git("init", "-q", "-b", "main");
    git("config", "user.name", "VCS Test");
    git("config", "user.email", "vcs@example.invalid");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(repo, "modified.txt"), "before\n");
    writeFileSync(join(repo, "deleted.txt"), "deleted\n");
    git("add", "--", ".");
    git("commit", "-qm", "initial");
  }
  await server.start();
  const request = async (route: string, query: Record<string, string> = {}) => {
    const params = new URLSearchParams({ "location[directory]": repo, ...query });
    return fetch(`${server.url}/api/vcs/${route}?${params}`);
  };
  const get = async (route: string, query: Record<string, string> = {}) => {
    const response = await request(route, query);
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json();
    assert.ok(isRecord(body));
    assert.deepEqual(body.location, { directory: repo });
    return body.data;
  };
  return { repo, git, get, request };
}

test("VCS status reports staged, unstaged and untracked changes without updating the index", async (t) => {
  const { repo, git, get } = await fixture(t);
  writeFileSync(join(repo, "modified.txt"), "after\nanother\n");
  rmSync(join(repo, "deleted.txt"));
  writeFileSync(join(repo, "added.txt"), "staged\n");
  git("add", "--", "added.txt");
  writeFileSync(join(repo, "untracked\nfile.txt"), "untracked\n");
  const index = readFileSync(join(repo, ".git", "index"));

  const data = await get("status");

  assert.deepEqual(data, [
    { file: "added.txt", additions: 1, deletions: 0, status: "added" },
    { file: "deleted.txt", additions: 0, deletions: 1, status: "deleted" },
    { file: "modified.txt", additions: 2, deletions: 1, status: "modified" },
    { file: "untracked\nfile.txt", additions: 1, deletions: 0, status: "added" },
  ]);
  assert.deepEqual(readFileSync(join(repo, ".git", "index")), index);
});

test("VCS working diff returns FileDiffInfo records including untracked files", async (t) => {
  const { repo, git, get } = await fixture(t);
  writeFileSync(join(repo, "modified.txt"), "after\n");
  rmSync(join(repo, "deleted.txt"));
  writeFileSync(join(repo, "added.txt"), "staged\n");
  git("add", "--", "added.txt");
  writeFileSync(join(repo, "untracked.txt"), "new\n");

  const data = await get("diff", { mode: "working", context: "0" });

  assert.ok(Array.isArray(data));
  assert.equal(data.length, 4);
  for (const entry of data) {
    assert.deepEqual(Object.keys(entry).sort(), ["additions", "deletions", "file", "patch", "status"]);
    assert.match(entry.patch, /^diff --git /);
  }
  assert.match(data.find((entry: { file: string }) => entry.file === "modified.txt").patch, /-before\n\+after/);
  assert.match(data.find((entry: { file: string }) => entry.file === "untracked.txt").patch, /\+new/);
});

test("VCS branch listing honors search and limit", async (t) => {
  const { git, get } = await fixture(t);
  git("branch", "feature/one");
  git("branch", "feature/two");

  assert.deepEqual(await get("branch"), ["feature/one", "feature/two", "main"]);
  assert.deepEqual(await get("branch", { search: "feature/", limit: "1" }), ["feature/one"]);
  assert.deepEqual(await get("branch", { limit: "0" }), []);
});

test("VCS base reports the default branch and its resolved commit", async (t) => {
  const { git, get } = await fixture(t);

  assert.deepEqual(await get("base"), { name: "main", ref: git("rev-parse", "main"), source: "default" });
});

test("VCS base follows the branch checkout reflog", async (t) => {
  const { git, get } = await fixture(t);
  git("checkout", "-qb", "feature");

  assert.deepEqual(await get("base"), { name: "main", ref: git("rev-parse", "main"), source: "reflog" });
});

test("VCS branch and committed diffs distinguish working changes from commits", async (t) => {
  const { repo, git, get } = await fixture(t);
  git("checkout", "-qb", "feature");
  writeFileSync(join(repo, "committed.txt"), "committed\n");
  git("add", "--", ".");
  git("commit", "-qm", "feature change");
  writeFileSync(join(repo, "modified.txt"), "working\n");

  const committed = await get("diff", { mode: "committed", base: "main" });
  const branch = await get("diff", { mode: "branch", base: "main" });

  assert.ok(Array.isArray(committed));
  assert.ok(Array.isArray(branch));
  assert.deepEqual(
    committed.map((entry: { file: string }) => entry.file),
    ["committed.txt"],
  );
  assert.deepEqual(
    branch.map((entry: { file: string }) => entry.file),
    ["committed.txt", "modified.txt"],
  );
  assert.deepEqual(await get("diff", { mode: "committed" }), committed);
});

test("VCS routes return empty inventories and null base outside a repository", async (t) => {
  const { get } = await fixture(t, false);

  assert.deepEqual(await get("status"), []);
  assert.deepEqual(await get("diff", { mode: "working" }), []);
  assert.deepEqual(await get("branch"), []);
  assert.equal(await get("base"), null);
});

test("VCS routes handle an unborn HEAD", async (t) => {
  const { repo, git, get } = await fixture(t, false);
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "added.txt"), "new\n");
  git("add", "--", ".");

  assert.deepEqual(await get("status"), [{ file: "added.txt", additions: 1, deletions: 0, status: "added" }]);
  const diff = await get("diff", { mode: "working" });
  assert.ok(Array.isArray(diff));
  assert.equal(diff[0].status, "added");
  assert.equal(await get("base"), null);
});

test("VCS status handles renamed and binary files", async (t) => {
  const { repo, git, get } = await fixture(t);
  renameSync(join(repo, "modified.txt"), join(repo, "renamed.txt"));
  writeFileSync(join(repo, "binary.dat"), Buffer.from([0, 1, 2]));
  git("add", "--", ".");

  const data = await get("status");

  assert.ok(Array.isArray(data));
  assert.ok(data.some((entry: { file: string }) => entry.file === "renamed.txt"));
  assert.deepEqual(
    data.find((entry: { file: string }) => entry.file === "binary.dat"),
    {
      file: "binary.dat",
      additions: 0,
      deletions: 0,
      status: "added",
    },
  );
});

test("VCS invalid queries and git failures return typed errors", async (t) => {
  const { repo, request } = await fixture(t);
  for (const [route, query] of [
    ["diff", { mode: "invalid" }],
    ["diff", { mode: "working", context: "-1" }],
    ["diff", { mode: "committed", base: "--output=unsafe" }],
    ["branch", { limit: "-1" }],
  ] satisfies Array<[string, Record<string, string>]>) {
    const response = await request(route, query);
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.ok(isRecord(body));
    assert.equal(body.name, "BadRequestError");
  }
  writeFileSync(join(repo, ".git", "index"), "corrupted");

  const response = await request("status");

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.ok(isRecord(body));
  assert.equal(body.name, "BadRequestError");
  assert.ok(isRecord(body.data));
  assert.equal(typeof body.data.message, "string");
});

test("VCS status preserves staged changes cancelled by the working tree", async (t) => {
  const { repo, git, get } = await fixture(t);
  writeFileSync(join(repo, "modified.txt"), "staged\n");
  git("add", "--", "modified.txt");
  writeFileSync(join(repo, "modified.txt"), "before\n");

  assert.deepEqual(await get("status"), [{ file: "modified.txt", additions: 0, deletions: 0, status: "modified" }]);
});
