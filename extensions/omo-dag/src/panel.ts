import { connectHost, HostRequestError, type HostReadyContext } from "@openchamber/sdk";
import { applyHostReady } from "@openchamber/sdk/ui";
import type { GraphNode, TaskGraph } from "./graph.ts";
import { CARD_H, CARD_W, layoutGraph, reach, type Layout } from "./layout.ts";
import { compact, shortModel, statusLine } from "./format.ts";
import { PanGesture } from "./pan.ts";
import { GraphPoller, type PollView } from "./poller.ts";

const SVG = "http://www.w3.org/2000/svg";
document.documentElement.style.setProperty("--node-card-width", `${CARD_W}px`);
document.documentElement.style.setProperty("--node-card-height", `${CARD_H}px`);

type Paths = { agentDir?: string; stateDir?: string };

const host = connectHost();
const $ = <T extends Element>(selector: string) => document.querySelector(selector) as T;
const ui = {
  app: $<HTMLDivElement>("#app"),
  title: $<HTMLElement>("#title"),
  titleDot: $<HTMLElement>("#title-dot"),
  meta: $<HTMLElement>("#meta"),
  viewport: $<HTMLDivElement>("#viewport"),
  world: $<HTMLDivElement>("#world"),
  edges: $<SVGSVGElement>("#edges"),
  bands: $<HTMLDivElement>("#bands"),
  nodes: $<HTMLDivElement>("#nodes"),
  empty: $<HTMLDivElement>("#empty"),
  inspector: $<HTMLElement>("#inspector"),
  settings: $<HTMLFormElement>("#settings"),
};

let currentSession: string | null = null;
let pathsLoaded = false;
let graph: TaskGraph | undefined;
let layout: Layout | undefined;
let fittedFor = "";
let hovered: string | undefined;
let paths: Paths = {};
let timer: ReturnType<typeof setTimeout> | undefined;
const view = { x: 0, y: 0, k: 1 };
const cards = new Map<string, HTMLButtonElement>();

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function showEmpty(title: string, detail = "") {
  ui.empty.replaceChildren(el("strong", "", title), ...(detail ? [el("p", "", detail)] : []));
  ui.empty.hidden = false;
  ui.world.hidden = true;
  ui.inspector.hidden = true;
}

function errorText(error: unknown): [string, string] {
  if (error instanceof HostRequestError) {
    if (error.code === "NO_SERVICE")
      return [
        "Local service not allowed yet",
        "Approve OmO Graph in Settings → Extensions so it can read the OmO task store.",
      ];
    if (error.code === "SERVICE_FAILED")
      return ["The local service did not start", "Check Settings → Extensions; the next refresh retries it."];
    if (error.code === "DISABLED") return ["OmO Graph is paused", "Resume it in Settings → Extensions."];
    return [`Request failed (${error.code})`, error.message];
  }
  return ["Request failed", error instanceof Error ? error.message : String(error)];
}

function applyView() {
  ui.world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
  ui.app.style.setProperty("--zoom", String(view.k));
}

function fit() {
  if (!layout) return;
  const vw = ui.viewport.clientWidth;
  const vh = ui.viewport.clientHeight;
  const k = Math.min(1, Math.max(0.62, Math.min((vw - 16) / layout.width, (vh - 16) / layout.height)));
  view.k = k;
  view.x = Math.round(layout.width * k <= vw ? (vw - layout.width * k) / 2 : 8);
  view.y = Math.round(Math.max(8, (vh - layout.height * k) / 2));
  applyView();
}

function centreOn(id: string | undefined) {
  const box = id ? layout?.boxes.get(id) : undefined;
  if (!box) return fit();
  view.k = Math.max(view.k, 0.8);
  view.x = Math.round(ui.viewport.clientWidth / 2 - (box.x + CARD_W / 2) * view.k);
  view.y = Math.round(ui.viewport.clientHeight / 2 - (box.y + CARD_H / 2) * view.k);
  applyView();
}

