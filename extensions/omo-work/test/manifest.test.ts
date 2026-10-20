import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseManifest } from "@openchamber/sdk-v2/schemas";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("OpenChamber 2.x accepts the manifest as a status section with a host service and no rail panel", () => {
  const result = parseManifest(JSON.parse(readFileSync(join(root, "package.json"), "utf8")));
  assert.ok(result.ok, JSON.stringify(result));
  const { contributes } = result.manifest;
  assert.equal(contributes.panel?.entry, undefined);
  assert.deepEqual(contributes.service, { entry: "service/main.js", runtime: "host" });
  assert.equal(typeof contributes.statusSection, "object");
  const section = contributes.statusSection as { entry: string };
  assert.ok(existsSync(join(root, section.entry)));
});
