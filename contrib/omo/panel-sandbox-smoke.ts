// Opt-in browser regression: node --import tsx contrib/omo/panel-sandbox-smoke.ts
// Open the printed URL; #result[data-status] reports running, pass or fail.
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const extension = new URL("../../extensions/omo-dag/", import.meta.url);
const paths = { agentDir: "/fixture/omo-agent", stateDir: "/fixture/connector-state" } as const;
const session = "ses_sandbox_fixture";
const graph = {
  status: "ok",
  rootId: session,
  focusId: session,
  title: "Sandbox fixture",
  models: 0,
  nodes: [
    {
      id: session,
      sessionId: session,
      kind: "root",
      title: "Orchestrator",
      state: "idle",
      rawStatus: "orchestrator",
      column: 0,
      wave: 0,
    },
    {
      id: "st_sandbox",
      sessionId: "ses_sandbox_child",
      kind: "task",
      title: "Fixture task",
      state: "completed",
      rawStatus: "completed",
      column: 1,
      wave: 0,
    },
  ],
  edges: [{ id: "fixture-spawn", from: session, to: "st_sandbox", kind: "spawn" }],
  columns: [{ column: 1, total: 1, done: 1, running: 0 }],
} as const;

// Only the SDK boundary is synthetic. The HTML, panel, poller, layout and DOM are real.
const sdk = `
const expected = ${JSON.stringify(paths)};
function rpc(op, value) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = ({ data }) => {
      channel.port1.close();
      if (data.error) reject(new Error(data.error)); else resolve(data.value);
    };
    parent.postMessage({ op, value }, "*", [channel.port2]);
  });
}
function element(selector, type) {
  const node = document.querySelector(selector);
  if (!(node instanceof type)) throw new Error("Missing element: " + selector);
  return node;
}
function waitFor(check, stage) {
  return new Promise((resolve, reject) => {
    const observer = new MutationObserver(inspect);
    const deadline = setTimeout(() => {
      observer.disconnect();
      reject(new Error("Timed out: " + stage));
    }, 4000);
    function inspect() {
      if (!check()) return;
      observer.disconnect(); clearTimeout(deadline); resolve();
    }
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
    inspect();
  });
}
async function scenario() {
  const settings = element("#settings", HTMLFormElement);
  const toggle = element("#btn-settings", HTMLButtonElement);
  const agent = element('input[name="agentDir"]', HTMLInputElement);
  const state = element('input[name="stateDir"]', HTMLInputElement);
  const rendered = () => document.querySelectorAll("#nodes .node").length === 2 &&
    document.querySelectorAll("#edges path[data-edge]").length === 1 &&
    !element("#world", HTMLElement).hidden && element("#empty", HTMLElement).hidden;
  if (location.search === "?reload=1") {
    // Given persisted host storage, When a fresh iframe boots, Then it loads paths and graph.
    await waitFor(rendered, "persisted paths must render two nodes and one edge after reload");
    toggle.click();
    if (settings.hidden || agent.value !== expected.agentDir || state.value !== expected.stateDir)
      throw new Error("Reload did not restore both settings inputs");
    await rpc("complete");
    return;
  }
  // Given an empty graph with default paths, When native Save is clicked, Then paths take effect.
  await waitFor(() => document.querySelector("#empty p") !== null, "initial empty graph");
  toggle.click();
  if (settings.hidden) throw new Error("Settings did not open");
  agent.value = "  " + expected.agentDir + "  ";
  state.value = "  " + expected.stateDir + "  ";
  const saved = waitFor(() => settings.hidden && rendered(),
    "native Save must persist trimmed paths, close settings and render two nodes and one edge");
  element("#settings button", HTMLButtonElement).click();
  await saved;
  await rpc("saved");
}
export class HostRequestError extends Error {}
export function connectHost() {
  return {
    storage: { get: (key) => rpc("get", key), set: (key, value) => rpc("set", { key, paths: value }) },
    serviceRequest: (request) => rpc("graph", request),
    onReady: (callback) => queueMicrotask(() => {
      callback({ surface: "sidebar", session: { id: ${JSON.stringify(session)} } });
      void scenario().catch((error) => rpc("fail", error instanceof Error ? error.message : String(error)));
    }),
    onSession() {}, onSessionLifecycle() {},
    setBadge: async () => {}, openSession: async () => {}, toast: async () => {},
  };
}
`;

