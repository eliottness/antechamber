import type { GraphNode, NodeState } from "./graph.ts";

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function shortModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  return model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
}

export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

export const STATE_LABEL: Record<NodeState, string> = {
  running: "running",
  queued: "queued",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  idle: "idle",
};

export function statusLine(node: GraphNode, now: number): string {
  if (node.kind === "root") return node.rawStatus;
  const label = node.rawStatus === node.state ? STATE_LABEL[node.state] : node.rawStatus;
  const start = node.startedAt;
  if (start === undefined) return label;
  if (node.state === "running") return `${label} · ${duration(now - start)}`;
  if (node.endedAt !== undefined) return `${label} · ${duration(node.endedAt - start)}`;
  return label;
}
