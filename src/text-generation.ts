import { PiRpcClient } from "./pi-rpc.js";

type Entry = { type: string; message?: { role?: string; content?: string | Array<{ type?: string; text?: string }> } };

/** Run a model turn in an agent with no persistent session, never in a user's chat. */
export async function generateText(
  directory: string,
  prompt: string,
  model?: { providerID: string; id: string },
): Promise<string> {
  const pi = new PiRpcClient({ cwd: directory, args: ["--no-session", "--no-tools"] });
  const cancellation = new AbortController();
  try {
    if (model !== undefined) {
      const selected = await pi.command({ type: "set_model", provider: model.providerID, modelId: model.id });
      if (!selected.success) throw new Error(selected.error ?? "Model selection failed");
    }
    const finished = new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        pi.off("event", onEvent);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Text generation timed out"));
      }, 120_000);
      const onEvent = (event: Record<string, unknown>) => {
        if (event.type !== "agent_end") return;
        cleanup();
        resolve();
      };
      pi.onEvent(onEvent);
      cancellation.signal.addEventListener("abort", cleanup, { once: true });
    });
    void finished.catch(() => undefined);
    // A prompt RPC may acknowledge admission before the agent finishes; agent_end
    // is the completion boundary before reading the resulting entries.
    const admitted = await pi.command({ type: "prompt", message: prompt });
    if (!admitted.success) throw new Error(admitted.error ?? "Text generation failed");
    await finished;
    const history = await pi.command<{ entries: Entry[] }>({ type: "get_entries" });
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
    cancellation.abort();
    await pi.dispose();
  }
}
