/**
 * Session instructions (`PUT /api/session/:id/instructions/:key`) reach the model as hidden
 * `antechamber.instructions` custom messages appended to the native conversation.
 */
import type { InstructionEntryState } from "./session-store.js";
import type { TreeEntry } from "./session-tree.js";

export const INSTRUCTIONS_CUSTOM_TYPE = "antechamber.instructions";

/** The instruction map the model holds on this branch: the last delivery inside the newest compaction's kept range. */
export function deliveredInstructions(branch: TreeEntry[]): Record<string, unknown> {
  let start = 0;
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index] as TreeEntry & { firstKeptEntryId?: unknown };
    if (entry.type !== "compaction") continue;
    const kept = branch.findIndex((candidate) => candidate.id === entry.firstKeptEntryId);
    start = kept >= 0 ? kept : index + 1;
    break;
  }
  for (let index = branch.length - 1; index >= start; index--) {
    const entry = branch[index];
    if (entry?.type !== "custom_message" || entry.customType !== INSTRUCTIONS_CUSTOM_TYPE) continue;
    const details = entry.details as { instructions?: unknown } | undefined;
    if (details?.instructions !== null && typeof details?.instructions === "object")
      return { ...(details.instructions as Record<string, unknown>) };
  }
  return {};
}

/**
 * The message that brings the model from `delivered` to `instructions`, with the full map it then holds, or
 * undefined when nothing changed. Keys are sent in sorted order so the text is deterministic.
 */
export function instructionDelivery(
  instructions: Record<string, InstructionEntryState>,
  delivered: Record<string, unknown>,
): { text: string; snapshot: Record<string, unknown> } | undefined {
  const pending = Object.entries(instructions)
    .filter(([key, entry]) =>
      entry.removed
        ? key in delivered
        : !(key in delivered) || JSON.stringify(entry.value) !== JSON.stringify(delivered[key]),
    )
    .sort(([left], [right]) => left.localeCompare(right));
  if (pending.length === 0) return undefined;
  const text = pending
    .map(([key, entry]) => {
      if (entry.removed) return `The context under "${key}" no longer applies. Disregard it.`;
      const block = `<context key="${key}">\n${typeof entry.value === "string" ? entry.value : JSON.stringify(entry.value, null, 2)}\n</context>`;
      return key in delivered
        ? `The context under "${key}" changed and supersedes the previous value:\n${block}`
        : block;
    })
    .join("\n\n");
  const snapshot = { ...delivered };
  for (const [key, entry] of pending) {
    if (entry.removed) delete snapshot[key];
    else snapshot[key] = entry.value;
  }
  return { text, snapshot };
}
