/**
 * Test doubles: a scripted fetch that serves recorded fixtures, and a fake
 * clock so rate limits and retries are tested without real waiting.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AbortError } from '../../src/errors.ts';
import { HttpClient, type HttpClientOptions } from '../../src/http/client.ts';
import type { Clock } from '../../src/http/limiter.ts';
import type { FetchLike } from '../../src/types.ts';

export const TEST_UA = 'TrianguLair-tests/0.0.1 (+https://github.com/ndx1905-github/TrianguLair)';

export function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8');
}

export function fixtureJson<T = unknown>(name: string): T {
  return JSON.parse(fixture(name)) as T;
}

export interface FakeClock extends Clock {
  sleeps: number[];
  advance(ms: number): void;
}

export function fakeClock(start = Date.parse('2026-10-26T12:00:00Z')): FakeClock {
  let t = start;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => t,
    advance(ms) {
      t += ms;
    },
    async sleep(ms, signal) {
      if (signal?.aborted) throw new AbortError();
      sleeps.push(ms);
      t += ms;
      await Promise.resolve();
      if (signal?.aborted) throw new AbortError();
    },
  };
}

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  signal: AbortSignal | undefined;
}

export type Responder = (call: Call) => Response | Promise<Response>;

interface Route {
  test: (call: Call) => boolean;
  respond: Responder;
  times: number;
}

export interface FakeFetch {
  fetch: FetchLike;
  calls: Call[];
  /** Register a response; `match` is a substring of the URL (or body) or a predicate. */
  on(match: string | RegExp | ((c: Call) => boolean), respond: Responder | Response | string, times?: number): FakeFetch;
}

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

export function fakeFetch(): FakeFetch {
  const routes: Route[] = [];
  const calls: Call[] = [];
  const api: FakeFetch = {
    calls,
    on(match, respond, times = Infinity) {
      const test =
        typeof match === 'function'
          ? match
          : (c: Call) => {
              // Bodies are form-encoded (Overpass): match the decoded text.
              const body = decodeURIComponent((c.body ?? '').replace(/\+/g, ' '));
              return typeof match === 'string'
                ? c.url.includes(match) || body.includes(match)
                : match.test(c.url) || match.test(body);
            };
      const r: Responder =
        typeof respond === 'function'
          ? respond
          : typeof respond === 'string'
            ? () => json(respond)
            : () => respond.clone();
      routes.push({ test, respond: r, times });
      return api;
    },
    fetch: async (input, init) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => {
        headers[k] = v;
      });
      const call: Call = {
        url: String(input),
        method: init?.method ?? 'GET',
        headers,
        body: typeof init?.body === 'string' ? init.body : undefined,
        signal: init?.signal ?? undefined,
      };
      calls.push(call);
      if (call.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const route = routes.find((r) => r.times > 0 && r.test(call));
      if (!route) return new Response(`no fixture for ${call.method} ${call.url}`, { status: 599 });
      route.times--;
      const res = route.respond(call);
      if (!call.signal) return res;
      const signal = call.signal;
      return new Promise<Response>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        Promise.resolve(res).then(resolve, reject);
      });
    },
  };
  return api;
}

/** A response that only arrives when `release()` is called. */
export function deferredResponse(body: unknown): { respond: Responder; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  return { respond: async () => (await gate, json(body)), release };
}

export function testHttp(ff: FakeFetch, opts: Partial<HttpClientOptions> = {}): HttpClient {
  return new HttpClient({
    identity: { userAgent: TEST_UA, referer: 'https://triangulair.example/' },
    fetch: ff.fetch,
    platform: 'native',
    clock: fakeClock(),
    ...opts,
  });
}
