/**
 * pi RPC subprocess client.
 *
 * Speaks pi's headless JSONL protocol (`pi --mode rpc`): commands go to stdin,
 * responses and events come back on stdout. Framing is strict LF-only JSONL —
 * pi's docs warn that generic line readers (Node `readline`) also split on
 * U+2028/U+2029, which are legal inside JSON strings, so we split on "\n"
 * ourselves and only strip a single trailing "\r".
 */

import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { systemClock, type LifecycleClock } from "./lifecycle.js";
import { agentBinary, envSetting } from "./config.js";

export interface PiRpcCommand {
  id?: string;
  type: string;
  [key: string]: unknown;
}

export const RPC_COMMAND_TIMEOUT_MS = 60_000;
/**
 * `compact` answers only when the summary is written. OmO bounds one compaction by
 * its SUMMARIZATION_MAX_DURATION_CAP_MS (30 min); the generic 60 s budget gave up
 * long before a large session finished, leaving the run orphaned.
 */
export const COMPACT_RPC_TIMEOUT_MS = 31 * 60_000;
const MAX_JSONL_FRAME_BYTES = 64 * 1024 * 1024;
export class UpstreamProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamProtocolError";
  }
}
const PROCESS_KILL_GRACE_MS = 5_000;

/** A process's group and kernel start time: with the PID, the identity that survives PID reuse checks. */
interface ProcessIdentity {
  readonly pid: number;
  readonly group: number;
  readonly start: string;
}

/** Reads process identities so disposal can tell owned survivors from a reused PID. */
export interface ProcessTable {
  identity(pid: number): ProcessIdentity | undefined;
  groupMembers(group: number): ProcessIdentity[];
}

// Linux /proc. Any read failure (gone, no permission, no /proc) means the identity cannot be
// verified, and an unverifiable process is never signalled: fail closed.
const procTable: ProcessTable = {
  identity(pid) {
    let stat: string;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    } catch {
      return undefined;
    }
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { pid, group: Number(fields[2]), start: fields[19] ?? "" };
  },
  groupMembers(group) {
    let names: string[];
    try {
      names = readdirSync("/proc");
    } catch {
      return [];
    }
    return names
      .filter((name) => /^\d+$/.test(name))
      .flatMap((name) => procTable.identity(Number(name)) ?? [])
      .filter((member) => member.group === group);
  },
};

export type PiRpcResponse<T = unknown> = {
  readonly id: string;
  readonly type: "response";
  readonly command: string;
} & (
  | { readonly success: true; readonly data?: T; readonly error?: never }
  | {
      readonly success: false;
      readonly error?: string;
      readonly errorCode?: string;
      readonly errorData?: unknown;
      readonly data?: never;
    }
);

interface PiRpcClientOptions {
  cwd: string;
  /** Path/name of the pi binary. Defaults to ANTECHAMBER_PI_BINARY env or "omo" from PATH. */
  piBinary?: string;
  /** Extra CLI flags, e.g. ["--no-session"] or ["--provider", "x"]. */
  args?: string[];
  clock?: LifecycleClock;
  processTable?: ProcessTable;
}

interface PendingRequest {
  command: string;
  resolve: (r: PiRpcResponse) => void;
  reject: (e: Error) => void;
}

export class PiRpcClient extends EventEmitter {
  private proc: ChildProcess;
  private buffer = "";
  private bufferBytes = 0;
  private decoder = new StringDecoder("utf8");
  private pending = new Map<string, PendingRequest>();
  private closed = false;
  private stderrTail = "";
  private disposing: Promise<void> | undefined;

  get pid(): number | undefined {
    return this.proc.pid;
  }

  get isBusy(): boolean {
    return this.pending.size > 0;
  }

  onEvent(listener: (payload: Record<string, unknown>) => void): this {
    return super.on("event", listener);
  }

  onExit(listener: (code: number | null, signal: string | null) => void): this {
    return super.on("exit", listener);
  }

  onExtensionUI(listener: (request: Record<string, unknown>) => void): this {
    return super.on("extension_ui_request", listener);
  }

