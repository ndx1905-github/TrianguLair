// SPDX-License-Identifier: MPL-2.0
/**
 * When to sync (spec "Synchronization and background"):
 *
 * - on launch and when the app comes back to the foreground: right away;
 * - during use: a regular refresh (`intervalMs`), and on demand (pull to refresh);
 * - after a local change: a debounced publication (`debounceMs`);
 * - right after closing (background): one last pass to send pending changes,
 *   within the grace period the system gives; then NOTHING: no timer, no
 *   periodic task, no wake-up;
 * - offline: nothing is attempted; changes wait ("Offline · 3 changes
 *   pending") and a pass runs as soon as the network is back;
 * - failures: transient ones are retried with a growing delay while the app
 *   is in use; credentials rejected (and other blocking problems) stop
 *   automatic passes until the user acts (`resume()`).
 *
 * Timers are injectable so the policy is tested without waiting.
 */
import type { SyncProblem } from './errors.ts';
import type { SyncReport } from './engine.ts';

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export type SyncReason = 'launch' | 'foreground' | 'interval' | 'change' | 'pull-to-refresh' | 'background' | 'online' | 'retry';

export interface SchedulerOptions {
  run: (reason: SyncReason) => Promise<SyncReport>;
  /** Refresh period while the app is in use (default 5 min; the spec leaves the value open). */
  intervalMs?: number;
  /** Delay after the last local change before publishing (default 3 s). */
  debounceMs?: number;
  /** Retry delays after a transient failure of my storage (default 30 s, 1, 2, 5, 15, 30 min). */
  backoffMs?: readonly number[];
  /** "Your storage hasn't responded since yesterday" after this long (default 24 h). */
  bannerAfterMs?: number;
  timers?: Timers;
  onReport?: (r: SyncReport) => void;
  onStatus?: (s: SyncStatus) => void;
}

export interface SyncStatus {
  state: 'idle' | 'syncing' | 'offline' | 'blocked' | 'background';
  foreground: boolean;
  online: boolean;
  /** Local changes not yet published. */
  pending: number;
  lastSuccess: number | null;
  /** First failure of the current failing streak of my storage. */
  failingSince: number | null;
  /** The problem that blocks or delays my storage, if any. */
  problem: SyncProblem | null;
  /** Show the "storage hasn't responded" banner (failing for longer than bannerAfterMs). */
  banner: boolean;
}

export class SyncScheduler {
  private readonly t: Timers;
  private readonly o: SchedulerOptions;
  private foreground = false;
  private online = true;
  private pending = 0;
  private inFlight: Promise<void> | null = null;
  private again: SyncReason | null = null;
  private timer: unknown = null;
  private debounce: unknown = null;
  private failures = 0;
  private status: SyncStatus = {
    state: 'background', foreground: false, online: true, pending: 0, lastSuccess: null, failingSince: null, problem: null, banner: false,
  };

  constructor(o: SchedulerOptions) {
    this.o = o;
    this.t = o.timers ?? realTimers;
  }

  getStatus(): SyncStatus {
    return { ...this.status };
  }

  /** The app was launched or came back to the foreground: sync now, then every `intervalMs` while in use. */
  appForeground(reason: 'launch' | 'foreground' = 'foreground'): Promise<void> {
    this.foreground = true;
    return this.trigger(reason);
  }

  /** The app goes to the background or is closed: finish and send pending changes once, then stop every timer. */
  appBackground(): Promise<void> {
    this.foreground = false;
    this.clearTimers();
    const p = this.pending > 0 || this.inFlight ? this.trigger('background') : Promise.resolve();
    return p.finally(() => {
      this.clearTimers();
      this.update({});
    });
  }

  /** A local edit: publish after `debounceMs` without further edits. */
  localChange(): void {
    this.pending++;
    this.update({});
    if (!this.foreground || !this.online || this.status.state === 'blocked') return;
    if (this.debounce !== null) this.t.clearTimeout(this.debounce);
    this.debounce = this.t.setTimeout(() => {
      this.debounce = null;
      void this.trigger('change');
    }, this.o.debounceMs ?? 3000);
  }

  pullToRefresh(): Promise<void> {
    return this.trigger('pull-to-refresh', true);
  }

  setOnline(online: boolean): void {
    const was = this.online;
    this.online = online;
    this.update({});
    if (online && !was && this.foreground) void this.trigger('online');
  }

  /** The user fixed a blocking problem (reconnected the storage): sync again. */
  resume(): Promise<void> {
    this.update({ problem: null, state: 'idle' });
    this.failures = 0;
    return this.trigger('retry', true);
  }

  stop(): void {
    this.foreground = false;
    this.clearTimers();
  }

  private clearTimers(): void {
    if (this.timer !== null) this.t.clearTimeout(this.timer);
    if (this.debounce !== null) this.t.clearTimeout(this.debounce);
    this.timer = null;
    this.debounce = null;
  }

  private update(p: Partial<SyncStatus>): void {
    const s = { ...this.status, ...p, foreground: this.foreground, online: this.online, pending: this.pending };
    if (!this.online) s.state = 'offline';
    else if (s.state === 'offline') s.state = 'idle';
    if (!this.foreground && s.state !== 'syncing' && s.state !== 'blocked' && this.online) s.state = 'background';
    s.banner = s.failingSince !== null && this.t.now() - s.failingSince >= (this.o.bannerAfterMs ?? 86_400_000);
    this.status = s;
    this.o.onStatus?.(this.getStatus());
  }

  private schedule(ms: number, reason: SyncReason): void {
    if (!this.foreground) return; // nothing after closing
    if (this.timer !== null) this.t.clearTimeout(this.timer);
    this.timer = this.t.setTimeout(() => {
      this.timer = null;
      void this.trigger(reason);
    }, ms);
  }

  private trigger(reason: SyncReason, manual = false): Promise<void> {
    if (!this.online) {
      this.update({});
      return Promise.resolve();
    }
    if (this.status.state === 'blocked' && !manual && reason !== 'background') return Promise.resolve();
    if (this.inFlight) {
      // Run once more after the pass in progress (changes made during it).
      this.again = reason;
      return this.inFlight;
    }
    const pendingAtStart = this.pending;
    this.update({ state: 'syncing' });
    this.inFlight = (async () => {
      let report: SyncReport | null = null;
      try {
        report = await this.o.run(reason);
      } catch {
        report = null;
      }
      this.inFlight = null;
      this.o.onReport && report && this.o.onReport(report);
      const own = report?.problems.find((p) => p.about === 'own')?.problem ?? null;
      if (report && !own) {
        this.failures = 0;
        this.pending = Math.max(0, this.pending - pendingAtStart);
        this.update({ state: 'idle', lastSuccess: this.t.now(), failingSince: null, problem: null });
        this.schedule(this.o.intervalMs ?? 300_000, 'interval');
      } else if (own?.blocksWrites) {
        this.update({ state: 'blocked', problem: own });
      } else {
        const backoff = this.o.backoffMs ?? [30_000, 60_000, 120_000, 300_000, 900_000, 1_800_000];
        const delay = backoff[Math.min(this.failures, backoff.length - 1)]!;
        this.failures++;
        this.update({ state: 'idle', failingSince: this.status.failingSince ?? this.t.now(), problem: own });
        this.schedule(delay, 'retry');
      }
      const again = this.again;
      this.again = null;
      if (again && (this.foreground || again === 'background')) await this.trigger(again);
    })();
    return this.inFlight;
  }
}
