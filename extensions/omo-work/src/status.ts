import { connectHost, type HostReadyContext } from "@openchamber/sdk-v2";
import { applyHostReady } from "@openchamber/sdk-v2/ui";
import { isActive, parseWorkStatus, type WorkStatus } from "./model.ts";
import {
  cellMeta,
  cellTone,
  focusPhase,
  formatDuration,
  isCellRunning,
  isEmpty,
  monitorMeta,
  monitorTone,
  summarizePhase,
  type Tone,
  wakeSourceLabel,
} from "./view.ts";

const POLL_ACTIVE_MS = 1500;
const POLL_IDLE_MS = 5000;
const POLL_ERROR_MS = 10000;
const PEEK_BYTES = 4096;
const TASK_GLYPHS = { completed: "✓", in_progress: "●", pending: "○", cancelled: "–" } as const;

const host = connectHost();
const root = document.getElementById("root") as HTMLElement;

let sessionId: string | null = null;
let stateDir = "";
let status: WorkStatus | null = null;
let error: string | null = null;
let generation = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let showSettings = false;
/** Phases the reader opened or closed; others follow the phase in progress. */
const phaseChoice = new Map<string, boolean>();
const openMonitors = new Set<string>();
const openCells = new Set<string>();
const peeks = new Map<string, string>();
/** The cell state each peek was taken in; a state change (such as finishing) takes one more. */
const peekStates = new Map<string, string>();
const pending = new Set<string>();
/** Relative times refreshed every second without refetching. */
let tickers: Array<(now: number) => void> = [];

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string | boolean | ((event: Event) => void)> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === "function") node.addEventListener(key, value);
    else if (key === "class") node.className = String(value);
    else if (value === true) node.setAttribute(key, "");
    else if (value !== false) node.setAttribute(key, value);
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

function ticking(render: (now: number) => string, className = "meta"): HTMLElement {
  const node = h("span", { class: className });
  const update = (now: number) => {
    node.textContent = render(now);
    node.title = node.textContent;
  };
  update(Date.now());
  tickers.push(update);
  return node;
}

function query(extra: Record<string, string> = {}): Record<string, string> {
  return { session: sessionId ?? "", ...(stateDir ? { stateDir } : {}), ...extra };
}

async function service(method: "GET" | "POST", path: string, extra: Record<string, string> = {}) {
  const result = await host.serviceRequest({ method, path, query: query(extra) });
  if (result.status >= 400) {
    let message = `HTTP ${result.status}`;
    try {
      const body = JSON.parse(result.body) as { error?: unknown; detail?: unknown; data?: { message?: unknown } };
      message = String(body.data?.message ?? body.detail ?? body.error ?? message);
    } catch {
      // A non-JSON error body: the status is all there is to say.
    }
    throw new Error(message);
  }
  return result.body;
}

function schedule(ms: number): void {
  clearTimeout(timer);
  timer = setTimeout(() => void refresh(), ms);
}

async function refresh(): Promise<void> {
  clearTimeout(timer);
  if (sessionId === null) {
    status = null;
    error = null;
    render();
    return;
  }
  if (document.hidden) return schedule(POLL_IDLE_MS);
  const current = ++generation;
  try {
    const next = parseWorkStatus(await service("GET", "/status"));
    if (current !== generation) return;
    status = next;
    error = null;
    await refreshPeeks(next, current);
    if (current !== generation) return;
    render();
    schedule(isActive(next) ? POLL_ACTIVE_MS : POLL_IDLE_MS);
  } catch (cause) {
    if (current !== generation) return;
    error = cause instanceof Error ? cause.message : String(cause);
    render();
    schedule(POLL_ERROR_MS);
  }
}

async function refreshPeeks(next: WorkStatus, current: number): Promise<void> {
  const cells = next.evalCells.filter(
    (cell) => openCells.has(cell.cellId) && (isCellRunning(cell) || peekStates.get(cell.cellId) !== cell.state),
  );
  await Promise.all(
    cells.map(async (cell) => {
      try {
        const body = JSON.parse(
          await service("GET", "/eval", { cell: cell.cellId, tailBytes: String(PEEK_BYTES) }),
        ) as {
          outputTail?: unknown;
        };
        if (current !== generation) return;
        peeks.set(cell.cellId, typeof body.outputTail === "string" ? body.outputTail : "");
        peekStates.set(cell.cellId, cell.state);
      } catch (cause) {
        if (current === generation) peeks.set(cell.cellId, `(output unavailable: ${(cause as Error).message})`);
      }
    }),
  );
}

