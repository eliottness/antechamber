import { createHash } from "node:crypto";
import { toolMappers } from "./tool-map.js";
import type { OCToolPart } from "./types.js";
import { isRecord } from "./guards.js";

export interface Todo {
  readonly id: string;
  readonly content: string;
  readonly status: "pending" | "in_progress" | "completed" | "cancelled";
  readonly priority: "medium";
}

/** One todo phase as OmO groups it, in its own order (the Work Status section's waves). */
export interface TodoPhase {
  readonly name: string;
  readonly tasks: ReadonlyArray<{ readonly content: string; readonly status: Todo["status"] }>;
}

export interface TodoUpdated {
  type: "todo.updated";
  properties: { sessionID: string; todos: Todo[] };
}

function todoStatus(value: unknown): Todo["status"] {
  switch (value) {
    case "in_progress":
      return "in_progress";
    case "completed":
      return "completed";
    case "abandoned":
    case "dropped":
    case "cancelled":
      return "cancelled";
    default:
      return "pending";
  }
}

/** The `senpi.todo-state` phases, keeping only well-formed phases and tasks. */
function todoPhases(data: unknown): TodoPhase[] {
  if (!isRecord(data) || !Array.isArray(data.phases)) return [];
  return data.phases.filter(isRecord).flatMap((phase): TodoPhase[] => {
    if (typeof phase.name !== "string" || !Array.isArray(phase.tasks)) return [];
    const tasks = phase.tasks
      .filter(isRecord)
      .flatMap((task) =>
        typeof task.content === "string" ? [{ content: task.content, status: todoStatus(task.status) }] : [],
      );
    return [{ name: phase.name, tasks }];
  });
}

export function flattenTodos(sessionID: string, data: unknown): Todo[] {
  const phases = todoPhases(data);
  return phases.flatMap((phase) =>
    phase.tasks.map(
      (task): Todo => ({
        id: createHash("md5").update(`${sessionID}|${phase.name}|${task.content}`).digest("hex").slice(0, 16),
        content: phases.length === 1 ? task.content : `${phase.name}: ${task.content}`,
        status: task.status,
        priority: "medium",
      }),
    ),
  );
}

toolMappers.todo = (args) => ({
  tool: "todowrite",
  input: { todos: Array.isArray(args.todos) ? args.todos : [] },
  title: "Todos",
});

/** Per-session snapshots; each card retains the state produced by its own call. */
export class TodoBridge {
  todos: Todo[] = [];
  phases: TodoPhase[] = [];
  private awaitingState: OCToolPart[] = [];

  constructor(private readonly sessionID: string) {}

  track(part: OCToolPart, args: unknown): void {
    if (part.tool !== "todowrite") return;
    part.state.input = { todos: this.todos };
    if (!isRecord(args) || args.op !== "view") this.awaitingState.push(part);
  }

  finish(part: OCToolPart, isError: boolean): void {
    if (isError) this.awaitingState = this.awaitingState.filter((candidate) => candidate !== part);
  }

  entry(entry: unknown, updatePart: (part: OCToolPart) => void = () => {}): TodoUpdated | undefined {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== "senpi.todo-state") return undefined;
    this.todos = flattenTodos(this.sessionID, entry.data);
    this.phases = todoPhases(entry.data);
    const part = this.awaitingState.shift();
    if (part !== undefined) {
      part.state.input = { todos: this.todos };
      updatePart(part);
    }
    return { type: "todo.updated", properties: { sessionID: this.sessionID, todos: this.todos } };
  }

  restore(entries: readonly unknown[], parts: Map<string, OCToolPart>): void {
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      const message = entry.message;
      if (isRecord(message) && message.role === "assistant" && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (!isRecord(block) || block.type !== "toolCall" || typeof block.id !== "string") continue;
          const part = parts.get(block.id);
          if (part !== undefined) this.track(part, block.arguments);
        }
      }
      if (isRecord(message) && message.role === "toolResult" && typeof message.toolCallId === "string") {
        const part = parts.get(message.toolCallId);
        if (part !== undefined) this.finish(part, message.isError === true);
      }
      this.entry(entry);
    }
  }
}
