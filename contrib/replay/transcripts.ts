/**
 * Opens real sessions in a real OpenChamber and checks that each transcript renders a turn.
 *
 * Fake-agent tests only exercise what we believe OpenChamber and OmO do. Two "fixed" mobile
 * transcript bugs shipped because those beliefs were wrong for long, real sessions. This
 * copies the session registry and the OmO session files into a private sandbox, launches an
 * isolated OpenChamber (own HOME) whose backend is the antechamber build under test, and loads
 * every session in headless Chrome at phone and desktop sizes. The agent binary is /bin/false,
 * so nothing is revived and nothing outside the sandbox is written.
 *
 *   npm run build && npm run replay -- [--antechamber dist/cli.js] [--session ses_x]... [--limit N]
 *     [--viewport mobile|desktop|both] [--children] [--archived] [--concurrency 4] [--keep]
 *
 * Exit code 1 when any session renders without a turn; failure screenshots go to --out.
 */
import { type ChildProcess, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { defaultStateDir, envSetting } from "../../src/config.js";
import type { SessionRegistryEntry } from "../../src/session-store.js";
import { copyReplayState } from "./sandbox.js";

const { values } = parseArgs({
  options: {
    state: { type: "string" },
    antechamber: { type: "string", default: "dist/cli.js" },
    openchamber: { type: "string" },
    chrome: { type: "string" },
    session: { type: "string", multiple: true },
    limit: { type: "string" },
    viewport: { type: "string", default: "both" },
    children: { type: "boolean", default: false },
    archived: { type: "boolean", default: false },
    concurrency: { type: "string", default: "4" },
    timeout: { type: "string", default: "20000" },
    out: { type: "string" },
    keep: { type: "boolean", default: false },
  },
});

interface Viewport {
  readonly name: "mobile" | "desktop";
  readonly width: number;
  readonly height: number;
}

interface Result {
  readonly session: string;
  readonly title: string;
  readonly viewport: string;
  readonly status: "PASS" | "FAIL" | "SKIP";
  readonly detail: string;
  readonly ms: number;
}

const VIEWPORTS: Viewport[] = [
  { name: "mobile", width: 390, height: 844 },
  { name: "desktop", width: 1280, height: 900 },
];
/** OpenChamber renders each turn (a user message and its replies) as `section[data-turn-id]`. */
const TURN_SELECTOR = "[data-turn-id]";
const STARTUP_TIMEOUT_MS = 90_000;

function which(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(dir, name);
    if (dir !== "" && existsSync(candidate)) return candidate;
  }
  return undefined;
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolvePort(address.port) : reject()));
    });
  });
}

async function until<T>(what: string, deadlineMs: number, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** Minimal Chrome DevTools Protocol client over Node's built-in WebSocket. */
class Cdp {
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } };
      const waiter = message.id === undefined ? undefined : this.pending.get(message.id);
      if (waiter === undefined || message.id === undefined) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolveOpen, reject) => {
      socket.addEventListener("open", () => resolveOpen(), { once: true });
      socket.addEventListener("error", () => reject(new Error(`cannot connect to Chrome at ${url}`)), { once: true });
    });
    return new Cdp(socket);
  }

  send<T = Record<string, unknown>>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    const id = ++this.nextId;
    const reply = new Promise<T>((resolveReply, reject) =>
      this.pending.set(id, { resolve: (value) => resolveReply(value as T), reject }),
    );
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return reply;
  }

  close(): void {
    this.socket.close();
  }
}

