import assert from "node:assert/strict";
import test from "node:test";
import { ownsSmokeWorkspace, processKind } from "../contrib/smoke/context.js";

test("detached ownership requires exact private environment and scoped cwd", () => {
  const root = "/tmp/antechamber-qa/smoke-run";
  const agent = `${root}/home/.omo/agent`;
  assert.equal(ownsSmokeWorkspace(`${root}/work`, [`HOME=${root}/home`], root, agent), true);
  assert.equal(ownsSmokeWorkspace(`${root}/work`, [`PI_CODING_AGENT_DIR=${agent}`], root, agent), true);
  assert.equal(ownsSmokeWorkspace(`${root}/work`, ["HOME=/home/user"], root, agent), false);
  assert.equal(ownsSmokeWorkspace("/home/user", [`HOME=${root}/home`], root, agent), false);
  assert.equal(ownsSmokeWorkspace(`${root}-other/work`, [`HOME=${root}/home`], root, agent), false);
  assert.equal(ownsSmokeWorkspace(`${root}/work`, [`HOME=${root}/home-other`], root, agent), false);
});

test("session RPC is distinct from detached task host supervisor and engine", () => {
  assert.equal(processKind(["bun", "cli.js", "--mode", "rpc", "--session", "qa.jsonl"]), "rpc");
  assert.equal(processKind(["bun", "cli.js", "--internal-rpc-host-supervisor"]), "task-host");
  assert.equal(processKind(["bun", "cli.js", "--mode", "rpc", "--multi-session"]), "task-host");
  assert.equal(processKind(["bun", "/private/plugin/runtime/lsp-daemon/dist/cli.js", "daemon"]), "detached-service");
  assert.equal(processKind(["node", "connector.js"]), "other");
});
