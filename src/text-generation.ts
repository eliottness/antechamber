import { PiRpcClient } from "./pi-rpc.js";

type Entry = { type: string; message?: { role?: string; content?: string | Array<{ type?: string; text?: string }> } };
type Model = { providerID: string; id: string };

/** Own the auxiliary agents separately from user sessions, with no admission queue. */
export class TextGeneration {
  private readonly active = new Map<AbortController, Promise<string>>();
  private stopped = false;

  async generate(directory: string, prompt: string, model?: Model, signal?: AbortSignal): Promise<string> {
    if (this.stopped) throw new Error("Text generation is stopping");
    if (this.active.size >= 2) throw new Error("Text generation is at capacity");
    const cancellation = new AbortController();
    const result = generateText(
      directory,
      prompt,
      model,
      signal ? AbortSignal.any([signal, cancellation.signal]) : cancellation.signal,
    );
    this.active.set(cancellation, result);
    try {
      return await result;
    } finally {
      this.active.delete(cancellation);
    }
  }

  async dispose(): Promise<void> {
    this.stopped = true;
    for (const cancellation of this.active.keys()) cancellation.abort(new Error("Text generation is stopping"));
    await Promise.allSettled(this.active.values());
  }
}

/** Run a model turn in an agent with no persistent session, never in a user's chat. */
export async function generateText(
  directory: string,
  prompt: string,
  model?: Model,
  caller?: AbortSignal,
): Promise<string> {
  caller?.throwIfAborted();
  // Startup overrides initialize agent state without persisting the default, unlike set_model.
  // senpi dist/cli/args.js:93-104 -> main.js:561-576,843 -> core/sdk.js:125,292-298.
  const pi = new PiRpcClient({
    cwd: directory,
    args: ["--no-session", "--no-tools", ...(model ? ["--provider", model.providerID, "--model", model.id] : [])],
  });
  const cancellation = new AbortController();
  const signal = caller ? AbortSignal.any([caller, cancellation.signal]) : cancellation.signal;
  // This budget covers startup/model resolution, admission, the turn, and the result read.
  const timer = setTimeout(() => cancellation.abort(new Error("Text generation timed out")), 120_000);
  try {
    const finished = new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        pi.off("event", onEvent);
        signal.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        cleanup();
        reject(signal.reason);
      };
      const onEvent = (event: Record<string, unknown>) => {
        if (event.type !== "agent_end") return;
        cleanup();
        resolve();
      };
      pi.onEvent(onEvent);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    // A prompt RPC may acknowledge admission before the agent finishes; agent_end
    // is the completion boundary before reading the resulting entries.
    const admitted = pi.command({ type: "prompt", message: prompt }, undefined, signal).then((response) => {
      if (!response.success) throw new Error(response.error ?? "Text generation failed");
    });
    await Promise.all([admitted, finished]);
    const history = await pi.command<{ entries: Entry[] }>({ type: "get_entries" }, undefined, signal);
    if (!history.success || !Array.isArray(history.data?.entries))
      throw new Error("Text generation produced no readable history");
    const assistant = history.data.entries.findLast(
      (entry) => entry.type === "message" && entry.message?.role === "assistant",
    );
    const content = assistant?.message?.content;
    const text =
      typeof content === "string"
        ? content
        : content
            ?.filter((part) => part.type === "text")
            .map((part) => part.text ?? "")
            .join("");
    if (!text) throw new Error("Text generation produced no text");
    return text;
  } finally {
    clearTimeout(timer);
    cancellation.abort();
    await pi.dispose();
  }
}
