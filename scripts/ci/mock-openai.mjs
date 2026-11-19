#!/usr/bin/env node
// A fake OpenAI-compatible provider for end-to-end runs: every chat completion answers MOCK_REPLY (default "pong"),
// streamed the way OpenAI streams it, so OmO completes a real turn without a model or an API key. Listens on
// 127.0.0.1:MOCK_PORT (default 4099) and logs one line per request, for the caller to assert on.
import { createServer } from "node:http";

const port = Number(process.env.MOCK_PORT ?? 4099);
const reply = process.env.MOCK_REPLY ?? "pong";
const model = { id: "mock-pong", object: "model", created: 0, owned_by: "antechamber-ci" };

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const path = new URL(req.url ?? "/", "http://mock").pathname;
    if (req.method === "GET" && path.endsWith("/models")) return send(res, 200, { object: "list", data: [model] });
    if (req.method !== "POST" || !path.endsWith("/chat/completions"))
      return send(res, 404, { error: { message: path } });
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return send(res, 400, { error: { message: "invalid JSON" } });
    }
    const last = [...(body.messages ?? [])].reverse().find((m) => m.role === "user");
    const content = last?.content ?? "";
    // OpenAI content is a string or an array of parts; log the text either way.
    const asked =
      typeof content === "string"
        ? content
        : content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join(" ");
    console.log(`chat stream=${body.stream === true} user=${JSON.stringify(asked.slice(0, 120))}`);
    const id = `chatcmpl-mock-${Date.now()}`;
    const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
    if (body.stream !== true) {
      return send(res, 200, {
        id,
        object: "chat.completion",
        created: 0,
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
        usage,
      });
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const chunk = (choices, extra = {}) =>
      res.write(
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: body.model, choices, ...extra })}\n\n`,
      );
    chunk([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]);
    chunk([{ index: 0, delta: { content: reply }, finish_reason: null }]);
    chunk([{ index: 0, delta: {}, finish_reason: "stop" }]);
    if (body.stream_options?.include_usage) chunk([], { usage });
    res.end("data: [DONE]\n\n");
  });
}).listen(port, "127.0.0.1", () => console.log(`mock OpenAI provider on http://127.0.0.1:${port}/v1`));
