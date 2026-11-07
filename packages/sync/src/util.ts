// SPDX-License-Identifier: MPL-2.0
import { fromB64Url, toB64Url } from '@triangulair/crypto';

/** Runs `fn` over `items` with at most `limit` in flight; results in input order. Stops at the first error. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failed: unknown = null;
  const worker = async () => {
    while (failed === null) {
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i]!, i);
      } catch (e) {
        failed ??= e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  if (failed !== null) throw failed;
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export const b64 = (b: Uint8Array): string => toB64Url(b);
export const unb64 = (s: string): Uint8Array => fromB64Url(s, 'state');

/** 16 random bytes, base64url (pack logical ids). Needs `crypto.getRandomValues` (a polyfill in React Native). */
export function randomLogicalId(): string {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (!c?.getRandomValues) throw new Error('crypto.getRandomValues is not available');
  return toB64Url(c.getRandomValues(new Uint8Array(16)));
}

/**
 * A byte limit was reached: one payload (`pack`), one friend's read (`read`) or all the friends read
 * in one sync pass (`pass`). Only `pass` is transient: the friends left over are read at the next pass.
 */
export class LimitError extends Error {
  constructor(
    readonly scope: 'pack' | 'read' | 'pass',
    what: string,
  ) {
    super(`${what}: over the ${scope} byte limit`);
    this.name = 'LimitError';
  }
}

/** Counts bytes (downloaded or decompressed) against a limit; `parent` is charged too. */
export class ByteBudget {
  used = 0;
  constructor(
    readonly limit: number,
    readonly scope: 'pack' | 'read' | 'pass',
    private readonly parent?: ByteBudget,
  ) {}
  take(n: number, what: string): void {
    this.parent?.take(n, what);
    this.used += n;
    if (this.used > this.limit) throw new LimitError(this.scope, what);
  }
  get remaining(): number {
    return Math.max(0, this.limit - this.used);
  }
}

/** At most `n` tasks at once (shared by every friend read of a pass, so 8 friends × 6 packs do not all inflate together). */
export class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  constructor(private readonly n: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.n) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}
