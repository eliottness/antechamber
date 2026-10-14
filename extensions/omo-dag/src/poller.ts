import type { TaskGraph } from "./graph.ts";

export const POLL_ACTIVE_MS = 1500;
export const POLL_IDLE_MS = 5000;
export const POLL_ERROR_MS = 10000;

export type PollView =
  | { kind: "no-session" }
  | { kind: "empty" }
  | { kind: "graph"; graph: TaskGraph }
  | { kind: "error"; error: unknown };

export interface PollerDeps {
  fetch: (sessionId: string) => Promise<{ status: number; body: string }>;
  show: (view: PollView) => void;
  /** Replaces any previously scheduled refresh. */
  schedule: (ms: number, run: () => void) => void;
  isHidden: () => boolean;
}

/**
 * One request at a time. A session or source change bumps the generation: an
 * answer for an older generation is dropped and a refresh for the current one
 * runs as soon as the in-flight request settles. `show` is called whenever the
 * view changes; an unchanged graph body is not re-rendered.
 */
export function parseGraph(body: string): TaskGraph {
  const value: unknown = JSON.parse(body);
  const ok =
    value !== null &&
    typeof value === "object" &&
    typeof (value as TaskGraph).status === "string" &&
    Array.isArray((value as TaskGraph).nodes) &&
    Array.isArray((value as TaskGraph).edges) &&
    Array.isArray((value as TaskGraph).columns) &&
    (value as TaskGraph).nodes.every((n) => n !== null && typeof n === "object" && typeof n.id === "string");
  if (!ok) throw new Error("service answered with an unexpected graph shape");
  return value as TaskGraph;
}

export class GraphPoller {
  private session: string | null | undefined = undefined;
  private generation = 0;
  private inFlight = false;
  private pending = false;
  private signature = "";

  constructor(private readonly deps: PollerDeps) {}

  setSession(sessionId: string | null): void {
    if (sessionId === this.session) return;
    this.session = sessionId;
    this.invalidate();
  }

  invalidate(): void {
    this.generation++;
    this.signature = "";
    void this.refresh();
  }

  async refresh(): Promise<void> {
    const sessionId = this.session;
    if (sessionId === undefined) return;
    if (sessionId === null) {
      this.signature = "";
      this.deps.show({ kind: "no-session" });
      return;
    }
    if (this.deps.isHidden()) {
      this.deps.schedule(POLL_IDLE_MS, () => void this.refresh());
      return;
    }
    if (this.inFlight) {
      this.pending = true;
      return;
    }
    this.inFlight = true;
    const generation = this.generation;
    try {
      const result = await this.deps.fetch(sessionId);
      if (generation !== this.generation) return;
      if (result.status !== 200)
        throw new Error(`service answered HTTP ${result.status}: ${result.body.slice(0, 200)}`);
      const graph = parseGraph(result.body);
      if (graph.status !== "ok" || graph.nodes.length <= 1) {
        this.signature = "";
        this.deps.show({ kind: "empty" });
      } else if (result.body !== this.signature) {
        this.signature = result.body;
        this.deps.show({ kind: "graph", graph });
      }
      const active = graph.nodes.some((n) => n.state === "running" || n.state === "queued");
      this.deps.schedule(active ? POLL_ACTIVE_MS : POLL_IDLE_MS, () => void this.refresh());
    } catch (error) {
      if (generation !== this.generation) return;
      this.signature = "";
      this.deps.show({ kind: "error", error });
      this.deps.schedule(POLL_ERROR_MS, () => void this.refresh());
    } finally {
      this.inFlight = false;
      if (this.pending || generation !== this.generation) {
        this.pending = false;
        void this.refresh();
      }
    }
  }
}
