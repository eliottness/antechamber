import type { WorkStatus } from "../../../src/work-status.ts";

export type { GoalTimerView, WakeSource, WorkStatus } from "../../../src/work-status.ts";
export type { TodoPhase } from "../../../src/todo-bridge.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Checks the envelope antechamber's `/antechamber/work-status` route answers with. */
export function parseWorkStatus(body: string): WorkStatus {
  const value: unknown = JSON.parse(body);
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.sessionID !== "string" ||
    typeof value.live !== "boolean" ||
    !["todo", "monitors", "evalCells", "background", "wakeSources"].every((key) => Array.isArray(value[key]))
  )
    throw new Error("antechamber answered with an unexpected work-status shape");
  return value as unknown as WorkStatus;
}

/** Whether anything the section shows can still change on its own, so polling should stay fast. */
export function isActive(status: WorkStatus): boolean {
  return (
    status.goal?.armed === true ||
    status.wakeSources.length > 0 ||
    status.todo.some((phase) => phase.tasks.some((task) => task.status === "in_progress"))
  );
}
