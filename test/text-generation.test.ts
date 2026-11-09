import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { GENERATION_DEADLINE_MS, generateText } from "../src/text-generation.js";
import { serverFor } from "./catalog-harness.js";
import { bounded, generationHarness } from "./generation-harness.js";

for (const outcome of ["success", "failure"] as const) {
  test(`auxiliary generation preserves the configured default on ${outcome}`, async (t) => {
    const { root, url } = await serverFor(t);
    const settings = join(root, "default-model.json");
    const configured = JSON.stringify({ provider: "coding", id: "original" });
    writeFileSync(settings, configured);
    const saved = process.env.FAKE_OMO_DEFAULT_MODEL;
    process.env.FAKE_OMO_DEFAULT_MODEL = settings;
    t.after(() => {
      if (saved === undefined) delete process.env.FAKE_OMO_DEFAULT_MODEL;
      else process.env.FAKE_OMO_DEFAULT_MODEL = saved;
    });

    const response = await fetch(`${url}/api/experimental/generate/text`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: outcome === "success" ? "fixture-generation-model" : "fixture-generation-fail",
        model: { providerID: "auxiliary", id: "small-model" },
      }),
    });

    assert.equal(response.status, outcome === "success" ? 200 : 503, await response.clone().text());
    assert.deepEqual(
      await response.json(),
      outcome === "success"
        ? { data: { text: "auxiliary/small-model" } }
        : { _tag: "ServiceUnavailableError", message: "Generation refused", service: "opencode" },
    );
    assert.equal(readFileSync(settings, "utf8"), configured, "generation must leave shared model settings untouched");
  });
}

for (const phase of ["startup", "admission", "running", "read"] as const) {
  test(`one generation deadline cancels the agent during ${phase}`, async (t) => {
    const h = await generationHarness(t);
    const ready = h.wait(phase === "read" ? "running" : phase);
    const result = generateText(h.root, `fixture-generation-${phase}`).then(
      (text) => text,
      (error: unknown) => error,
    );
    await ready;
    if (phase === "read") {
      // Spend all but one millisecond generating, then enter the result read.
      h.timer.advance(GENERATION_DEADLINE_MS - 1);
      const reading = h.wait("read");
      h.release();
      await reading;
      h.timer.advance(1);
    } else {
      h.timer.advance(GENERATION_DEADLINE_MS);
    }

    const outcome = await bounded(result);
    assert.ok(outcome instanceof Error);
    assert.match(outcome.message, /Text generation timed out/);
    await h.gone();
  });
}

function postGeneration(url: string, prompt: string, signal?: AbortSignal): Promise<Response> {
  return fetch(`${url}/api/experimental/generate/text`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt }),
    ...(signal ? { signal } : {}),
  });
}

test("generation rejects excess concurrent requests and frees capacity after completion", async (t) => {
  const h = await generationHarness(t);
  const running = h.wait("running", 2);
  const requests = [1, 2].map(() =>
    postGeneration(h.url, "fixture-generation-running").catch((error: unknown) => error),
  );
  await running;

  const excess = await bounded(postGeneration(h.url, "hello"));

  assert.equal(excess.status, 503, "excess generation must be rejected before spawning another agent");
  assert.deepEqual(await excess.json(), {
    _tag: "ServiceUnavailableError",
    message: "Text generation is at capacity",
    service: "opencode",
  });
  assert.equal(h.events().filter((entry) => entry.event === "spawn").length, 2);
  h.release();
  for (const response of await bounded(Promise.all(requests))) {
    assert.ok(response instanceof Response);
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
  const next = await bounded(postGeneration(h.url, "hello"));
  assert.equal(next.status, 200, "completed operations must release their slots");
  await next.arrayBuffer();
  await h.gone();
});

for (const phase of ["admission", "running"] as const) {
  test(`disconnecting a generation caller disposes its agent during ${phase}`, async (t) => {
    const h = await generationHarness(t);
    const caller = new AbortController();
    const running = h.wait(phase);
    const result = postGeneration(h.url, `fixture-generation-${phase}`, caller.signal).catch((error: unknown) => error);
    await running;

    caller.abort();

    assert.ok((await bounded(result)) instanceof Error);
    await h.gone();
  });

  test(`server stop disposes the generation agent during ${phase}`, async (t) => {
    const h = await generationHarness(t);
    const running = h.wait(phase);
    const result = postGeneration(h.url, `fixture-generation-${phase}`).catch((error: unknown) => error);
    await running;

    await bounded(h.server.stop());

    await h.gone();
    await bounded(result);
  });
}
