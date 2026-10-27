import type { TodoPhase, WorkStatus } from "./model.ts";

export type Tone = "run" | "ok" | "warn" | "bad" | "idle";

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export interface PhaseSummary {
  name: string;
  done: number;
  total: number;
  finished: boolean;
  current?: string;
  tone: Tone;
}

export function summarizePhase(phase: TodoPhase): PhaseSummary {
  const live = phase.tasks.filter((task) => task.status !== "cancelled");
  const done = live.filter((task) => task.status === "completed").length;
  const current = phase.tasks.find((task) => task.status === "in_progress")?.content;
  const finished = phase.tasks.every((task) => task.status === "completed" || task.status === "cancelled");
  return {
    name: phase.name,
    done,
    total: live.length,
    finished,
    ...(current !== undefined ? { current } : {}),
    tone: current !== undefined ? "run" : finished ? "ok" : "idle",
  };
}

/** The phase a reader wants open: the one in progress, else the first unfinished one. */
export function focusPhase(phases: TodoPhase[]): number {
  const running = phases.findIndex((phase) => phase.tasks.some((task) => task.status === "in_progress"));
  if (running >= 0) return running;
  return phases.findIndex((phase) => !summarizePhase(phase).finished);
}

export function wakeSourceLabel(source: string): string {
  switch (source) {
    case "senpi-codemode":
      return "eval cells";
    case "terminal-monitors":
      return "monitors";
    case "terminal-background-sessions":
      return "background sessions";
    case "loop-guard":
      return "loop guard";
    default:
      return source;
  }
}

/**
 * Monitors, eval cells and background sessions are OpenChamber's own background commands (antechamber reports
 * them as OpenCode shells), so the section shows only what OpenChamber has no surface for.
 */
export function isEmpty(status: WorkStatus): boolean {
  return status.todo.length === 0 && status.goal === null && status.wakeSources.length === 0;
}
