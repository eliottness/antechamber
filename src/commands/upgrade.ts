import { type SelfUpdateResult, selfUpdate } from "../self-update.js";

export async function upgrade(
  update: () => Promise<SelfUpdateResult> = selfUpdate,
  output: (line: string) => void = console.log,
): Promise<void> {
  const result = await update();
  output(
    result.updated
      ? `Updated antechamber ${result.from} -> ${result.to} with ${result.method}; restart OpenChamber to use it.`
      : `antechamber ${result.from} is already the latest release.`,
  );
}
