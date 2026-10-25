/**
 * Client-side rate limiter: at most `maxConcurrent` requests in flight and at
 * least `minIntervalMs` between two request starts, per service. A 429 can
 * pause the whole service (`pauseUntil`).
 */
import { AbortError } from '../errors.ts';
import { sleep as realSleep } from './abort.ts';

export interface RateLimit {
  minIntervalMs: number;
  maxConcurrent: number;
}

export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const realClock: Clock = { now: () => Date.now(), sleep: realSleep };

export class RateLimiter {
  private active = 0;
  private nextStart = 0;
  private pausedUntil = 0;
  private readonly waiters: Array<{ resolve: () => void }> = [];

  constructor(
    readonly limit: RateLimit,
    private readonly clock: Clock = realClock,
  ) {}

  get inFlight(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiters.length;
  }

  /** Stop starting requests until `timestamp` (ms since epoch). */
  pauseUntil(timestamp: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, timestamp);
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquireSlot(signal);
    try {
      // Reserve the start time synchronously so queued callers keep their order.
      const now = this.clock.now();
      const start = Math.max(now, this.nextStart, this.pausedUntil);
      this.nextStart = start + this.limit.minIntervalMs;
      if (start > now) await this.clock.sleep(start - now, signal);
      // A pause may have been set while we slept (another request got a 429).
      const now2 = this.clock.now();
      if (this.pausedUntil > now2) await this.clock.sleep(this.pausedUntil - now2, signal);
      return await fn();
    } finally {
      this.releaseSlot();
    }
  }

  private acquireSlot(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new AbortError());
    if (this.active < this.limit.maxConcurrent) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
      };
      const onAbort = () => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new AbortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private releaseSlot(): void {
    const next = this.waiters.shift();
    if (next) {
      // Hand the slot over directly; `active` stays the same.
      next.resolve();
    } else {
      this.active--;
    }
  }
}
