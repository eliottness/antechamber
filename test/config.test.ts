import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentBinary, bundledOmo, defaultStateDir, envSetting } from "../src/config.js";

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("envSetting prefers ANTECHAMBER_ and falls back to legacy OCPI_", () => {
  withEnv({ ANTECHAMBER_X_TEST: "new", OCPI_X_TEST: "old" }, () => assert.equal(envSetting("X_TEST"), "new"));
  withEnv({ ANTECHAMBER_X_TEST: undefined, OCPI_X_TEST: "old" }, () => assert.equal(envSetting("X_TEST"), "old"));
  withEnv({ ANTECHAMBER_X_TEST: "  ", OCPI_X_TEST: undefined }, () => assert.equal(envSetting("X_TEST"), undefined));
});

test("defaultStateDir keeps the legacy directory only when the new one is absent", () => {
  const home = mkdtempSync(join(tmpdir(), "antechamber-config-"));
  try {
    withEnv({ HOME: home }, () => {
      assert.equal(defaultStateDir(), join(home, ".config", "antechamber"));
      mkdirSync(join(home, ".config", "openchamber-pi-connector"), { recursive: true });
      assert.equal(defaultStateDir(), join(home, ".config", "openchamber-pi-connector"));
      mkdirSync(join(home, ".config", "antechamber"), { recursive: true });
      assert.equal(defaultStateDir(), join(home, ".config", "antechamber"));
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the agent is ANTECHAMBER_PI_BINARY, else the OmO antechamber pins, else omo on PATH", () => {
  assert.equal(
    agentBinary({ ANTECHAMBER_PI_BINARY: "/opt/pi" }, () => "/pinned/omo.js"),
    "/opt/pi",
  );
  assert.equal(
    agentBinary({}, () => "/pinned/omo.js"),
    "/pinned/omo.js",
  );
  assert.equal(
    agentBinary({}, () => undefined),
    "omo",
  );
  assert.match(bundledOmo() ?? "", /node_modules[/\\]omo-ai[/\\]bin[/\\]omo\.js$/);
});
