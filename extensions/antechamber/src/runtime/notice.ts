import type { RuntimeStatus } from "../service.ts";

/**
 * What the OmO panel and the Work section show above their content until antechamber runs: nothing once it does.
 * `action` is the service route a button posts to (`/runtime/<action>`); `code` is a path to copy.
 */
export interface RuntimeNotice {
  readonly tone: "info" | "warn" | "bad";
  readonly text: string;
  readonly action?: { readonly label: string; readonly path: "install" | "activate" };
  readonly code?: string;
}

export function runtimeNotice(status: RuntimeStatus): RuntimeNotice | undefined {
  if (status.state === "installing")
    return { tone: "info", text: `Setting up antechamber ${status.spec} and OmO. This happens once per version.` };
  if (status.state === "missing")
    return {
      tone: "warn",
      text: `antechamber ${status.spec} is not installed yet.`,
      ...(status.bun ? { action: { label: "Install now", path: "install" } } : {}),
    };
  if (status.state === "failed")
    return {
      tone: "bad",
      text: `antechamber could not be installed: ${status.error ?? "unknown error"}`,
      ...(status.bun ? { action: { label: "Retry install", path: "install" } } : {}),
    };
  if (status.settingsError) return { tone: "bad", text: status.settingsError };
  if (status.needsReload)
    return {
      tone: "info",
      text: "antechamber is now OpenChamber's OpenCode CLI. Click Restart OpenCode in Settings → General → OpenCode CLI to start using it.",
    };
  if (status.active) return undefined;
  if (status.settings === null)
    return {
      tone: "warn",
      text: "Sessions do not run on OmO yet. Set Settings → General → OpenCode CLI to this launcher:",
      code: status.launcher,
    };
  return {
    tone: "warn",
    text: `Sessions do not run on OmO yet: OpenChamber uses ${status.configured ? `another OpenCode CLI (${status.configured})` : "its own OpenCode"}.`,
    action: { label: "Use antechamber as OpenCode CLI", path: "activate" },
  };
}

export function noticePollMs(status: RuntimeStatus | undefined): number {
  if (status === undefined) return 10_000;
  if (status.state === "installing" || status.needsReload) return 2_000;
  return status.active ? 30_000 : 5_000;
}