async function act(key: string, method: "POST", path: string, extra: Record<string, string>, done: string) {
  if (pending.has(key)) return;
  pending.add(key);
  render();
  try {
    await service(method, path, extra);
    void host.toast({ kind: "success", message: done }).catch(() => undefined);
  } catch (cause) {
    void host.toast({ kind: "error", message: (cause as Error).message }).catch(() => undefined);
  } finally {
    pending.delete(key);
    void refresh();
  }
}

function group(label: string, count: string | null, ...rows: Child[]): HTMLElement {
  return h(
    "section",
    { class: "group", "aria-label": label },
    h("div", { class: "label" }, label, count !== null && h("span", { class: "count" }, count)),
    ...rows,
  );
}

function dot(tone: Tone): HTMLElement {
  return h("span", { class: `dot t-${tone}`, "aria-hidden": "true" });
}

function todoGroup(current: WorkStatus): HTMLElement | null {
  if (current.todo.length === 0) return null;
  const focus = focusPhase(current.todo);
  const summaries = current.todo.map(summarizePhase);
  const done = summaries.reduce((sum, phase) => sum + phase.done, 0);
  const total = summaries.reduce((sum, phase) => sum + phase.total, 0);
  const rows = current.todo.flatMap((phase, index) => {
    const summary = summaries[index]!;
    const key = `${index}:${phase.name}`;
    const open = phaseChoice.get(key) ?? index === focus;
    const percent = summary.total === 0 ? 100 : Math.round((summary.done / summary.total) * 100);
    const row = h(
      "button",
      {
        class: `row t-${summary.tone}${open ? " is-open" : ""}`,
        type: "button",
        "aria-expanded": String(open),
        click: () => {
          phaseChoice.set(key, !open);
          render();
        },
      },
      dot(summary.tone),
      h(
        "span",
        { class: "stack" },
        h("span", { class: "title" }, summary.name),
        !open && summary.current !== undefined && h("span", { class: "meta" }, summary.current),
      ),
      h(
        "span",
        { class: "side" },
        `${summary.done}/${summary.total}`,
        h("span", { class: "bar", "aria-hidden": "true" }, h("i", { style: `width:${percent}%` })),
      ),
    );
    if (!open) return [row];
    const tasks = h(
      "div",
      { class: "tasks" },
      ...phase.tasks.map((task) =>
        h(
          "div",
          { class: `task s-${task.status}` },
          h("span", { class: "glyph", "aria-label": task.status.replace("_", " ") }, TASK_GLYPHS[task.status]),
          h("span", {}, task.content),
        ),
      ),
    );
    return [row, tasks];
  });
  return group("Todo", `${done}/${total}`, ...rows);
}

function monitorGroup(current: WorkStatus): HTMLElement | null {
  if (current.monitors.length === 0) return null;
  const live = current.monitors.filter((view) => view.ending === undefined).length;
  const rows = current.monitors.flatMap((view) => {
    const id = view.monitor.id;
    const open = openMonitors.has(id);
    const tone = monitorTone(view);
    const row = h(
      "button",
      {
        class: `row t-${tone}${open ? " is-open" : ""}`,
        type: "button",
        "aria-expanded": String(open),
        title: view.monitor.command ?? view.monitor.description,
        click: () => {
          if (open) openMonitors.delete(id);
          else openMonitors.add(id);
          render();
        },
      },
      dot(tone),
      h(
        "span",
        { class: "stack" },
        h("span", { class: "title" }, view.monitor.description),
        ticking((now) => monitorMeta(view, now)),
      ),
      h("span", { class: "side" }, id),
    );
    if (!open) return [row];
    const detail = h(
      "div",
      { class: "detail" },
      view.monitor.command !== null && h("div", { class: "kv" }, `$ ${view.monitor.command}`),
      view.monitor.filter !== null && h("div", { class: "kv" }, `filter ${view.monitor.filter}`),
      h(
        "div",
        { class: "kv" },
        view.monitor.persistent
          ? "persistent"
          : view.monitor.deadlineMs !== null && view.ending === undefined
            ? ticking((now) => `deadline in ${formatDuration((view.monitor.deadlineMs ?? now) - now)}`, "")
            : "",
      ),
      view.lines.length > 0 ? h("pre", {}, view.lines.join("\n")) : h("div", { class: "kv" }, "no matched lines yet"),
    );
    return [row, detail];
  });
  return group("Monitors", live > 0 ? `${live} live` : String(current.monitors.length), ...rows);
}

