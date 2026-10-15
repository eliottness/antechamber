#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const countFile = process.env.REVIEW_RPC_CATALOG_COUNT_FILE;
if (countFile === undefined) throw new Error("REVIEW_RPC_CATALOG_COUNT_FILE is required");

let attempt = 0;
try {
  attempt = Number(readFileSync(countFile, "utf8"));
} catch {
  // The first catalog process creates the fixture-control state.
}
attempt++;
writeFileSync(countFile, String(attempt));

if (attempt === 1) {
  process.stdin.once("data", () => process.exit(0));
} else {
  const model = { id: "recovered-model", provider: "recovered-provider", name: "Recovered model" };
  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    const command = JSON.parse(line);
    const data =
      command.type === "get_available_models" ? { models: [model] } : command.type === "get_state" ? { model } : {};
    process.stdout.write(
      `${JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data })}\n`,
    );
  });
  input.on("close", () => process.exit(0));
}
