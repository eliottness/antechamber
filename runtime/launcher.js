// extensions/antechamber/src/runtime/launcher.ts
import { readFileSync as readFileSync2 } from "node:fs";
import { dirname as dirname3, join as join3, resolve as resolve2 } from "node:path";
import { fileURLToPath } from "node:url";

// extensions/antechamber/src/runtime/activate.ts
import { basename, dirname, join } from "node:path";
function launcherPath(extensionDir2) {
  return join(extensionDir2, "bin", "opencode-antechamber");
}

// extensions/antechamber/src/runtime/runtime.ts
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname as dirname2, isAbsolute, join as join2, resolve } from "node:path";
var STALE_LOCK_MS = 15 * 6e4;
var INSTALL_TIMEOUT_MS = 10 * 6e4;
var READY = ".ready.json";
var ERROR_TAIL_CHARS = 2e3;
function defaultEnv() {
  return { env: process.env, home: homedir() };
}
function runtimeRoot({ env, home }) {
  const configured = env.ANTECHAMBER_RUNTIME_DIR?.trim();
  return configured ? resolve(configured) : join2(home, ".antechamber", "runtime");
}
function runtimePaths(version, runtime) {
  const root = runtimeRoot(runtime);
  const override = runtime.env.ANTECHAMBER_RUNTIME_SPEC?.trim();
  if (!override) return { root, spec: version, key: version, dir: join2(root, version) };
  const spec = isAbsolute(override) ? override : resolve(override);
  const stamp = existsSync(spec) ? `${statSync(spec).mtimeMs}:${statSync(spec).size}` : "";
  const key = `local-${createHash("sha256").update(`${spec}
${stamp}`).digest("hex").slice(0, 12)}`;
  return { root, spec: `file:${spec}`, key, dir: join2(root, key) };
}
function findBun({ env, home }, exists = existsSync) {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir && exists(join2(dir, "bun"))) return join2(dir, "bun");
  }
  for (const candidate of [
    join2(env.BUN_INSTALL ?? join2(home, ".bun"), "bin", "bun"),
    join2(home, ".bun", "bin", "bun")
  ]) {
    if (exists(candidate)) return candidate;
  }
  return void 0;
}
function readJson(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return typeof value === "object" && value !== null ? value : void 0;
  } catch {
    return void 0;
  }
}
function installed(dir) {
  if (!existsSync(join2(dir, READY))) return void 0;
  const cli = join2(dir, "node_modules", "antechamber", "dist", "cli.js");
  const antechamber = readJson(join2(dir, "node_modules", "antechamber", "package.json"))?.version;
  if (!existsSync(cli) || typeof antechamber !== "string") return void 0;
  const omo = readJson(join2(dir, "node_modules", "omo-ai", "package.json"))?.version;
  return { dir, cli, antechamber, omo: typeof omo === "string" ? omo : void 0 };
}
function launchStampPath(home, launcher) {
  const key = createHash("sha256").update(existsSync(launcher) ? realpathSync(launcher) : launcher).digest("hex").slice(0, 16);
  return join2(home, ".antechamber", "launches", key);
}
function writeStamp(stamp, now = Date.now()) {
  mkdirSync(dirname2(stamp), { recursive: true });
  writeFileSync(stamp, String(now));
}
function lockHeld(lock, deps) {
  let mtime;
  try {
    mtime = statSync(lock).mtimeMs;
  } catch {
    return false;
  }
  const pid = Number.parseInt(readFileSync(join2(lock, "pid"), { encoding: "utf8", flag: "a+" }), 10);
  if (deps.now() - mtime > STALE_LOCK_MS) return false;
  return !Number.isInteger(pid) || deps.pidAlive(pid);
}
function tryLock(lock, deps) {
  try {
    mkdirSync(lock);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (lockHeld(lock, deps)) return false;
    rmSync(lock, { recursive: true, force: true });
    return tryLock(lock, deps);
  }
  writeFileSync(join2(lock, "pid"), String(process.pid));
  return true;
}
function prune(paths) {
  const others = readdirSync(paths.root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name !== paths.key && !/\.(lock|tmp-.*)$/.test(entry.name)).map((entry) => join2(paths.root, entry.name)).filter((dir) => existsSync(join2(dir, READY)) && !existsSync(`${dir}.lock`)).map((dir) => ({ dir, at: Number(readJson(join2(dir, READY))?.installedAt ?? 0) })).sort((a, b) => b.at - a.at);
  for (const { dir } of others.slice(1)) rmSync(dir, { recursive: true, force: true });
}
async function installOnce(paths, bun, deps) {
  const staging = `${paths.dir}.tmp-${process.pid}-${deps.now()}`;
  mkdirSync(staging, { recursive: true });
  try {
    const manifest = {
      name: "antechamber-runtime",
      private: true,
      dependencies: { antechamber: paths.spec },
      // omo-ai's postinstall prepares its engine; Bun skips dependency scripts unless trusted.
      trustedDependencies: ["omo-ai"]
    };
    writeFileSync(join2(staging, "package.json"), `${JSON.stringify(manifest, null, 2)}
`);
    await deps.install(bun, staging);
    writeFileSync(join2(staging, READY), `${JSON.stringify({ spec: paths.spec, installedAt: deps.now() })}
`);
    if (!installed(staging)) throw new Error(`bun install did not produce node_modules/antechamber/dist/cli.js`);
    rmSync(paths.dir, { recursive: true, force: true });
    renameSync(staging, paths.dir);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  const runtime = installed(paths.dir);
  if (!runtime) throw new Error(`runtime vanished from ${paths.dir}`);
  return runtime;
}
async function ensureRuntime(paths, bun, deps = defaultDeps()) {
  const lock = `${paths.dir}.lock`;
  for (; ; ) {
    const ready = installed(paths.dir);
    if (ready) return ready;
    if (!bun) throw new Error("bun not found on PATH or in ~/.bun/bin; install it from https://bun.sh");
    mkdirSync(paths.root, { recursive: true });
    if (!tryLock(lock, deps)) {
      await deps.pause();
      continue;
    }
    try {
      const raced = installed(paths.dir);
      if (raced) return raced;
      const runtime = await installOnce(paths, bun, deps);
      rmSync(`${paths.dir}.error`, { force: true });
      prune(paths);
      return runtime;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeFileSync(`${paths.dir}.error`, message.slice(-ERROR_TAIL_CHARS));
      throw error;
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }
}
function bunInstall(bun, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bun, ["install", "--production", "--no-progress"], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    const keep = (chunk) => {
      output = (output + chunk.toString("utf8")).slice(-ERROR_TAIL_CHARS);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => child.kill("SIGTERM"), INSTALL_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else reject(new Error(`bun install failed (${signal ?? `exit ${code}`}): ${output.trim()}`));
    });
  });
}
function defaultDeps() {
  return {
    install: bunInstall,
    pause: () => new Promise((done) => setTimeout(done, 500)),
    now: Date.now,
    pidAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return error.code === "EPERM";
      }
    }
  };
}

// extensions/antechamber/src/runtime/launcher.ts
var extensionDir = resolve2(dirname3(fileURLToPath(import.meta.url)), "..");
var command = process.argv[2];
if (command === "version") {
  console.log(`opencode v${"2.999.0"}`);
} else if (command === "resolve") {
  const { version } = JSON.parse(readFileSync2(join3(extensionDir, "package.json"), "utf8"));
  const env = defaultEnv();
  try {
    const paths = runtimePaths(version, env);
    const runtime = await ensureRuntime(paths, findBun(env) ?? process.execPath);
    try {
      writeStamp(launchStampPath(env.home, launcherPath(extensionDir)));
    } catch (error) {
      console.error(
        `opencode-antechamber: could not record the launch: ${error instanceof Error ? error.message : error}`
      );
    }
    console.log(runtime.cli);
  } catch (error) {
    console.error(`opencode-antechamber: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
} else {
  console.error(`opencode-antechamber: unknown launcher command '${command ?? ""}'`);
  process.exit(2);
}
