import type { GraphEdge, GraphNode, TaskGraph } from "./graph.ts";

export const CARD_W = 232;
export const CARD_H = 80;
export const COL_GAP = 76;
export const ROW_GAP = 14;
export const BAND = 34;
export const PAD = 24;

export interface Box {
  x: number;
  y: number;
}
export interface RoutedEdge extends GraphEdge {
  d: string;
  sx: number;
  sy: number;
  tx: number;
  ty: number;
}
export interface Layout {
  boxes: Map<string, Box>;
  edges: RoutedEdge[];
  columnX: Map<number, number>;
  width: number;
  height: number;
}

const columnLeft = (column: number) => PAD + column * (CARD_W + COL_GAP);

/**
 * Column-major placement. Each column is stacked top-down ordered by its
 * parents' rows, so a fan-out stays next to the node that launched it; the
 * root is then centred on its direct children.
 */
export function layoutGraph(graph: TaskGraph): Layout {
  const boxes = new Map<string, Box>();
  const columns = new Map<number, GraphNode[]>();
  for (const n of graph.nodes) columns.set(n.column, [...(columns.get(n.column) ?? []), n]);
  const order = [...columns.keys()].sort((a, b) => a - b);
  const columnX = new Map(order.map((c) => [c, columnLeft(c)]));
  const rank = new Map<string, number>();
  let height = 0;
  for (const c of order) {
    const nodes = (columns.get(c) ?? [])
      .slice()
      .sort(
        (a, b) =>
          (rank.get(a.parentId ?? "") ?? -1) - (rank.get(b.parentId ?? "") ?? -1) ||
          (a.createdAt ?? 0) - (b.createdAt ?? 0) ||
          a.id.localeCompare(b.id),
      );
    nodes.forEach((n, i) => {
      const y = PAD + BAND + i * (CARD_H + ROW_GAP);
      boxes.set(n.id, { x: columnX.get(c) ?? 0, y });
      rank.set(n.id, rank.size);
      height = Math.max(height, y + CARD_H + PAD);
    });
  }
  const root = boxes.get(graph.rootId);
  const kids = graph.nodes
    .filter((n) => n.parentId === graph.rootId)
    .map((n) => boxes.get(n.id))
    .filter((b): b is Box => b !== undefined);
  if (root && kids.length > 0 && (columns.get(0)?.length ?? 0) === 1) {
    const top = Math.min(...kids.map((b) => b.y));
    const bottom = Math.max(...kids.map((b) => b.y));
    root.y = Math.round((top + bottom) / 2);
  }
  const width = PAD + (Math.max(0, ...order) + 1) * (CARD_W + COL_GAP) - COL_GAP + PAD;
  return {
    boxes,
    edges: routeEdges(graph.edges, boxes),
    columnX,
    width,
    height: Math.max(height, PAD * 2 + BAND + CARD_H),
  };
}

/** Spreads several edges sharing one side of a card over its middle band instead of one midpoint. */
function portOffset(index: number, count: number): number {
  if (count <= 1) return CARD_H / 2;
  const step = Math.min(12, (CARD_H * 0.44) / (count - 1));
  return CARD_H / 2 + (index - (count - 1) / 2) * step;
}

export function routeEdges(edges: GraphEdge[], boxes: Map<string, Box>): RoutedEdge[] {
  const live = edges.filter((e) => boxes.has(e.from) && boxes.has(e.to));
  const centre = (id: string) => (boxes.get(id)?.y ?? 0) + CARD_H / 2;
  const outgoing = new Map<string, GraphEdge[]>();
  const incoming = new Map<string, GraphEdge[]>();
  for (const e of live) {
    outgoing.set(e.from, [...(outgoing.get(e.from) ?? []), e]);
    incoming.set(e.to, [...(incoming.get(e.to) ?? []), e]);
  }
  for (const list of outgoing.values()) list.sort((a, b) => centre(a.to) - centre(b.to));
  for (const list of incoming.values()) list.sort((a, b) => centre(a.from) - centre(b.from));
  return live.map((e) => {
    const a = boxes.get(e.from) as Box;
    const b = boxes.get(e.to) as Box;
    const outs = outgoing.get(e.from) ?? [];
    const ins = incoming.get(e.to) ?? [];
    const sx = a.x + CARD_W;
    const sy = a.y + portOffset(outs.indexOf(e), outs.length);
    const tx = b.x;
    const ty = b.y + portOffset(ins.indexOf(e), ins.length);
    const reach = tx > sx ? Math.max(32, (tx - sx) * 0.5) : 90;
    const d = `M ${sx} ${sy} C ${sx + reach} ${sy}, ${tx - reach} ${ty}, ${tx} ${ty}`;
    return { ...e, d, sx, sy, tx, ty };
  });
}

export function reach(edges: GraphEdge[], start: string, direction: "up" | "down"): Set<string> {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    for (const e of edges) {
      const next = direction === "down" ? (e.from === id ? e.to : undefined) : e.to === id ? e.from : undefined;
      if (next !== undefined && !seen.has(next) && next !== start) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen;
}