const page = `<!doctype html><meta charset="utf-8"><title>OmO sandbox Save regression</title>
<link rel="icon" href="data:,">
<h1>OmO sandbox Save regression</h1><pre id="result" data-status="running">running</pre>
<script>
const expected = ${JSON.stringify(paths)}, graph = ${JSON.stringify(graph)};
const frame = document.createElement("iframe");
frame.setAttribute("sandbox", "allow-scripts");
frame.style.cssText = "width:100%;height:75vh;border:1px solid";
const result = document.querySelector("#result");
const writes = [], requests = [];
let stored, reads = 0, reloaded = false;
const deadline = setTimeout(() => finish("fail", "Sandbox smoke deadline exceeded"), 12000);
function finish(status, reason) {
  if (result.dataset.status !== "running") return;
  clearTimeout(deadline); result.dataset.status = status;
  result.textContent = reason + "\\n" + JSON.stringify({ writes, requests, reads, reloaded }, null, 2);
}
function assert(condition, reason) { if (!condition) throw new Error(reason); }
function matching(value) {
  return value && value.agentDir === expected.agentDir && value.stateDir === expected.stateDir;
}
window.addEventListener("message", (event) => {
  if (event.source !== frame.contentWindow || !event.ports[0]) return;
  const port = event.ports[0], message = event.data;
  try {
    assert(message && typeof message === "object", "Invalid host request");
    const value = message.value;
    let answer;
    switch (message.op) {
      case "get": assert(value === "paths", "Unexpected storage key"); reads++; answer = stored; break;
      case "set":
        assert(value && value.key === "paths" && matching(value.paths) &&
          Object.keys(value.paths).length === 2, "Save did not store exactly the trimmed paths");
        writes.push(value.paths); stored = value.paths; break;
      case "graph":
        assert(value && value.method === "GET" && value.path === "/graph" &&
          value.query && value.query.session === ${JSON.stringify(session)}, "Unexpected graph request");
        requests.push(value.query);
        answer = { status: 200, body: JSON.stringify(matching(value.query) ? graph :
          { ...graph, nodes: [], edges: [], columns: [] }) }; break;
      case "saved":
        assert(!reloaded && writes.length === 1 && matching(stored) && requests.some(matching),
          "Save must write storage once and request a graph using trimmed paths");
        reloaded = true; frame.src = "/panel?reload=1"; break;
      case "complete":
        assert(reloaded && reads === 2 && writes.length === 1 && requests.filter(matching).length >= 2,
          "Reload must read persisted paths and request the graph without saving again");
        finish("pass", "PASS: native Save and iframe reload preserve trimmed paths and render the graph"); break;
      case "fail": finish("fail", typeof value === "string" ? value : "Iframe failed"); break;
      default: throw new Error("Unexpected host operation");
    }
    port.postMessage({ value: answer });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    finish("fail", reason); port.postMessage({ error: reason });
  } finally { port.close(); }
});
document.body.append(frame); frame.src = "/panel";
</script>`;

const bundled = await build({
  entryPoints: [fileURLToPath(new URL("src/panel.ts", extension))],
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  plugins: [
    {
      name: "sandbox-smoke-host",
      setup(plugin) {
        plugin.onResolve({ filter: /^@openchamber\/sdk(?:\/ui)?$/ }, ({ path }) => ({ path, namespace: "smoke" }));
        plugin.onLoad({ filter: /.*/, namespace: "smoke" }, ({ path }) => ({
          contents: path.endsWith("/ui") ? "export function applyHostReady() {}" : sdk,
        }));
      },
    },
  ],
});
const bundle = bundled.outputFiles[0];
if (!bundle) throw new Error("esbuild did not produce the panel bundle");
const html = await readFile(new URL("panel/index.html", extension), "utf8");
const server = createServer((request, response) => {
  response.setHeader("Cache-Control", "no-store");
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  const resource = path === "/" ? page : path === "/panel" ? html : path === "/main.js" ? bundle.text : undefined;
  response.statusCode = resource === undefined ? 404 : 200;
  response.setHeader("Content-Type", path === "/main.js" ? "text/javascript" : "text/html; charset=utf-8");
  response.end(resource ?? "Not found");
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close();
    server.closeAllConnections();
  });
}
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") throw new Error("Expected a loopback TCP listener");
console.log(`http://127.0.0.1:${address.port}/`);