function zoomAt(factor: number, cx = ui.viewport.clientWidth / 2, cy = ui.viewport.clientHeight / 2) {
  const k = Math.min(2, Math.max(0.2, view.k * factor));
  view.x = cx - ((cx - view.x) * k) / view.k;
  view.y = cy - ((cy - view.y) * k) / view.k;
  view.k = k;
  applyView();
}

const pan = new PanGesture();
let suppressClick = false;
function endPan(pointerId?: number, click = false) {
  if (!pan.active) return;
  const moved = pan.end(pointerId);
  if (pan.active) return;
  if (moved && click) {
    suppressClick = true;
    setTimeout(() => {
      suppressClick = false;
    }, 0);
  }
  ui.app.classList.remove("is-panning");
}
ui.viewport.addEventListener("pointerdown", (event) => pan.down(event, view));
window.addEventListener("pointermove", (event) => {
  const step = pan.move(event);
  if (step === "end") return endPan(event.pointerId);
  if (!step) return;
  if (step.started) {
    ui.viewport.setPointerCapture?.(event.pointerId);
    ui.app.classList.add("is-panning");
  }
  view.x = step.x;
  view.y = step.y;
  applyView();
});
window.addEventListener("pointerup", (event) => endPan(event.pointerId, true));
window.addEventListener("pointercancel", (event) => endPan(event.pointerId));
ui.viewport.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    const rect = ui.viewport.getBoundingClientRect();
    if (event.ctrlKey || event.metaKey || (Math.abs(event.deltaY) > Math.abs(event.deltaX) * 2 && !event.shiftKey)) {
      zoomAt(
        Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015)),
        event.clientX - rect.left,
        event.clientY - rect.top,
      );
    } else {
      view.x -= event.deltaX || (event.shiftKey ? event.deltaY : 0);
      view.y -= event.shiftKey ? 0 : event.deltaY;
      applyView();
    }
  },
  { passive: false },
);

$<HTMLButtonElement>("#btn-fit").addEventListener("click", fit);
$<HTMLButtonElement>("#btn-locate").addEventListener("click", () => {
  const running = graph?.nodes.find((n) => n.kind === "task" && n.state === "running");
  centreOn(graph?.focusId !== graph?.rootId ? graph?.focusId : (running?.id ?? graph?.rootId));
});
$<HTMLButtonElement>("#btn-in").addEventListener("click", () => zoomAt(1.2));
$<HTMLButtonElement>("#btn-out").addEventListener("click", () => zoomAt(1 / 1.2));
window.addEventListener("keydown", (event) => {
  if (event.target instanceof HTMLInputElement) return;
  if (event.key === "0") fit();
  else if (event.key === "+" || event.key === "=") zoomAt(1.2);
  else if (event.key === "-") zoomAt(1 / 1.2);
});

function setHover(id: string | undefined) {
  hovered = id;
  if (!graph) return;
  const edges = graph.edges;
  const ins = new Set(id ? edges.filter((e) => e.to === id).map((e) => e.from) : []);
  const outs = new Set(id ? edges.filter((e) => e.from === id).map((e) => e.to) : []);
  const up = id ? reach(edges, id, "up") : new Set<string>();
  const down = id ? reach(edges, id, "down") : new Set<string>();
  ui.app.classList.toggle("has-hover", id !== undefined);
  for (const [nodeId, card] of cards) {
    card.classList.toggle("is-hover", nodeId === id);
    card.classList.toggle("is-input", ins.has(nodeId));
    card.classList.toggle("is-output", outs.has(nodeId));
    card.classList.toggle("is-reach", up.has(nodeId) || down.has(nodeId));
  }
  for (const path of ui.edges.querySelectorAll<SVGPathElement>("path[data-edge]")) {
    const from = path.dataset.from ?? "";
    const to = path.dataset.to ?? "";
    path.classList.toggle("is-in", id !== undefined && to === id);
    path.classList.toggle("is-out", id !== undefined && from === id);
    path.classList.toggle(
      "is-reach",
      id !== undefined &&
        ((up.has(from) && (up.has(to) || to === id)) || (down.has(to) && (down.has(from) || from === id))),
    );
  }
  renderInspector();
}

