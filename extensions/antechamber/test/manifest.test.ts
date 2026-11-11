import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseManifest } from "@openchamber/sdk/schemas";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

test("OpenChamber 2.x accepts the one manifest: Graph panel and page, Work section, tool headers, host service", () => {
  const result = parseManifest(pkg);
  assert.ok(result.ok, JSON.stringify(result));
  const { contributes } = result.manifest;
  const page = contributes.page as { entry?: string } | undefined;
  const section = contributes.statusSection as { entry?: string } | undefined;
  assert.equal(contributes.panel.id, "antechamber");
  assert.equal(contributes.panel.entry, "panel/index.html");
  assert.equal(page?.entry, "panel/index.html");
  assert.equal(section?.entry, "status/index.html");
  assert.deepEqual(contributes.service, { entry: "service/main.js", runtime: "host", permissions: { exec: ["bun"] } });
  assert.deepEqual(
    contributes.tools?.map((tool) => tool.match),
    ["shell", "task", "agent"],
  );
  for (const file of [contributes.panel.entry, section?.entry, contributes.panel.icon])
    assert.ok(file && existsSync(join(root, file)), `${file} is missing`);
});

test("the extension requires OpenChamber 2.3.2, the first release with Work Status sections", () => {
  assert.equal(pkg.openchamber.engines.openchamber, ">=2.3.2");
});