async function stop(child: ChildProcess | undefined): Promise<void> {
  if (child?.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  // Each helper runs in its own process group, which also holds OpenChamber's adapter child.
  const signal = (name: NodeJS.Signals): void => {
    try {
      process.kill(-child.pid!, name);
    } catch {
      /* already gone */
    }
  };
  signal("SIGTERM");
  const timer = setTimeout(() => signal("SIGKILL"), 5_000);
  await exited;
  clearTimeout(timer);
}

async function main(): Promise<number> {
  const stateDir = resolve(values.state ?? envSetting("STATE_DIR") ?? defaultStateDir(homedir(), existsSync));
  const antechamber = resolve(values.antechamber);
  const openchamberBin = values.openchamber ?? which("openchamber");
  const chrome =
    values.chrome ?? ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].map(which).find(Boolean);
  if (!existsSync(antechamber)) throw new Error(`${antechamber} not found; run npm run build`);
  if (openchamberBin === undefined) throw new Error("openchamber is not on PATH; pass --openchamber");
  if (chrome === undefined) throw new Error("no Chrome or Chromium on PATH; pass --chrome");
  const viewports = VIEWPORTS.filter((v) => values.viewport === "both" || values.viewport === v.name);
  if (viewports.length === 0) throw new Error("--viewport must be mobile, desktop or both");
  const timeoutMs = Number(values.timeout);

  const registry = JSON.parse(readFileSync(join(stateDir, "sessions.json"), "utf8")) as Record<
    string,
    SessionRegistryEntry
  >;
  const wanted = values.session === undefined ? undefined : new Set(values.session);
  let selected = Object.entries(registry).filter(
    ([id, record]) =>
      (wanted === undefined || wanted.has(id)) &&
      record.piPath !== undefined &&
      existsSync(record.piPath) &&
      record.directory !== undefined &&
      existsSync(record.directory) &&
      (values.children || record.parentID === undefined) &&
      (values.archived || wanted !== undefined || record.archived === undefined),
  );
  if (values.limit !== undefined) selected = selected.slice(0, Number(values.limit));
  if (selected.length === 0) throw new Error("no session matched");

  const root = mkdtempSync(join(tmpdir(), "antechamber-replay-"));
  const out = resolve(values.out ?? join(root, "report"));
  const home = join(root, "home");
  const state = join(root, "state");
  const agent = join(root, "agent");
  mkdirSync(home);
  mkdirSync(out, { recursive: true });
  const copiedIDs = copyReplayState(stateDir, state, agent, registry, selected);
  const launcher = join(root, "opencode-antechamber");
  writeFileSync(
    launcher,
    [
      "#!/bin/sh",
      `export ANTECHAMBER_STATE_DIR=${shellQuote(state)} OMO_CODING_AGENT_DIR=${shellQuote(agent)}`,
      "export ANTECHAMBER_PI_BINARY=/bin/false ANTECHAMBER_AGENT=OmO",
      `exec ${shellQuote(process.execPath)} ${shellQuote(antechamber)} "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(launcher, 0o755);

  let openchamber: ChildProcess | undefined;
  let browser: ChildProcess | undefined;
  let cdp: Cdp | undefined;
  const cleanup = async (): Promise<void> => {
    cdp?.close();
    await Promise.all([stop(browser), stop(openchamber)]);
  };
  process.once("SIGINT", () => void cleanup().finally(() => process.exit(130)));
  try {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    openchamber = spawn(
      process.execPath,
      [realpathSync(openchamberBin), "serve", "--foreground", "--port", String(port), "--host", "127.0.0.1"],
      {
        cwd: root,
        detached: true,
        stdio: "ignore",
        env: { PATH: process.env.PATH ?? "", HOME: home, OPENCODE_BINARY: launcher },
      },
    );
    const [firstId, first] = selected[0]!;
    await until("OpenChamber and its antechamber backend", STARTUP_TIMEOUT_MS, async () => {
      const response = await fetch(
        `${base}/api/session/${firstId}/message?limit=1&directory=${encodeURIComponent(first.directory!)}`,
      );
      return response.ok ? true : undefined;
    });

    // Restored child costs are lazy; hydrate the whole copied subtree before the UI sums it.
    for (const id of copiedIDs) {
      if (registry[id]!.deleted) continue;
      const directory = encodeURIComponent(registry[id]!.directory);
      const response = await fetch(`${base}/api/session/${id}/message?limit=1&directory=${directory}`);
      if (!response.ok) throw new Error(`cannot load copied history for ${id}: HTTP ${response.status}`);
      await response.arrayBuffer();
    }

    const profile = join(root, "chrome");
    browser = spawn(
      chrome,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "about:blank",
      ],
      { detached: true, stdio: "ignore" },
    );
    const endpoint = await until("Chrome's DevTools endpoint", STARTUP_TIMEOUT_MS, async () => {
      const [port, path] = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n");
      return port && path ? `ws://127.0.0.1:${port}${path}` : undefined;
    });
    const client = await Cdp.connect(endpoint);
    cdp = client;

    const jobs = selected.flatMap(([id, record]) => viewports.map((viewport) => ({ id, record, viewport })));
    const results: Result[] = [];
    const worker = async (): Promise<void> => {
      for (let job = jobs.shift(); job !== undefined; job = jobs.shift()) {
        // A fresh context per job: OpenChamber keeps the last session and surface in localStorage.
        const { browserContextId } = await client.send<{ browserContextId: string }>("Target.createBrowserContext");
        try {
          const { targetId } = await client.send<{ targetId: string }>("Target.createTarget", {
            url: "about:blank",
            browserContextId,
          });
          const { sessionId } = await client.send<{ sessionId: string }>("Target.attachToTarget", {
            targetId,
            flatten: true,
          });
          const evaluate = async <T>(expression: string): Promise<T> =>
            (
              await client.send<{ result: { value: T } }>(
                "Runtime.evaluate",
                { expression, returnByValue: true },
                sessionId,
              )
            ).result.value;
          const { id, record, viewport } = job;
          const started = Date.now();
          const result = (status: Result["status"], detail: string): Result => ({
            session: id,
            title: record.title ?? "",
            viewport: viewport.name,
            status,
            detail,
            ms: Date.now() - started,
          });
          const directory = encodeURIComponent(record.directory!);
          const history: unknown = await (
            await fetch(`${base}/api/session/${id}/message?directory=${directory}`)
          ).json();
          const list = Array.isArray(history) ? history : [];
          if (!list.some((message) => (message as { info?: { role?: string } }).info?.role === "user")) {
            results.push(result("SKIP", "history holds no user message"));
            continue;
          }
          await client.send(
            "Emulation.setDeviceMetricsOverride",
            {
              width: viewport.width,
              height: viewport.height,
              deviceScaleFactor: 1,
              mobile: viewport.name === "mobile",
            },
            sessionId,
          );
          const surface = viewport.name === "mobile" ? "surface=mobile&" : "";
          await client.send(
            "Page.navigate",
            { url: `${base}/?${surface}directory=${directory}&session=${id}` },
            sessionId,
          );
          const turns = await until("a rendered turn", timeoutMs, async () => {
            const count = await evaluate<number>(`document.querySelectorAll(${JSON.stringify(TURN_SELECTOR)}).length`);
            return count > 0 ? count : undefined;
          }).catch(() => 0);
          if (turns > 0) {
            results.push(result("PASS", `${turns} turn(s) rendered`));
            continue;
          }
          const { data } = await client.send<{ data: string }>("Page.captureScreenshot", { format: "png" }, sessionId);
          const shot = join(out, `${id}-${viewport.name}.png`);
          writeFileSync(shot, Buffer.from(data, "base64"));
          const text = await evaluate<string>("document.body.innerText.replace(/\\s+/g, ' ').slice(0, 160)");
          results.push(result("FAIL", `no turn after ${timeoutMs} ms; ${shot}; page: ${text}`));
        } finally {
          await client.send("Target.disposeBrowserContext", { browserContextId });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Number(values.concurrency)) }, worker));

    results.sort((a, b) => a.status.localeCompare(b.status) || a.session.localeCompare(b.session));
    for (const r of results)
      console.log(
        `${r.status} ${r.viewport.padEnd(7)} ${r.session} ${JSON.stringify(r.title)} (${r.ms} ms) ${r.detail}`,
      );
    writeFileSync(join(out, "report.json"), `${JSON.stringify({ antechamber, results }, null, 2)}\n`);
    const count = (status: Result["status"]) => results.filter((r) => r.status === status).length;
    console.log(`\n${count("PASS")} pass, ${count("FAIL")} fail, ${count("SKIP")} skip; report: ${out}/report.json`);
    return count("FAIL") > 0 ? 1 : 0;
  } finally {
    await cleanup();
    if (!values.keep)
      for (const path of [home, state, agent, join(root, "chrome"), launcher])
        rmSync(path, { recursive: true, force: true });
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`replay: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  },
);
