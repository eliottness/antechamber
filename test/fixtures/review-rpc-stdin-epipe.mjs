#!/usr/bin/env node
import childProcess, { ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { PiRpcClient } from "../../src/pi-rpc.ts";

const stdin = new PassThrough();
const stdout = new PassThrough();
const stderr = new PassThrough();
const proc = Object.assign(new ChildProcess(), { stdin, stdout, stderr });
childProcess.spawn = () => proc;
syncBuiltinESMExports();

const pi = new PiRpcClient({ cwd: process.cwd() });
const pending = pi.command({ type: "get_state" });
stdin.emit("error", Object.assign(new Error("broken stdin pipe"), { code: "EPIPE" }));

await pending.then(
  () => {
    throw new Error("stdin EPIPE unexpectedly resolved the pending RPC command");
  },
  (error) => {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EPIPE") throw error;
    process.stdout.write("EPIPE_REJECTED\n");
  },
);
await pi.dispose();