function evalGroup(current: WorkStatus): HTMLElement | null {
  if (current.evalCells.length === 0) return null;
  const running = current.evalCells.filter(isCellRunning).length;
  const rows = current.evalCells.flatMap((cell) => {
    const open = openCells.has(cell.cellId);
    const tone = cellTone(cell);
    const stopKey = `stop:${cell.cellId}`;
    const row = h(
      "div",
      { class: `row t-${tone}${open ? " is-open" : ""}` },
      dot(tone),
      h(
        "button",
        {
          class: "stack",
          type: "button",
          "aria-expanded": String(open),
          title: current.live ? "Show output" : "The agent is not running",
          click: () => {
            if (open) openCells.delete(cell.cellId);
            else openCells.add(cell.cellId);
            render();
            if (!open && current.live) void refresh();
          },
        },
        h("span", { class: "title" }, cell.summary ?? cell.cellId),
        ticking((now) => cellMeta(cell, now)),
      ),
      h(
        "span",
        { class: "side" },
        isCellRunning(cell) &&
          current.live &&
          h(
            "button",
            {
              class: "action danger",
              type: "button",
              disabled: pending.has(stopKey),
              "aria-label": `Stop eval cell ${cell.summary ?? cell.cellId}`,
              click: () => void act(stopKey, "POST", "/eval/stop", { cell: cell.cellId }, "Eval cell stopped"),
            },
            "Stop",
          ),
      ),
    );
    if (!open) return [row];
    const output = peeks.get(cell.cellId);
    return [
      row,
      h(
        "div",
        { class: "detail" },
        h("div", { class: "kv" }, cell.cellId),
        h("pre", {}, output === undefined ? "loading…" : output === "" ? "(no output yet)" : output),
      ),
    ];
  });
  const note = !current.evalCellsListed && current.live && h("div", { class: "note" }, "Cell output needs codemode.");
  return group("Eval cells", running > 0 ? `${running} running` : String(current.evalCells.length), ...rows, note);
}

function backgroundGroup(current: WorkStatus): HTMLElement | null {
  if (current.background.length === 0) return null;
  return group(
    "Background",
    String(current.background.length),
    ...current.background.map((entry) =>
      h(
        "div",
        { class: "row t-run", title: entry.command },
        dot("run"),
        h(
          "span",
          { class: "stack" },
          h("span", { class: "title" }, entry.command),
          ticking((now) => `${entry.id} · ${formatDuration(now - entry.startedAtMs)}`),
        ),
        h("span", { class: "side" }, entry.pid !== undefined ? `pid ${entry.pid}` : ""),
      ),
    ),
  );
}

function goalGroup(current: WorkStatus): HTMLElement | null {
  const goal = current.goal;
  if (goal === null) return null;
  const waits = Object.entries(goal.wakeSources ?? {})
    .filter(([, count]) => count > 0)
    .map(([source, count]) => `${count} ${wakeSourceLabel(source)}`)
    .join(", ");
  const row = h(
    "div",
    { class: `row t-${goal.armed ? "run" : "idle"}` },
    dot(goal.armed ? "run" : "idle"),
    h(
      "span",
      { class: "stack" },
      h("span", { class: "title" }, goal.armed ? "Goal continuation armed" : "Goal continuation idle"),
      goal.armed && goal.dueAtMs !== undefined
        ? ticking(
            (now) =>
              `${goal.kind ?? "next"} ${(goal.dueAtMs ?? now) > now ? `in ${formatDuration((goal.dueAtMs ?? now) - now)}` : "due now"}${waits ? ` · waiting on ${waits}` : ""}`,
          )
        : waits && h("span", { class: "meta" }, `waiting on ${waits}`),
    ),
    h(
      "span",
      { class: "side" },
      goal.armed &&
        current.live &&
        h(
          "button",
          {
            class: "action",
            type: "button",
            disabled: pending.has("goal"),
            click: () => void act("goal", "POST", "/goal/fire", {}, "Goal continuation fired"),
          },
          "Fire now",
        ),
    ),
  );
  return group("Goal", null, row);
}