function renderInspector() {
  const node = graph?.nodes.find(
    (n) => n.id === (hovered ?? (graph?.focusId !== graph?.rootId ? graph?.focusId : undefined)),
  );
  if (!node || !graph) {
    ui.inspector.hidden = true;
    return;
  }
  const ins = graph.edges.filter((e) => e.to === node.id).length;
  const outs = graph.edges.filter((e) => e.from === node.id).length;
  const facts: string[] = [statusLine(node, Date.now())];
  if (node.agent) facts.push(node.agent);
  const model = shortModel(node.model);
  if (model) facts.push(model);
  if (node.toolCalls !== undefined) facts.push(`${node.toolCalls} tools`);
  if (node.tokens !== undefined) facts.push(`${compact(node.tokens)} tok`);
  if (node.costUsd !== undefined) facts.push(`$${node.costUsd.toFixed(2)}`);
  const head = el("div", "i-head");
  head.append(el("span", `dot s-${node.state}`), el("strong", "", node.title));
  const flow = el("div", "i-flow");
  flow.append(
    el("span", "i-in", `← ${ins} input${ins === 1 ? "" : "s"}`),
    el("span", "i-out", `${outs} output${outs === 1 ? "" : "s"} →`),
  );
  const body = [head, el("div", "i-facts", facts.join(" · ")), flow];
  const text = node.error ?? node.summary;
  if (text) body.push(el("p", node.error ? "i-text is-error" : "i-text", text));
  body.push(
    el(
      "div",
      "i-hint",
      node.kind === "root" ? "Click to open the orchestrating session" : "Click to open this sub-agent's session",
    ),
  );
  ui.inspector.replaceChildren(...body);
  ui.inspector.hidden = false;
}

function cardFor(node: GraphNode): HTMLButtonElement {
  let card = cards.get(node.id);
  if (!card) {
    card = el("button", "node");
    card.type = "button";
    card.dataset.id = node.id;
    card.append(el("div", "n-head"), el("div", "n-status"), el("div", "n-meta"), el("div", "n-sub"));
    card.querySelector(".n-head")?.append(el("span", "dot"), el("span", "n-title"));
    card.addEventListener("pointerenter", () => setHover(node.id));
    card.addEventListener("pointerleave", () => {
      if (hovered === node.id) setHover(undefined);
    });
    card.addEventListener("focus", () => setHover(node.id));
    card.addEventListener("blur", () => {
      if (hovered === node.id) setHover(undefined);
    });
    card.addEventListener("click", () => {
      if (!suppressClick) void openNode(node.id);
    });
    cards.set(node.id, card);
    ui.nodes.append(card);
  }
  return card;
}

function fillCard(card: HTMLButtonElement, node: GraphNode, now: number) {
  card.className = `node k-${node.kind} s-${node.state}${graph?.focusId === node.id && node.kind === "task" ? " is-current" : ""}`;
  if (hovered === node.id) card.classList.add("is-hover");
  card.setAttribute("aria-label", `${node.title}, ${statusLine(node, now)}. Open session.`);
  const set = (selector: string, value: string) => {
    const target = card.querySelector(selector);
    if (target && target.textContent !== value) target.textContent = value;
  };
  set(".n-title", node.title);
  set(".n-status", statusLine(node, now));
  set(
    ".n-meta",
    node.kind === "root"
      ? `${graph?.nodes.length ? graph.nodes.length - 1 : 0} sub-agents`
      : [node.agent, shortModel(node.model)].filter(Boolean).join(" · "),
  );
  set(".n-sub", node.error ?? node.summary ?? "");
  card.querySelector(".dot")?.setAttribute("class", `dot s-${node.state}`);
}

