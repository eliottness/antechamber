import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { AdapterServer } from "../src/server.js";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

async function startServer(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "antechamber-v124-events-ws-"));
  const previousState = process.env.ANTECHAMBER_STATE_DIR;
  process.env.ANTECHAMBER_STATE_DIR = join(directory, "state");
  const server = new AdapterServer({ host: "127.0.0.1", port: 0, defaultDirectory: directory });
  t.after(async () => {
    await server.stop();
    if (previousState === undefined) delete process.env.ANTECHAMBER_STATE_DIR;
    else process.env.ANTECHAMBER_STATE_DIR = previousState;
    rmSync(directory, { recursive: true, force: true });
  });
  await server.start();
  return server.url;
}

function firstTextFrame(data: Buffer): string | undefined {
  if (data.length < 2) return undefined;
  let offset = 2;
  const second = data[1];
  if (second === undefined) return undefined;
  let length = second & 0x7f;
  if (length === 126) {
    if (data.length < 4) return undefined;
    length = data.readUInt16BE(2);
    offset = 4;
  }
  if (length === 127 || data.length < offset + length) return undefined;
  return data.subarray(offset, offset + length).toString("utf8");
}

function openGlobalEventWebSocket(baseUrl: string): Promise<{ status: number; frame?: unknown }> {
  const base = new URL(baseUrl);
  return new Promise((resolve) => {
    const timeout = AbortSignal.timeout(5_000);
    const req = request({
      hostname: base.hostname,
      port: base.port,
      path: "/api/global/event/ws",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    const finish = (result: { status: number; frame?: unknown }) => {
      timeout.removeEventListener("abort", expired);
      resolve(result);
    };
    const expired = () => {
      req.destroy();
      finish({ status: 0 });
    };
    timeout.addEventListener("abort", expired, { once: true });
    req.once("response", (response) => {
      response.resume();
      finish({ status: response.statusCode ?? 0 });
    });
    req.once("upgrade", (response, socket, head) => {
      let received = head;
      const receive = (chunk: Buffer) => {
        received = Buffer.concat([received, chunk]);
        const text = firstTextFrame(received);
        if (text === undefined) return;
        socket.destroy();
        finish({ status: response.statusCode ?? 0, frame: JSON.parse(text) });
      };
      const immediate = firstTextFrame(received);
      if (immediate !== undefined) {
        socket.destroy();
        finish({ status: response.statusCode ?? 0, frame: JSON.parse(immediate) });
        return;
      }
      socket.on("data", receive);
      socket.on("error", () => finish({ status: response.statusCode ?? 0 }));
    });
    req.once("error", () => finish({ status: 0 }));
    req.end();
  });
}

test("V124-013: upgrades the global event WebSocket", { timeout: 10_000 }, async (t) => {
  const url = await startServer(t);
  const response = await openGlobalEventWebSocket(url);
  assert.equal(response.status, 101);
  if (!isRecord(response.frame)) throw new TypeError("expected a WebSocket ready frame");
  assert.equal(response.frame.type, "ready");
});
