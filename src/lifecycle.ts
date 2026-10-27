import type { ManagedSession } from "./sessions.js";
import { ENV_PREFIX, envSetting } from "./config.js";

const MAX_REAPER_INTERVAL_MS = 15_000;

/** Time and scheduling seams shared by the reaper and process shutdown tests. */
export interface LifecycleClock {
  now(): number;
  setInterval(callback: () => void, ms: number): ReturnType<typeof setInterval>;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

export const systemClock: LifecycleClock = {
  now: Date.now,
  setInterval,
  clearInterval,
  setTimeout,
  clearTimeout,
};

export interface LifecycleOptions {
  clock?: LifecycleClock;
  idleTimeoutMs?: number;
  maxLive?: number;
  reaperIntervalMs?: number;
}

function positiveEnv(name: string, fallback: number): number {
  const value = Number(envSetting(name) ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${ENV_PREFIX}${name} must be a positive integer`);
  return value;
}

/** Serializes admission, reaping, removal and shutdown, including in-flight spawns. */
export class SessionLifecycle {
  readonly clock: LifecycleClock;
  private readonly idleTimeoutMs: number;
  private readonly maxLive: number;
  private readonly reaperIntervalMs: number;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly used = new WeakMap<ManagedSession, number>();
  private readonly active = new WeakMap<ManagedSession, number>();
  private readonly disposing = new Set<Promise<void>>();
  private tail: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private stopping: Promise<void> | undefined;

  constructor(
    private sessions: () => Iterable<ManagedSession>,
    options: LifecycleOptions = {},
  ) {
    this.clock = options.clock ?? systemClock;
    this.idleTimeoutMs = options.idleTimeoutMs ?? positiveEnv("IDLE_TIMEOUT_MS", 900_000);
    this.maxLive = options.maxLive ?? positiveEnv("MAX_LIVE", 8);
    this.reaperIntervalMs =
      options.reaperIntervalMs ?? Math.min(MAX_REAPER_INTERVAL_MS, Math.max(1_000, Math.floor(this.idleTimeoutMs / 4)));
    if (!Number.isSafeInteger(this.reaperIntervalMs) || this.reaperIntervalMs <= 0) {
      throw new Error("reaperIntervalMs must be a positive integer");
    }
    this.timer = this.clock.setInterval(() => {
      void this.reap().catch((error: unknown) => console.error("[lifecycle] reaper failed:", error));
    }, this.reaperIntervalMs);
    this.timer.unref();
  }

  touch(s: ManagedSession): void {
    this.used.set(s, this.clock.now());
  }

  lastUsed(s: ManagedSession): number {
    return this.used.get(s) ?? 0;
  }

  private idle(s: ManagedSession): boolean {
    return (
      !this.active.has(s) &&
      s.pi !== undefined &&
      !s.pi.isBusy &&
      s.status.type === "idle" &&
      !s.hasPendingInteraction() &&
      !s.hasRunningChildren() &&
      !s.hasBackgroundWork?.() &&
      !s.hasWakeSources?.() &&
      s.piSessionId !== undefined &&
      s.piPath !== undefined
    );
  }

  /** Protect the caller across awaits, including admission of a dormant session. */
  async use<T>(s: ManagedSession, action: () => Promise<T>): Promise<T> {
    if (this.stopped) throw new Error("session manager is stopping");
    this.active.set(s, (this.active.get(s) ?? 0) + 1);
    this.touch(s);
    try {
      return await action();
    } finally {
      const remaining = (this.active.get(s) ?? 1) - 1;
      if (remaining === 0) this.active.delete(s);
      else this.active.set(s, remaining);
      this.touch(s);
    }
  }

  run<T>(action: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error("session manager is stopping"));
    return this.enqueue(action);
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const next = this.tail.then(action);
    this.tail = next.catch(() => undefined);
    return next;
  }

  /** Called inside run(), before a process is spawned. */
  async makeRoom(): Promise<void> {
    while ([...this.sessions()].filter((s) => s.pi !== undefined).length >= this.maxLive) {
      const candidate = [...this.sessions()]
        .filter((s) => this.idle(s))
        .sort((a, b) => (this.used.get(a) ?? 0) - (this.used.get(b) ?? 0))[0];
      if (candidate === undefined) {
        throw new Error(`${ENV_PREFIX}MAX_LIVE=${this.maxLive} reached: no disposable idle session`);
      }
      await this.dormant(candidate);
    }
  }

  async dormant(s: ManagedSession): Promise<void> {
    const pi = s.pi;
    if (pi === undefined) return;
    if (s.piSessionId !== undefined && s.piPath !== undefined) {
      s.restored = { piSessionId: s.piSessionId, piPath: s.piPath };
    }
    s.unwirePi?.();
    s.pi = undefined; // Old exit listeners must not mutate a revived session.
    // Unwired, the exit handler will not run: end what died with the process here.
    s.onDormant?.();
    const disposing = pi.dispose();
    this.disposing.add(disposing);
    try {
      await disposing;
    } finally {
      this.disposing.delete(disposing);
    }
  }

  reap(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.run(async () => {
      const now = this.clock.now();
      for (const s of this.sessions()) {
        if (this.idle(s) && now - (this.used.get(s) ?? now) >= this.idleTimeoutMs) {
          await this.dormant(s);
        }
      }
    });
  }

  stop(): Promise<void> {
    if (this.stopping !== undefined) return this.stopping;
    this.stopped = true;
    this.clock.clearInterval(this.timer);
    this.stopping = this.enqueue(async () => {
      await Promise.all([...[...this.sessions()].map((s) => this.dormant(s)), ...this.disposing]);
    });
    return this.stopping;
  }
}
