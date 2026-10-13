import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();
const probe = "import { getExposedAgentNames } from './src/agent-name.ts'; console.log(JSON.stringify(getExposedAgentNames()));";
const legacyProbe = `
  import { AdapterServer } from './src/server.ts';
  const server = new AdapterServer({ host: '127.0.0.1', port: 0, defaultDirectory: process.env.ANTECHAMBER_TEST_DIRECTORY });
  try {
    await server.start();
    const created = await fetch(\`\${server.url}/session\`, { method: 'POST', body: '{}' });
    const session = await created.json();
    const prompt = await fetch(\`\${server.url}/session/\${session.id}/message\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'build', parts: [{ type: 'text', text: 'legacy build agent prompt' }] }),
    });
    const alias = await fetch(\`\${server.url}/api/agent/build\`);
    console.log(JSON.stringify({ prompt: prompt.status, alias: alias.status }));
  } finally {
    await server.stop();
  }
`;

function exposedNames(env: NodeJS.ProcessEnv): string[] {
  return JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", probe], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
  })) as string[];
}

for (const variable of ["PI_CODING_AGENT_DIR", "OMO_CODING_AGENT_DIR"]) {
  test(`agent name reads overridden ${variable} and string-safe block comments`, (t) => {
    const home = mkdtempSync(join(tmpdir(), "antechamber-agent-config-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const agentDir = join(home, "custom", "agent");
    mkdirSync(agentDir, { recursive: true });
    const name = 'https://example.test/*agent*/"quoted"';
    writeFileSync(join(home, "custom", "oh-my-pi.jsonc"), `{
      /* orchestrator settings
         with "quotes" and // nested line markers */
      "orchestrator": { "agentName": ${JSON.stringify(name)} /* trailing comment */ }
      // final line comment
    }`);
    assert.deepEqual(exposedNames({
      HOME: home, ANTECHAMBER_AGENT: "", OCPI_AGENT: "",
      PI_CODING_AGENT_DIR: "", OMO_CODING_AGENT_DIR: "", [variable]: agentDir,
    }), [name, "build"]);
  });

  test(`agent name detects packages under overridden ${variable}`, (t) => {
    const home = mkdtempSync(join(tmpdir(), "antechamber-agent-packages-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const agentDir = join(home, "custom", "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:oh-my-pi"] }));
    assert.deepEqual(exposedNames({
      HOME: home, ANTECHAMBER_AGENT: "", OCPI_AGENT: "",
      PI_CODING_AGENT_DIR: "", OMO_CODING_AGENT_DIR: "", [variable]: agentDir,
    }), ["oh-my-pi", "build"]);
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
    const result = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", legacyProbe], {
      cwd: root,
      env: {
        ...process.env,
        ANTECHAMBER_AGENT: "OmO",
        ANTECHAMBER_PI_BINARY: join(root, "test/fixtures/fake-omo-endpoints.mjs"),
        ANTECHAMBER_STATE_DIR: state,
        ANTECHAMBER_TEST_DIRECTORY: state,
      },
      encoding: "utf8",
    })) as { prompt: number; alias: number };
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
    const v1Config = await fetch(\`\${server.url}/config\`).then(r => r.json());
    const v2Config = await fetch(\`\${server.url}/api/config\`).then(r => r.json());
    const v1Agents = await fetch(\`\${server.url}/agent\`).then(r => r.json());
    const v2Agents = await fetch(\`\${server.url}/api/agent\`).then(r => r.json());
    console.log(JSON.stringify({ v1Config, v2Config, v1Agents, v2Agents }));
  } finally {
    await server.stop();
  }
`;

function fetchConfigs(env: NodeJS.ProcessEnv): { v1Config: unknown; v2Config: unknown; v1Agents: unknown[]; v2Agents: unknown[] } {
  return JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", configProbe], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
  })) as { v1Config: unknown; v2Config: unknown; v1Agents: unknown[]; v2Agents: unknown[] };
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
    // v1 /config returns { default_agent }
    assert.deepEqual(result.v1Config, { default_agent: "OmO" });
    // v2 /api/config returns { location, data: { default_agent } }
    assert.ok(result.v2Config && typeof result.v2Config === "object" && "data" in result.v2Config);
    const v2Data = (result.v2Config as Record<string, unknown>).data;
    assert.deepEqual(v2Data, { default_agent: "OmO" });
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
    const v1Agents = result.v1Agents as [{ name: string; hidden: boolean }, { name: string; hidden: boolean }];
    assert.equal(v1Agents.length, 2, "v1: should expose [OmO, build]");
    assert.equal(v1Agents[0].name, "OmO");
    assert.equal(v1Agents[0].hidden, false, "v1: OmO should be visible");
    assert.equal(v1Agents[1].name, "build");
    assert.equal(v1Agents[1].hidden, true, "v1: build should be hidden");
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

function agentDefaultsFor(level: string): Array<{ model?: unknown; variant?: unknown }> {
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
    const v2 = (result.v2Agents as unknown as { data: Array<{ model?: unknown; variant?: unknown }> }).data;
    return [...(result.v1Agents as Array<{ model?: unknown; variant?: unknown }>), ...v2];
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
}

test("agents advertise OmO's resolved model and thinking level as their default", () => {
  for (const agent of agentDefaultsFor("medium")) {
    assert.deepEqual(agent.model, { providerID: "fake", modelID: "fake-model" });
    assert.equal(agent.variant, "medium");
  }
});

test("a thinking level the model does not offer is not advertised", () => {
  for (const agent of agentDefaultsFor("off")) {
    assert.deepEqual(agent.model, { providerID: "fake", modelID: "fake-model" });
    assert.equal(agent.variant, undefined);
  }
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
    const v1Agents = result.v1Agents as [{ name: string; hidden: boolean }];
    assert.equal(v1Agents.length, 1, "v1: should expose only [build]");
    assert.equal(v1Agents[0].name, "build");
    assert.equal(v1Agents[0].hidden, false, "v1: build should be visible when it's the default");
    // v1 config should have default_agent: "build"
    assert.deepEqual(result.v1Config, { default_agent: "build" });
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});