function wakeGroup(current: WorkStatus): HTMLElement | null {
  if (current.wakeSources.length === 0) return null;
  return group(
    "Other activity",
    null,
    ...current.wakeSources.map((source) =>
      h(
        "div",
        { class: "row t-run" },
        dot("run"),
        h(
          "span",
          { class: "stack" },
          h("span", { class: "title" }, wakeSourceLabel(source.source)),
          source.items.length > 0 &&
            h("span", { class: "meta" }, source.items.map((item) => item.description).join(", ")),
        ),
        h("span", { class: "side" }, `${source.activeCount} active`),
      ),
    ),
  );
}

function settingsForm(): HTMLElement {
  const input = h("input", {
    name: "stateDir",
    value: stateDir,
    placeholder: "~/.config/antechamber (default)",
    autocomplete: "off",
    spellcheck: "false",
  });
  const save = () => {
    stateDir = input.value.trim();
    showSettings = false;
    void host.storage.set("stateDir", stateDir).catch(() => undefined);
    void refresh();
  };
  return h(
    "form",
    {
      class: "settings",
      submit: (event) => {
        event.preventDefault();
        save();
      },
    },
    h("label", {}, "antechamber state directory", input),
    h("div", { class: "buttons" }, h("button", { class: "action", type: "submit" }, "Save")),
  );
}

function render(): void {
  tickers = [];
  const children: Child[] = [];
  if (showSettings) children.push(settingsForm());
  if (sessionId === null) children.push(h("div", { class: "note" }, "Open a session to see its background work."));
  else if (status === null && error === null) children.push(h("div", { class: "note" }, "Loading…"));
  else if (status === null) children.push(h("div", { class: "note is-error" }, error));
  else {
    if (error !== null) children.push(h("div", { class: "note is-error" }, error));
    const groups = [todoGroup, monitorGroup, evalGroup, backgroundGroup, goalGroup, wakeGroup].map((build) =>
      build(status as WorkStatus),
    );
    children.push(...groups);
    if (isEmpty(status))
      children.push(
        h(
          "div",
          { class: "note" },
          status.live ? "No background work." : "No background work. The agent is not running.",
        ),
      );
  }
  root.replaceChildren(...children.filter((child): child is Node | string => Boolean(child)));
}

setInterval(() => {
  const now = Date.now();
  for (const tick of tickers) tick(now);
}, 1000);

new ResizeObserver(() => {
  void host.setHeight(Math.ceil(root.getBoundingClientRect().height)).catch(() => undefined);
}).observe(root);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refresh();
});

host.onStatusControl((event) => {
  if (event.id !== "data-path") return;
  showSettings = !showSettings;
  render();
});

host.onReady((context: HostReadyContext) => {
  applyHostReady(context, document.documentElement);
  if (context.features?.statusControls)
    void host.setStatusControls([{ kind: "button", id: "data-path", label: "Data path" }]).catch(() => undefined);
});

host.onSession((next) => {
  const id = next?.id ?? null;
  if (id === sessionId) return;
  sessionId = id;
  status = null;
  error = null;
  openCells.clear();
  openMonitors.clear();
  peeks.clear();
  peekStates.clear();
  pending.clear();
  phaseChoice.clear();
  generation++;
  void refresh();
});

void host.storage
  .get("stateDir")
  .then((value) => {
    if (typeof value === "string" && value !== stateDir) {
      stateDir = value;
      void refresh();
    }
  })
  .catch(() => undefined);

render();
