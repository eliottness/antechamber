// Prepares a patch release in the working tree: bumps package.json,
// package-lock.json and the OmO Graph extension to the next patch version and
// moves the CHANGELOG [Unreleased] notes under a new version heading. It does
// not commit, tag or publish; the release workflow does that.
//
// usage: tsx scripts/release.ts [--date YYYY-MM-DD]
// prints the new version on stdout.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RELEASE_SUBJECT = /^chore\(release\):/;

export function nextPatch(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null) throw new Error(`not a plain X.Y.Z version: ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

export function notesFromSubjects(subjects: readonly string[]): string {
  const kept = subjects.map((s) => s.trim()).filter((s) => s !== "" && !RELEASE_SUBJECT.test(s));
  return kept.length > 0 ? kept.map((s) => `- ${s}`).join("\n") : "- No user-visible changes.";
}

// Moves the [Unreleased] body under "## [version] - date" and leaves an empty
// [Unreleased] heading. An empty [Unreleased] body falls back to `fallbackNotes`.
export function rollChangelog(text: string, version: string, date: string, fallbackNotes: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.startsWith("## [Unreleased]"));
  if (start === -1) throw new Error("CHANGELOG.md has no '## [Unreleased]' heading");
  if (lines.some((line) => line.startsWith(`## [${version}]`)))
    throw new Error(`CHANGELOG.md already has a '## [${version}]' section`);
  let end = lines.findIndex((line, i) => i > start && line.startsWith("## ["));
  if (end === -1) end = lines.length;
  const body = lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
  const notes = body === "" ? fallbackNotes.trim() : body;
  const section = ["## [Unreleased]", "", `## [${version}] - ${date}`, "", notes, ""];
  return [...lines.slice(0, start), ...section, ...lines.slice(end)].join("\n");
}

function git(root: string, args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

function subjectsSinceLastTag(root: string): string[] {
  const tags = git(root, ["tag", "--list", "v*.*.*", "--merged", "HEAD", "--sort=-v:refname"]).split("\n");
  const last = tags.find((tag) => tag !== "");
  const range = last === undefined ? ["HEAD"] : [`${last}..HEAD`];
  return git(root, ["log", "--no-merges", "--format=%s", ...range]).split("\n");
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function main(argv: readonly string[]): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const dateFlag = argv.indexOf("--date");
  const date = dateFlag === -1 ? new Date().toISOString().slice(0, 10) : argv[dateFlag + 1];
  if (date === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("--date expects YYYY-MM-DD");

  const pkgPath = join(root, "package.json");
  const pkg = readJson(pkgPath);
  const version = nextPatch(String(pkg.version));

  pkg.version = version;
  writeJson(pkgPath, pkg);

  const lockPath = join(root, "package-lock.json");
  const lock = readJson(lockPath);
  lock.version = version;
  const packages = lock.packages as Record<string, Record<string, unknown>> | undefined;
  const rootPackage = packages?.[""];
  if (rootPackage === undefined) throw new Error("package-lock.json has no root package entry");
  rootPackage.version = version;
  writeJson(lockPath, lock);

  for (const extension of ["omo-dag", "omo-work", "omo-compat"]) {
    const extPath = join(root, "extensions", extension, "package.json");
    const ext = readJson(extPath);
    ext.version = version;
    writeJson(extPath, ext);
  }

  const changelogPath = join(root, "CHANGELOG.md");
  const fallback = notesFromSubjects(subjectsSinceLastTag(root));
  writeFileSync(changelogPath, rollChangelog(readFileSync(changelogPath, "utf8"), version, date, fallback));

  console.log(version);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2));