function render(next: TaskGraph) {
  graph = next;
  layout = layoutGraph(next);
  ui.world.hidden = false;
  ui.empty.hidden = true;
  ui.world.style.width = `${layout.width}px`;
  ui.world.style.height = `${layout.height}px`;
  ui.edges.setAttribute("width", String(layout.width));
  ui.edges.setAttribute("height", String(layout.height));
  ui.edges.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);

  const states = new Map(next.nodes.map((n) => [n.id, n.state]));
  const frag = document.createDocumentFragment();
  for (const e of layout.edges) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", e.d);
    path.dataset.edge = e.id;
    path.dataset.from = e.from;
    path.dataset.to = e.to;
    const live = states.get(e.to) === "running" || states.get(e.to) === "queued";
    path.setAttribute("class", `edge k-${e.kind}${live ? " is-live" : ""}`);
    path.setAttribute("marker-end", "url(#arrow)");
    frag.append(path);
    if (live) {
      const flow = document.createElementNS(SVG, "path");
      flow.setAttribute("d", e.d);
      flow.setAttribute("class", "flow");
      flow.setAttribute("pathLength", "1");
      frag.append(flow);
    }
  }
  ui.edges.querySelectorAll("path.edge, path.flow").forEach((p) => p.remove());
  ui.edges.append(frag);

  ui.bands.replaceChildren(
    ...[...layout.columnX].map(([column, x]) => {
      const label = el("div", "band");
      label.style.left = `${x}px`;
      label.style.width = `${CARD_W}px`;
      const info = next.columns.find((c) => c.column === column);
      if (column === 0) label.textContent = "Orchestrator";
      else if (info)
        label.textContent = `Wave ${column} · ${info.done}/${info.total} done${info.running ? ` · ${info.running} running` : ""}`;
      if (info?.running) label.classList.add("is-live");
      return label;
    }),
  );

  const now = Date.now();
  const seen = new Set<string>();
  for (const node of next.nodes) {
    const card = cardFor(node);
    const box = layout.boxes.get(node.id);
    if (box) card.style.transform = `translate(${box.x}px, ${box.y}px)`;
    fillCard(card, node, now);
    seen.add(node.id);
  }
  for (const [id, card] of cards)
    if (!seen.has(id)) {
      card.remove();
      cards.delete(id);
    }

  const tasks = next.nodes.filter((n) => n.kind === "task");
  const done = tasks.filter((n) => n.state === "completed" || n.state === "failed" || n.state === "cancelled").length;
  const running = tasks.filter((n) => n.state === "running").length;
  const waves = next.columns.length;
  const liveWave = next.columns.find((c) => c.running > 0 || c.done < c.total)?.column;
  ui.title.textContent = next.title;
  ui.titleDot.className = `dot s-${running > 0 ? "running" : tasks.some((n) => n.state === "failed") ? "failed" : done === tasks.length ? "completed" : "idle"}`;
  ui.meta.textContent = [
    liveWave !== undefined ? `wave ${liveWave}/${waves}` : `${waves} wave${waves === 1 ? "" : "s"}`,
    `${done}/${tasks.length} done`,
    ...(running ? [`${running} running`] : []),
    ...(next.models ? [`${next.models} model${next.models === 1 ? "" : "s"}`] : []),
    ...(next.truncated ? [`${next.truncated.omittedNodes} omitted`] : []),
  ].join(" · ");
  void host.setBadge(running > 0 ? running : null).catch(() => undefined);

  if (fittedFor !== next.rootId) {
    fittedFor = next.rootId;
    requestAnimationFrame(() => (next.focusId !== next.rootId ? centreOn(next.focusId) : fit()));
  }
  if (hovered && !next.nodes.some((n) => n.id === hovered)) hovered = undefined;
  setHover(hovered);
}

