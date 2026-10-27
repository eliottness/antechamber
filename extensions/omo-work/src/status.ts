import { connectHost, type HostReadyContext } from "@openchamber/sdk-v2";
import { applyHostReady } from "@openchamber/sdk-v2/ui";
import { isActive, parseWorkStatus, type WorkStatus } from "./model.ts";
import { focusPhase, formatDuration, isEmpty, summarizePhase, type Tone, wakeSourceLabel } from "./view.ts";

const POLL_ACTIVE_MS = 1500;
const POLL_IDLE_MS = 5000;
const POLL_ERROR_MS = 10000;
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
    render();
    schedule(isActive(next) ? POLL_ACTIVE_MS : POLL_IDLE_MS);
  } catch (cause) {
    if (current !== generation) return;
    error = cause instanceof Error ? cause.message : String(cause);
    render();
    schedule(POLL_ERROR_MS);
  }
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
    const groups = [todoGroup, goalGroup, wakeGroup].map((build) => build(status as WorkStatus));
    children.push(...groups);
    if (isEmpty(status))
      children.push(
        h(
          "div",
          { class: "note" },
          status.live ? "No todo list or goal." : "No todo list or goal. The agent is not running.",
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
