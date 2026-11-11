import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseManifest } from "@openchamber/sdk/schemas";
import { rootManifest } from "../scripts/root-manifest.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const readJson = (path: string) => JSON.parse(readFileSync(join(repo, path), "utf8"));
const rootPackage = readJson("package.json");

/** Mode of each path in the git index: what `git clone` of the repository, and so a Git install, receives. */
function tracked(paths: string[]): Map<string, string> {
  const out = execFileSync("git", ["ls-files", "-s", "--", ...paths], { cwd: repo, encoding: "utf8" });
  return new Map(
    out
      .split("\n")
      .filter(Boolean)
      .map((line) => [line.split("\t")[1] ?? "", line.split(" ")[0] ?? ""]),
  );
}

test("the repository root is the extension OpenChamber installs from https://github.com/eliottness/antechamber", () => {
  const result = parseManifest(rootPackage);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.manifest.contributes.panel.id, "antechamber");
  assert.deepEqual(rootPackage.openchamber, rootManifest(readJson("extensions/antechamber/package.json").openchamber));
});

test("a clone of the repository holds every file the root manifest loads, with the launcher executable", () => {
  const { panel, page, statusSection, service } = rootPackage.openchamber.contributes;
  const pages = [panel.entry, page.entry, statusSection.entry] as string[];
  const scripts = pages.flatMap((html) =>
    [...readFileSync(join(repo, html), "utf8").matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((match) =>
      posix.join(posix.dirname(html), match[1] ?? ""),
    ),
  );
  const launcher = "extensions/antechamber/bin/opencode-antechamber";
  const needed = [
    panel.icon,
    ...pages,
    ...scripts,
    service.entry,
    "extensions/antechamber/runtime/launcher.js",
    launcher,
  ];
  const index = tracked(needed);
  assert.deepEqual(
    needed.filter((path) => !index.has(path)),
    [],
    "not committed, so a Git install would miss it",
  );
  assert.equal(index.get(launcher), "100755");
});
