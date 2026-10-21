import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { AdapterServer } from "../src/server.js";
import { ocIdFor } from "../src/session-store.js";
import { bugHarness } from "./bug-harness.js";

test("v2 session projections refresh each dormant native title without rescanning unrelated sessions", async (t) => {
  const h = bugHarness(t);
  const directory = join(h.root, "project");
  const folder = join(h.root, "agent", "sessions", `--${directory.replace(/^\/+/, "").replaceAll("/", "-")}--`);
  mkdirSync(folder, { recursive: true });
  const ids = ["first", "second", "third", "fourth"];
  for (const id of ids) {
    writeFileSync(
      join(folder, `${id}.jsonl`),
      `${JSON.stringify({ type: "session", version: 3, id, cwd: directory, timestamp: "2026-10-01T00:00:00Z" })}\n` +
        `${JSON.stringify({ type: "session_info", name: id })}\n`,
    );
  }
  const server = new AdapterServer({ host: "127.0.0.1", port: 0, defaultDirectory: directory });
  await server.start();
  t.after(() => server.stop());
  const manager = server["sessions"];
  manager.listAll();
  const refresh = t.mock.fn(manager["applyNativeTitle"].bind(manager));
  manager["applyNativeTitle"] = refresh;
  for (const id of ids) {
    appendFileSync(join(folder, `${id}.jsonl`), `${JSON.stringify({ type: "session_info", name: `${id} renamed` })}\n`);
  }

  const response = await fetch(`${server.url}/api/session`);

  assert.equal(response.status, 200);
  const page: unknown = await response.json();
  assert.ok(page !== null && typeof page === "object" && "data" in page && Array.isArray(page.data));
  assert.deepEqual(
    new Map(page.data.map((session) => [session.id, session.title])),
    new Map(ids.map((id) => [ocIdFor(id), `${id} renamed`])),
  );
  assert.equal(refresh.mock.callCount(), ids.length * 2, "one list refresh and one targeted lookup per session");
});

test("cached get adopts only the requested native rename and a later list refreshes the others", (t) => {
  const h = bugHarness(t);
  const folder = join(h.root, "agent", "sessions", `--${h.root.replace(/^\/+/, "").replaceAll("/", "-")}--`);
  mkdirSync(folder, { recursive: true });
  for (const id of ["selected", "other"]) {
    writeFileSync(
      join(folder, `${id}.jsonl`),
      `${JSON.stringify({ type: "session", version: 3, id, cwd: h.root, timestamp: "2026-10-01T00:00:00Z" })}\n` +
        `${JSON.stringify({ type: "session_info", name: id })}\n`,
    );
  }
  const listed = h.manager.listAll();
  const other = listed.find((session) => session.id === ocIdFor("other"));
  assert.ok(other);
  for (const id of ["selected", "other"]) {
    appendFileSync(join(folder, `${id}.jsonl`), `${JSON.stringify({ type: "session_info", name: `${id} renamed` })}\n`);
  }

  const selected = h.manager.get(ocIdFor("selected"));

  assert.equal(selected?.info.title, "selected renamed");
  assert.equal(other.title, "other");
  assert.equal(h.manager.listAll().find((session) => session.id === other.id)?.title, "other renamed");
});
