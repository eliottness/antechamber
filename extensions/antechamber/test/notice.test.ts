import assert from "node:assert/strict";
import { test } from "node:test";
import { runtimeNotice } from "../src/runtime/notice.ts";
import type { RuntimeStatus } from "../src/service.ts";

const ready: RuntimeStatus = {
  state: "ready",
  spec: "2.0.0",
  launcher: "/data/extensions/antechamber/bin/opencode-antechamber",
  bun: "/bin/bun",
  antechamber: "2.0.0",
  settings: "/data/settings.json",
  configured: "/data/extensions/antechamber/bin/opencode-antechamber",
  active: true,
  needsReload: false,
};

test("no notice once OpenChamber runs antechamber", () => {
  assert.equal(runtimeNotice(ready), undefined);
});

test("a fresh switch asks for Restart OpenCode, with no button to press", () => {
  const notice = runtimeNotice({ ...ready, needsReload: true });
  assert.equal(notice?.tone, "info");
  assert.equal(notice?.action, undefined);
});

test("a custom OpenCode CLI gets the button that switches to antechamber", () => {
  const notice = runtimeNotice({ ...ready, active: false, configured: "/usr/local/bin/opencode" });
  assert.equal(notice?.tone, "warn");
  assert.equal(notice?.action?.path, "activate");
  assert.match(notice?.text ?? "", /\/usr\/local\/bin\/opencode/);
});

test("a folder install gets the launcher path to paste instead of a button", () => {
  const notice = runtimeNotice({ ...ready, active: false, configured: null, settings: null });
  assert.equal(notice?.action, undefined);
  assert.equal(notice?.code, ready.launcher);
});

test("installing shows progress; a failed install offers a retry only when Bun exists", () => {
  assert.equal(runtimeNotice({ ...ready, state: "installing", active: false })?.action, undefined);
  assert.equal(runtimeNotice({ ...ready, state: "failed", error: "404" })?.action?.path, "install");
  assert.equal(runtimeNotice({ ...ready, state: "failed", bun: null, error: "bun not found" })?.action, undefined);
});