  constructor(private options: PiRpcClientOptions) {
    super();
    const extraArgs = envSetting("PI_ARGS")?.trim().split(/\s+/).filter(Boolean) ?? [];
    const args = ["--mode", "rpc", ...(options.args ?? []), ...extraArgs];
    const capabilities = [
      ...new Set(
        [
          ...(process.env.OMO_RPC_CLIENT_CAPABILITIES ?? "").split(","),
          ...(process.env.SENPI_RPC_CLIENT_CAPABILITIES ?? "").split(","),
          "auto_title_sessions",
          "question",
          // Extension `pi.rpc.emit` frames, e.g. the terminal extension's monitor state.
          "extension_events",
        ]
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ].join(",");
    this.proc = spawn(options.piBinary ?? agentBinary(), args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        OMO_RPC_CLIENT_CAPABILITIES: capabilities,
        SENPI_RPC_CLIENT_CAPABILITIES: capabilities,
      },
      detached: true,
    });

    this.proc.stderr!.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-8192);
    });

    this.proc.stdin?.on("error", (error) => {
      this.closeForTransportFailure(error);
    });
    this.proc.stdout!.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
      this.buffer += text;
      this.bufferBytes += Buffer.byteLength(text);
      this.drain();
    });
    this.proc.stdout!.on("end", () => {
      const text = this.decoder.end();
      this.buffer += text;
      this.bufferBytes += Buffer.byteLength(text);
      this.drain();
      this.closeForTransportFailure(new Error("pi process closed stdout"));
    });
    this.proc.on("error", (err) => {
      this.closeForTransportFailure(err);
    });
    this.proc.on("exit", (code, signal) => {
      this.closed = true;
      console.error(
        `[pi-rpc] process exited code=${code} signal=${signal}` +
          (envSetting("DEBUG") && this.stderrTail ? `\n[pi-rpc] stderr tail:\n${this.stderrTail}` : ""),
      );
      this.failAll(new Error(`pi exited (code=${code} signal=${signal})`));
      this.emit("exit", code, signal);
    });
  }

  private drain(): void {
    for (;;) {
      const idx = this.buffer.indexOf("\n");
      if (idx === -1) {
        if (this.bufferBytes > MAX_JSONL_FRAME_BYTES) this.frameOverflow();
        return;
      }
      let line = this.buffer.slice(0, idx);
      const frameBytes = Buffer.byteLength(line);
      if (frameBytes > MAX_JSONL_FRAME_BYTES) {
        this.frameOverflow();
        return;
      }
      this.buffer = this.buffer.slice(idx + 1);
      this.bufferBytes -= frameBytes + 1;
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length === 0) continue;
      this.handleLine(line);
    }
  }

  private frameOverflow(): void {
    const error = new Error(`pi JSONL frame exceeded ${MAX_JSONL_FRAME_BYTES} bytes`);
    this.closed = true;
    this.buffer = "";
    this.bufferBytes = 0;
    this.failAll(error);
    this.proc.stdout?.destroy();
    if (this.proc.pid === undefined) this.proc.kill("SIGKILL");
    else if (!this.reaped()) process.kill(-this.proc.pid, "SIGKILL");
  }

  /** Node has reaped the leader, so its PID (and group ID) may already belong to another process. */
  private reaped(): boolean {
    return this.proc.exitCode !== null || this.proc.signalCode !== null;
  }

  private closeForTransportFailure(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.failAll(error);
    void this.dispose().catch((disposeError: unknown) => {
      const message = disposeError instanceof Error ? disposeError.message : String(disposeError);
      console.error(`[pi-rpc] failed to dispose after transport failure: ${message}`);
    });
  }

  private handleLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      // Non-JSON noise on stdout; ignore but keep going.
      return;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return;
    const msg = value as Record<string, unknown>;

    if (msg.type === "response") {
      const pending = typeof msg.id === "string" ? this.pending.get(msg.id) : undefined;
      if (
        typeof msg.id !== "string" ||
        typeof msg.success !== "boolean" ||
        typeof msg.command !== "string" ||
        (msg.error !== undefined && typeof msg.error !== "string")
      ) {
        const error = new Error("pi returned a malformed RPC response");
        console.error(`[pi-rpc] ${error.message}`);
        pending?.reject(error);
        return;
      }
      if (pending !== undefined && pending.command !== msg.command) {
        const error = new Error(
          `pi returned mismatched RPC response command "${msg.command}" for pending command "${pending.command}"`,
        );
        console.error(`[pi-rpc] ${error.message}`);
        pending.reject(error);
        return;
      }
      const response: PiRpcResponse = msg.success
        ? { type: "response", id: msg.id, command: msg.command, success: true, data: msg.data }
        : {
            type: "response",
            id: msg.id,
            command: msg.command,
            success: false,
            ...(msg.error !== undefined ? { error: msg.error } : {}),
            ...(typeof msg.errorCode === "string" ? { errorCode: msg.errorCode } : {}),
            ...(msg.errorData !== undefined ? { errorData: msg.errorData } : {}),
          };
      pending?.resolve(response);
      return;
    }

    if (msg.type === "extension_ui_request") {
      this.handleExtensionUI(msg);
      return;
    }

    this.emit("event", msg);
  }

  private handleExtensionUI(msg: Record<string, unknown>): void {
    const method = msg.method as string | undefined;
    const id = msg.id as string | undefined;
    if (!id || !method) return;
    const blocking = new Set(["select", "confirm", "input", "editor"]);
    if (!blocking.has(method) && method !== "notify" && method !== "question") return;
    this.emit("extension_ui_request", msg);
  }

  respondExtensionUI(response: Record<string, unknown>): void {
    this.write(response);
  }

  private write(obj: Record<string, unknown>): void {
    if (this.closed) return;
    this.proc.stdin!.write(`${JSON.stringify(obj)}\n`);
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  /** Send a command and wait for its correlated response. */
  command<T = unknown>(
    cmd: Omit<PiRpcCommand, "id">,
    timeoutMs = RPC_COMMAND_TIMEOUT_MS,
    signal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<PiRpcResponse<T>> {
    if (this.closed) return Promise.reject(new Error("pi process is not running"));
    if (signal?.aborted) return Promise.reject(signal.reason);
    const id = randomUUID();
    const expectedCommand = String(cmd.type);
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
      };
      const rejectCommand = (reason: unknown): void => {
        cleanup();
        reject(reason);
      };
      const onAbort = (): void => {
        rejectCommand(signal?.reason);
      };
      const timer = setTimeout(() => {
        this.closeForTransportFailure(new Error(`pi command "${expectedCommand}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        command: expectedCommand,
        resolve: (r) => {
          cleanup();
          // The envelope is checked at the transport boundary; callers own data schemas.
          resolve(r.success ? { ...r, data: r.data as T } : r);
        },
        reject: rejectCommand,
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.write({ ...cmd, id });
      onDispatch?.();
    });
  }

  /** Fire-and-forget command (no response correlation). */
  notify(cmd: Omit<PiRpcCommand, "id">): void {
    this.write(cmd);
  }

  async dispose(): Promise<void> {
    if (this.disposing !== undefined) return this.disposing;
    this.closed = true;
    this.failAll(new Error("pi process disposed"));
    const pid = this.proc.pid;
    if (pid === undefined || this.reaped()) return;
    const clock = this.options.clock ?? systemClock;
    const table = this.options.processTable ?? procTable;
    const signal = (target: number, sig: NodeJS.Signals): void => {
      try {
        process.kill(target, sig);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
        throw error;
      }
    };
    // Until Node reaps the leader its PID, and therefore the group ID, cannot be reused, so group
    // signals are safe only before "exit". Record the members now; after the leader exits, a
    // grandchild is killed only when its PID still has the same group and start time.
    const owned = table.groupMembers(pid).filter((member) => member.pid !== pid);
    const survivors = (): number[] =>
      owned
        .filter((member) => {
          const now = table.identity(member.pid);
          return now !== undefined && now.group === member.group && now.start === member.start;
        })
        .map((member) => member.pid);
    this.disposing = new Promise<void>((resolve) => {
      const finish = (): void => {
        clock.clearTimeout(timer);
        this.proc.off("exit", onExit);
        resolve();
      };
      const onExit = (): void => {
        if (survivors().length === 0) finish();
      };
      this.proc.once("exit", onExit);
      const timer = clock.setTimeout(() => {
        if (!this.reaped()) {
          signal(-pid, "SIGKILL");
          this.proc.off("exit", onExit);
          this.proc.once("exit", finish);
          return;
        }
        for (const member of survivors()) signal(member, "SIGKILL");
        finish();
      }, PROCESS_KILL_GRACE_MS);
      signal(-pid, "SIGTERM");
      this.proc.stdin?.end();
    });
    return this.disposing;
  }
}