function tick() {
  if (!graph) return;
  const now = Date.now();
  for (const node of graph.nodes) {
    if (node.state !== "running") continue;
    const card = cards.get(node.id);
    const status = card?.querySelector(".n-status");
    if (status) status.textContent = statusLine(node, now);
  }
}
setInterval(tick, 1000);

async function openNode(id: string) {
  const node = graph?.nodes.find((n) => n.id === id);
  if (!node) return;
  try {
    await host.openSession(node.sessionId);
  } catch (error) {
    const [title, detail] = errorText(error);
    await host.toast({ kind: "error", message: `${title}: ${detail}` }).catch(() => undefined);
  }
}

const poller = new GraphPoller({
  fetch: (sessionId) => {
    const query: Record<string, string> = { session: sessionId };
    if (paths.agentDir) query.agentDir = paths.agentDir;
    if (paths.stateDir) query.stateDir = paths.stateDir;
    return host.serviceRequest({ method: "GET", path: "/graph", query });
  },
  show: (view: PollView) => {
    if (view.kind === "graph") {
      render(view.graph);
      return;
    }
    graph = undefined;
    void host.setBadge(null).catch(() => undefined);
    if (view.kind === "no-session")
      showEmpty("No session open", "Open a chat to see the OmO agents working behind it.");
    else if (view.kind === "empty")
      showEmpty(
        "No sub-agents yet",
        "When this session launches OmO tasks or workflows, they appear here as a live graph.",
      );
    else showEmpty(...errorText(view.error));
  },
  schedule: (ms, run) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, ms);
  },
  isHidden: () => document.hidden,
});

const settingsToggle = $<HTMLButtonElement>("#btn-settings");
settingsToggle.addEventListener("click", () => {
  ui.settings.hidden = !ui.settings.hidden;
  settingsToggle.setAttribute("aria-expanded", String(!ui.settings.hidden));
  if (!ui.settings.hidden) ui.settings.querySelector("input")?.focus();
});
$<HTMLButtonElement>("#btn-save").addEventListener("click", () => {
  const data = new FormData(ui.settings);
  const next: Paths = {};
  const agentDir = String(data.get("agentDir") ?? "").trim();
  const stateDir = String(data.get("stateDir") ?? "").trim();
  if (agentDir) next.agentDir = agentDir;
  if (stateDir) next.stateDir = stateDir;
  paths = next;
  ui.settings.hidden = true;
  void host.storage.set("paths", next).catch(() => undefined);
  poller.invalidate();
});

function fillSettings() {
  for (const key of ["agentDir", "stateDir"] as const) {
    const input = ui.settings.querySelector<HTMLInputElement>(`input[name="${key}"]`);
    if (input) input.value = paths[key] ?? "";
  }
}

let started = false;
host.onReady((context: HostReadyContext) => {
  applyHostReady(context, document.documentElement);
  ui.app.dataset.surface = context.surface;
  if (started) return;
  started = true;
  currentSession = context.session?.id ?? currentSession;
  void host.storage
    .get("paths")
    .then((stored) => {
      if (stored && typeof stored === "object" && !Array.isArray(stored)) {
        const p = stored as Record<string, unknown>;
        paths = {
          ...(typeof p.agentDir === "string" ? { agentDir: p.agentDir } : {}),
          ...(typeof p.stateDir === "string" ? { stateDir: p.stateDir } : {}),
        };
      }
      fillSettings();
    })
    .catch(() => undefined)
    .finally(() => {
      pathsLoaded = true;
      poller.setSession(currentSession);
    });
});
host.onSession((next) => {
  const id = next?.id ?? null;
  if (id !== currentSession) hovered = undefined;
  currentSession = id;
  if (pathsLoaded) poller.setSession(id);
});
host.onSessionLifecycle(() => void poller.refresh());
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void poller.refresh();
});
window.addEventListener("resize", () => {
  if (layout && view.k <= 1) applyView();
});
