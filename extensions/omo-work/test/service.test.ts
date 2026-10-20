import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { type AdapterServer, discoverServers } from "../src/discovery.ts";
import { createServer } from "../src/service.ts";

const TOKEN = "service-token";

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A stand-in antechamber that answers the work-status route for the sessions it holds. */
function fakeAdapter(token: string, sessions: Record<string, { live: boolean }>) {
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    if (req.headers.authorization !== `Bearer ${token}`) return res.writeHead(401).end("{}");
    const [, , , session, ...rest] = (req.url ?? "").split("?")[0]!.split("/");
    const known = session === undefined ? undefined : sessions[session];
    if (known === undefined) return res.writeHead(404).end("{}");
    if (rest.length === 0) {
      const body = { version: 1, sessionID: session, live: known.live, todo: [], monitors: [], evalCells: [] };
      return res.writeHead(200).end(JSON.stringify({ ...body, background: [], wakeSources: [], goal: null }));
    }
    if (rest[0] === "eval" && rest[2] === "stop") return res.writeHead(200).end(JSON.stringify({ state: "cancelled" }));
    if (rest[0] === "goal") return res.writeHead(204).end();
    res.writeHead(404).end("{}");
  });
  return { server, calls };
}

describe("discovery", () => {
  test("lists live servers with a token, newest first, and maps wildcard binds to loopback", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "omo-work-run-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, "run"));
    const write = (pid: number, record: unknown) =>
      writeFileSync(join(dir, "run", `${pid}.json`), JSON.stringify(record));
    write(1, { pid: 1, version: "1.0.0", url: "http://0.0.0.0:4100", started: "2026-10-20T10:00:00Z", token: "a" });
    write(2, { pid: 2, version: "1.0.0", url: "http://127.0.0.1:4200", started: "2026-10-20T11:00:00Z", token: "b" });
    write(3, { pid: 3, version: "0.2.37", url: "http://127.0.0.1:4300", started: "2026-10-20T12:00:00Z" });
    write(4, { pid: 4, version: "1.0.0", url: "http://127.0.0.1:4400", started: "2026-10-20T13:00:00Z", token: "d" });
    writeFileSync(join(dir, "run", "5.json"), "{ torn");
    const servers = discoverServers([dir, join(dir, "missing")], (pid) => pid !== 4);
    assert.deepEqual(
      servers.map((server) => [server.pid, server.url]),
      [
        [2, "http://127.0.0.1:4200"],
        [1, "http://127.0.0.1:4100"],
      ],
    );
  });
});

describe("service", () => {
  const idle = fakeAdapter("idle-token", { ses_a: { live: false } });
  const live = fakeAdapter("live-token", { ses_a: { live: true }, ses_b: { live: true } });
  let servers: AdapterServer[] = [];
  let base = "";
  let service: http.Server;

  before(async () => {
    // The idle server is newer, so only the live flag can make the other one win.
    servers = [
      { pid: 10, url: await listen(idle.server), token: "idle-token", started: "2026-10-20T12:00:00Z" },
      { pid: 11, url: await listen(live.server), token: "live-token", started: "2026-10-20T11:00:00Z" },
    ];
    service = createServer({ token: TOKEN, discover: () => servers, defaultDirs: () => ["/state"] });
    base = await listen(service);
  });

  after(() => {
    service.close();
    idle.server.close();
    live.server.close();
  });

  const call = (path: string, method = "GET", token = TOKEN) =>
    fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}` } });

  test("rejects requests without the host token and validates ids", async () => {
    assert.equal((await call("/status?session=ses_a", "GET", "nope")).status, 401);
    assert.equal((await call("/status?session=../x")).status, 400);
    assert.equal((await call("/eval?session=ses_a&cell=a/b")).status, 400);
  });

  test("prefers the server that runs the session's agent over one that only knows it from disk", async () => {
    const response = await call("/status?session=ses_a");
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { live: boolean }).live, true);
  });

  test("relays actions to the server that answered for the session", async () => {
    live.calls.length = 0;
    assert.equal((await call("/status?session=ses_b")).status, 200);
    const stop = await call("/eval/stop?session=ses_b&cell=cell_1", "POST");
    assert.equal(stop.status, 200);
    assert.deepEqual(await stop.json(), { state: "cancelled" });
    assert.equal((await call("/goal/fire?session=ses_b", "POST")).status, 204);
    assert.deepEqual(live.calls, [
      "GET /antechamber/work-status/ses_b",
      "POST /antechamber/work-status/ses_b/eval/cell_1/stop",
      "POST /antechamber/work-status/ses_b/goal/fire",
    ]);
  });

  test("explains a missing server instead of failing silently", async () => {
    const empty = createServer({ token: TOKEN, discover: () => [], defaultDirs: () => ["/state"] });
    const url = await listen(empty);
    try {
      const response = await fetch(`${url}/status?session=ses_a`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      assert.equal(response.status, 503);
      assert.match(((await response.json()) as { detail: string }).detail, /\/state/);
    } finally {
      empty.close();
    }
  });
});
