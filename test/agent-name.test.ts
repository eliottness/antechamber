import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();
const probe =
  "import { getExposedAgentNames } from './src/agent-name.ts'; console.log(JSON.stringify(getExposedAgentNames()));";
const legacyProbe = `
  import { AdapterServer } from './src/server.ts';
  const server = new AdapterServer({ host: '127.0.0.1', port: 0, defaultDirectory: process.env.ANTECHAMBER_TEST_DIRECTORY });
  try {
    await server.start();
    const created = await fetch(\`\${server.url}/api/session\`, { method: 'POST', body: '{}' });
    const session = (await created.json()).data;
    const prompt = await fetch(\`\${server.url}/api/session/\${session.id}/prompt\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'build', text: 'legacy build agent prompt' }),
    });
    const alias = await fetch(\`\${server.url}/api/agent/build\`);
    console.log(JSON.stringify({ prompt: prompt.status, alias: alias.status }));
  } finally {
    await server.stop();
  }
`;

function exposedNames(env: NodeJS.ProcessEnv): string[] {
  return JSON.parse(
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", probe], {
      cwd: root,
      env: { ...process.env, ...env },
      encoding: "utf8",
    }),
  ) as string[];
}

for (const variable of ["PI_CODING_AGENT_DIR", "OMO_CODING_AGENT_DIR"]) {
  test(`agent name reads overridden ${variable} and string-safe block comments`, (t) => {
    const home = mkdtempSync(join(tmpdir(), "antechamber-agent-config-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const agentDir = join(home, "custom", "agent");
    mkdirSync(agentDir, { recursive: true });
    const name = 'https://example.test/*agent*/"quoted"';
    writeFileSync(
      join(home, "custom", "oh-my-pi.jsonc"),
      `{
      /* orchestrator settings
         with "quotes" and // nested line markers */
      "orchestrator": { "agentName": ${JSON.stringify(name)} /* trailing comment */ }
      // final line comment
    }`,
    );
    assert.deepEqual(
      exposedNames({
        HOME: home,
        ANTECHAMBER_AGENT: "",
        OCPI_AGENT: "",
        PI_CODING_AGENT_DIR: "",
        OMO_CODING_AGENT_DIR: "",
        [variable]: agentDir,
      }),
      [name, "build"],
    );
  });

  test(`agent name detects packages under overridden ${variable}`, (t) => {
    const home = mkdtempSync(join(tmpdir(), "antechamber-agent-packages-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const agentDir = join(home, "custom", "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:oh-my-pi"] }));
    assert.deepEqual(
      exposedNames({
        HOME: home,
        ANTECHAMBER_AGENT: "",
        OCPI_AGENT: "",
        PI_CODING_AGENT_DIR: "",
        OMO_CODING_AGENT_DIR: "",
        [variable]: agentDir,
      }),
      ["oh-my-pi", "build"],
    );
  });
}

test("resolved OmO agent is first and build remains a compatibility alias", () => {
  const home = mkdtempSync(join(tmpdir(), "antechamber-agent-name-"));
  try {
    assert.deepEqual(exposedNames({ HOME: home, ANTECHAMBER_AGENT: "OmO" }), ["OmO", "build"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a default OmO install is detected from ~/.omo/omo.jsonc", (t) => {
  const home = mkdtempSync(join(tmpdir(), "antechamber-agent-omo-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, ".omo", "agent"), { recursive: true });
  writeFileSync(join(home, ".omo", "omo.jsonc"), "{}");
  assert.deepEqual(exposedNames({ HOME: home, ANTECHAMBER_AGENT: "" }), ["OmO", "build"]);
});

test("no resolved agent exposes only build", () => {
  const home = mkdtempSync(join(tmpdir(), "antechamber-agent-name-"));
  try {
    assert.deepEqual(exposedNames({ HOME: home, ANTECHAMBER_AGENT: "" }), ["build"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a legacy build-agent session still accepts a prompt", () => {
  const state = mkdtempSync(join(tmpdir(), "antechamber-agent-state-"));
  try {
    const result = JSON.parse(
      execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", legacyProbe], {
        cwd: root,
        env: {
          ...process.env,
          ANTECHAMBER_AGENT: "OmO",
          ANTECHAMBER_PI_BINARY: join(root, "test/fixtures/fake-omo-endpoints.mjs"),
          ANTECHAMBER_STATE_DIR: state,
          ANTECHAMBER_TEST_DIRECTORY: state,
        },
        encoding: "utf8",
      }),
    ) as { prompt: number; alias: number };
    assert.deepEqual(result, { prompt: 200, alias: 200 });
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

const configProbe = `
  import { AdapterServer } from './src/server.ts';
  const server = new AdapterServer({ host: '127.0.0.1', port: 0, defaultDirectory: process.env.ANTECHAMBER_TEST_DIRECTORY });
  try {
    await server.start();
    const v2Config = await fetch(\`\${server.url}/api/config\`).then(r => r.json());
    const v2Agents = await fetch(\`\${server.url}/api/agent\`).then(r => r.json());
    console.log(JSON.stringify({ v2Config, v2Agents }));
  } finally {
    await server.stop();
  }
`;

function fetchConfigs(env: NodeJS.ProcessEnv): {
  v2Config: unknown;
  v2Agents: unknown[];
} {
  return JSON.parse(
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", configProbe], {
      cwd: root,
      env: { ...process.env, ...env },
      encoding: "utf8",
    }),
  ) as { v2Config: unknown; v2Agents: unknown[] };
}

test("config includes default_agent with resolved OmO name", () => {
  const state = mkdtempSync(join(tmpdir(), "antechamber-config-"));
  try {
    const result = fetchConfigs({
      HOME: state,
      ANTECHAMBER_AGENT: "OmO",
      ANTECHAMBER_PI_BINARY: join(root, "test/fixtures/fake-omo-endpoints.mjs"),
      ANTECHAMBER_STATE_DIR: state,
      ANTECHAMBER_TEST_DIRECTORY: state,
    });
    // v2 /api/config returns the OpenCode 2.x bare ConfigEntry[] that OpenChamber folds by document `info`.
    assert.deepEqual(result.v2Config, [{ type: "document", path: "antechamber", info: { default_agent: "OmO" } }]);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test("build agent is hidden when OmO is resolved", () => {
  const state = mkdtempSync(join(tmpdir(), "antechamber-agents-hidden-"));
  try {
    const result = fetchConfigs({
      HOME: state,
      ANTECHAMBER_AGENT: "OmO",
      ANTECHAMBER_PI_BINARY: join(root, "test/fixtures/fake-omo-endpoints.mjs"),
      ANTECHAMBER_STATE_DIR: state,
      ANTECHAMBER_TEST_DIRECTORY: state,
    });
    const agents = (
      result.v2Agents as unknown as { data: [{ name: string; hidden: boolean }, { name: string; hidden: boolean }] }
    ).data;
    assert.equal(agents.length, 2, "v2: should expose [OmO, build]");
    assert.equal(agents[0].name, "OmO");
    assert.equal(agents[0].hidden, false, "v2: OmO should be visible");
    assert.equal(agents[1].name, "build");
    assert.equal(agents[1].hidden, true, "v2: build should be hidden");
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

type AgentDefaults = Array<{ model?: unknown; variant?: unknown }>;

function agentDefaultsFor(level: string): { v2: AgentDefaults } {
  const state = mkdtempSync(join(tmpdir(), "antechamber-agent-effort-"));
  try {
    const result = fetchConfigs({
      HOME: state,
      ANTECHAMBER_AGENT: "OmO",
      ANTECHAMBER_PI_BINARY: join(root, "test/fixtures/fake-omo-endpoints.mjs"),
      ANTECHAMBER_STATE_DIR: state,
      ANTECHAMBER_TEST_DIRECTORY: state,
      FAKE_THINKING_LEVEL: level,
    });
    const v2 = (result.v2Agents as unknown as { data: AgentDefaults }).data;
    assert.equal(v2.length, 2);
    return { v2 };
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
}

test("agents advertise OmO's resolved model and thinking level as their default", () => {
  const { v2 } = agentDefaultsFor("medium");
  // OpenCode 2.x nests the level in the agent's ModelRef, the only place OpenChamber 2.x reads it.
  for (const agent of v2) {
    assert.deepEqual(agent.model, { id: "fake-model", providerID: "fake", variant: "medium" });
    assert.equal(agent.variant, undefined);
  }
});

test("a thinking level the model does not offer is not advertised", () => {
  const { v2 } = agentDefaultsFor("off");
  for (const agent of v2) assert.deepEqual(agent.model, { id: "fake-model", providerID: "fake" });
});

test("build agent is visible when no OmO name is resolved", () => {
  const state = mkdtempSync(join(tmpdir(), "antechamber-build-visible-"));
  try {
    const result = fetchConfigs({
      HOME: state,
      ANTECHAMBER_AGENT: "",
      ANTECHAMBER_PI_BINARY: join(root, "test/fixtures/fake-omo-endpoints.mjs"),
      ANTECHAMBER_STATE_DIR: state,
      ANTECHAMBER_TEST_DIRECTORY: state,
    });
    const agents = (
      result.v2Agents as unknown as { data: [{ name: string; hidden: boolean }, { name: string; hidden: boolean }] }
    ).data;
    assert.equal(agents.length, 1, "v2: should expose only [build]");
    assert.equal(agents[0].name, "build");
    assert.equal(agents[0].hidden, false, "v2: build should be visible when it's the default");
    assert.deepEqual(result.v2Config, [{ type: "document", path: "antechamber", info: { default_agent: "build" } }]);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});
