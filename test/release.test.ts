import assert from "node:assert/strict";
import { test } from "node:test";
import { nextPatch, notesFromSubjects, rollChangelog } from "../scripts/release.js";

const HEADER = "# Changelog\n\nIntro.\n\n";

test("nextPatch increments only the patch component", () => {
  assert.equal(nextPatch("0.2.1"), "0.2.2");
  assert.equal(nextPatch("1.9.9"), "1.9.10");
  assert.throws(() => nextPatch("1.0.0-rc.1"));
});

test("rollChangelog moves [Unreleased] notes under the new version", () => {
  const before = `${HEADER}## [Unreleased]\n\n### Fixed\n\n- fix: a\n\n## [0.2.1] - 2026-10-15\n\n- old\n`;
  const after = rollChangelog(before, "0.2.2", "2026-10-16", "- unused");
  assert.equal(
    after,
    `${HEADER}## [Unreleased]\n\n## [0.2.2] - 2026-10-16\n\n### Fixed\n\n- fix: a\n\n## [0.2.1] - 2026-10-15\n\n- old\n`,
  );
});

test("rollChangelog falls back to commit notes when [Unreleased] is empty", () => {
  const before = `${HEADER}## [Unreleased]\n\n## [0.2.1] - 2026-10-15\n\n- old\n`;
  const fallback = notesFromSubjects(["fix(api): b", "chore(release): v0.2.1", ""]);
  assert.equal(
    rollChangelog(before, "0.2.2", "2026-10-16", fallback),
    `${HEADER}## [Unreleased]\n\n## [0.2.2] - 2026-10-16\n\n- fix(api): b\n\n## [0.2.1] - 2026-10-15\n\n- old\n`,
  );
  assert.equal(notesFromSubjects(["chore(release): v0.2.1"]), "- No user-visible changes.");
});

test("rollChangelog refuses a missing [Unreleased] heading or a duplicate version", () => {
  assert.throws(() => rollChangelog(`${HEADER}## [0.2.1]\n`, "0.2.2", "2026-10-16", "- x"));
  assert.throws(() => rollChangelog(`${HEADER}## [Unreleased]\n\n## [0.2.2] - x\n`, "0.2.2", "2026-10-16", "- x"));
});
