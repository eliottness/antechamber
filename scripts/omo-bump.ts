// Moves the omo-ai pin to the latest release (or the version given): package.json and package-lock.json through
// `npm install --save-exact`, plus a "### Changed" note under [Unreleased] in CHANGELOG.md. It does not commit; the
// OmO bump workflow does that once every check passes.
//
// usage: tsx scripts/omo-bump.ts [version]
// prints "<from> <to>" on stdout when the pin moved, and nothing when it is already at that version.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const VERSION = /^\d+\.\d+\.\d+$/;

// Adds `line` to the "### Changed" list of [Unreleased], creating that heading first if it is missing.
export function addUnreleasedChange(text: string, line: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith("## [Unreleased]"));
  if (start === -1) throw new Error("CHANGELOG.md has no '## [Unreleased]' heading");
  let end = lines.findIndex((l, i) => i > start && l.startsWith("## ["));
  if (end === -1) end = lines.length;
  const changed = lines.findIndex((l, i) => i > start && i < end && l === "### Changed");
  if (changed === -1)
    return [...lines.slice(0, start + 1), "", "### Changed", "", line, ...lines.slice(start + 1)].join("\n");
  let last = changed + 1;
  while (last + 1 < end && !lines[last + 1]!.startsWith("### ")) last++;
  while (lines[last] === "") last--;
  return [...lines.slice(0, last + 1), line, ...lines.slice(last + 1)].join("\n");
}

function npm(root: string, args: readonly string[]): string {
  return execFileSync("npm", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

function main(argv: readonly string[]): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies: Record<string, string> };
  const from = pkg.dependencies["omo-ai"];
  if (from === undefined) throw new Error("package.json does not depend on omo-ai");
  const to = argv[0] || npm(root, ["view", "omo-ai", "version"]);
  if (!VERSION.test(to)) throw new Error(`not a plain X.Y.Z omo-ai version: ${to}`);
  if (to === from) return;

  // OmO's postinstall prepares its engine; the launcher's install runs it, the pin update does not need it.
  npm(root, ["install", "--save-exact", "--ignore-scripts", "--no-audit", "--no-fund", `omo-ai@${to}`]);
  const engine = npm(root, ["view", `omo-ai@${to}`, "dependencies.@code-yeongyu/senpi"]);
  const changelogPath = join(root, "CHANGELOG.md");
  const note = `- OmO ${to}${engine === "" ? "" : ` (engine senpi ${engine})`}, up from ${from}.`;
  writeFileSync(changelogPath, addUnreleasedChange(readFileSync(changelogPath, "utf8"), note));
  console.log(`${from} ${to}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2));
