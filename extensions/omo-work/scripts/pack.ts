import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SHIPPED_FILES = ["package.json", "status/index.html", "status/main.js", "service/main.js", "README.md"];
const ARCHIVE_ROOT = "antechamber-omo-work";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = process.argv[2];
if (!outfile) {
  console.error("usage: tsx extensions/omo-work/scripts/pack.ts <outfile.zip>");
  process.exit(1);
}
const missing = SHIPPED_FILES.filter((file) => !existsSync(join(root, file)));
if (missing.length > 0) {
  console.error(`missing ${missing.join(", ")}; run npm run build first`);
  process.exit(1);
}

// OpenChamber unwraps a zip whose only entry is a folder holding package.json.
const staging = mkdtempSync(join(tmpdir(), "omo-work-pack-"));
try {
  for (const file of SHIPPED_FILES) {
    const target = join(staging, ARCHIVE_ROOT, file);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(root, file), target);
  }
  const out = resolve(outfile);
  rmSync(out, { force: true });
  const result = spawnSync("zip", ["-qrX", out, ARCHIVE_ROOT], { cwd: staging, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  console.log(`wrote ${out}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
