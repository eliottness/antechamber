import assert from "node:assert/strict";
import { test } from "node:test";
import { addUnreleasedChange } from "../scripts/omo-bump.js";

const HEADER = "# Changelog\n\nIntro.\n\n";
const NOTE = "- OmO 5.1.79 (engine senpi 2026.11.18-3), up from 5.1.69.";

test("addUnreleasedChange opens a Changed section in an empty [Unreleased]", () => {
  const before = `${HEADER}## [Unreleased]\n\n## [0.2.1] - 2026-10-15\n\n- old\n`;
  assert.equal(
    addUnreleasedChange(before, NOTE),
    `${HEADER}## [Unreleased]\n\n### Changed\n\n${NOTE}\n\n## [0.2.1] - 2026-10-15\n\n- old\n`,
  );
});

test("addUnreleasedChange appends to an existing Changed list and leaves other sections alone", () => {
  const before = `${HEADER}## [Unreleased]\n\n### Changed\n\n- a\n  wrapped\n\n### Fixed\n\n- b\n\n## [0.2.1] - x\n\n### Changed\n\n- old\n`;
  assert.equal(
    addUnreleasedChange(before, NOTE),
    `${HEADER}## [Unreleased]\n\n### Changed\n\n- a\n  wrapped\n${NOTE}\n\n### Fixed\n\n- b\n\n## [0.2.1] - x\n\n### Changed\n\n- old\n`,
  );
});

test("addUnreleasedChange puts Changed before other [Unreleased] sections when it is missing", () => {
  const before = `${HEADER}## [Unreleased]\n\n### Fixed\n\n- b\n`;
  assert.equal(
    addUnreleasedChange(before, NOTE),
    `${HEADER}## [Unreleased]\n\n### Changed\n\n${NOTE}\n\n### Fixed\n\n- b\n`,
  );
  assert.throws(() => addUnreleasedChange(`${HEADER}## [0.2.1]\n`, NOTE));
});

test("addUnreleasedChange fills an empty Changed heading with a properly spaced list", () => {
  const before = `${HEADER}## [Unreleased]\n\n### Changed\n\n## [0.2.1] - x\n`;
  assert.equal(
    addUnreleasedChange(before, NOTE),
    `${HEADER}## [Unreleased]\n\n### Changed\n\n${NOTE}\n\n## [0.2.1] - x\n`,
  );
});
