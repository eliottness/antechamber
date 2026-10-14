import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function config(path: string): { compilerOptions: { lib: string[] } } {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as { compilerOptions: { lib: string[] } };
}

test("R-064: build and typecheck use the same JavaScript library surface", () => {
  const build = config("../tsconfig.json");
  const check = config("../tsconfig.check.json");
  assert.deepEqual(build.compilerOptions.lib, check.compilerOptions.lib);
});
