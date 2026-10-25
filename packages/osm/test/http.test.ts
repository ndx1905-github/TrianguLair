import { describe, expect, it } from 'vitest';
import { AbortError, BadResponseError, HttpError, OsmError, RateLimitedError } from '../src/errors.ts';
import { MemoryCache } from '../src/http/cache.ts';
import { buildUserAgent, parseRetryAfter, validateUserAgent } from '../src/http/client.ts';
import { RateLimiter } from '../src/http/limiter.ts';
import { TEST_UA, deferredResponse, fakeClock, fakeFetch, json, testHttp } from './support/fake.ts';

const req = (url: string, ttlMs = 60_000) => ({ service: 'photon' as const, url, ttlMs });

describe('identification', () => {
  it('sends User-Agent and Referer on native platforms', async () => {
    const ff = fakeFetch().on('a', json({ ok: 1 }));
    await testHttp(ff).getJson(req('https://x.test/a'));
    expect(ff.calls[0]!.headers['user-agent']).toBe(TEST_UA);
    expect(ff.calls[0]!.headers['referer']).toBe('https://triangulair.example/');
  });

  it('does not set forbidden headers on the web, and uses Api-User-Agent for Wikimedia', async () => {
    const ff = fakeFetch().on('a', json({ ok: 1 }));
    const http = testHttp(ff, { platform: 'web' });
    await http.getJson(req('https://x.test/a'));
    await http.getJson({ service: 'commons', url: 'https://commons.test/a', ttlMs: 0 });
    expect(ff.calls[0]!.headers['user-agent']).toBeUndefined();
    expect(ff.calls[0]!.headers['referer']).toBeUndefined();
    expect(ff.calls[1]!.headers['api-user-agent']).toBe(TEST_UA);
  });

  it('refuses stock or anonymous User-Agents', () => {
    expect(() => validateUserAgent('')).toThrow(OsmError);
    expect(() => validateUserAgent('Mozilla/5.0 (X11)')).toThrow(/Stock/);
    expect(() => validateUserAgent('okhttp/4.12')).toThrow(/Stock/);
    expect(() => validateUserAgent('TrianguLair/1.0')).toThrow(/contact/);
    expect(() => validateUserAgent(buildUserAgent({ name: 'TrianguLair', version: '1.0', contact: 'dev@example.org' }))).not.toThrow();
  });
});

describe('cache', () => {
  it('serves fresh entries and refetches after the TTL', async () => {
    const clock = fakeClock();
    const ff = fakeFetch().on('a', json({ n: 1 }), 1).on('a', json({ n: 2 }));
    const http = testHttp(ff, { clock, cache: new MemoryCache({ now: clock.now }) });
    expect(await http.getJson(req('https://x.test/a', 1000))).toEqual({ n: 1 });
    const second = await http.request(req('https://x.test/a', 1000));
    expect(second.fromCache).toBe(true);
    clock.advance(1001);
    expect(await http.getJson(req('https://x.test/a', 1000))).toEqual({ n: 2 });
    expect(ff.calls).toHaveLength(2);
  });

  it('reload bypasses the read, no-store bypasses both', async () => {
    const ff = fakeFetch().on('a', json({ n: 1 }));
    const cache = new MemoryCache();
    const http = testHttp(ff, { cache });
    await http.getJson(req('https://x.test/a'), { cache: 'no-store' });
    expect(cache.size).toBe(0);
    await http.getJson(req('https://x.test/a'));
    await http.getJson(req('https://x.test/a'), { cache: 'reload' });
    expect(ff.calls).toHaveLength(3);
  });

  it('serves a stale entry when the service fails', async () => {
    const clock = fakeClock();
    const ff = fakeFetch()
      .on('a', json({ n: 1 }), 1)
      .on('a', new Response('down', { status: 500 }));
    const http = testHttp(ff, { clock, maxRetries: 0 });
    await http.getJson(req('https://x.test/a', 1000));
    clock.advance(5000);
    const r = await http.request(req('https://x.test/a', 1000));
    expect(r).toMatchObject({ data: { n: 1 }, stale: true });
  });

  it('evicts least recently used entries', () => {
    const c = new MemoryCache({ maxEntries: 2 });
    const e = { value: 1, storedAt: 0, expiresAt: Date.now() + 1e6 };
    c.set('a', e);
    c.set('b', e);
    c.get('a');
    c.set('c', e);
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBeDefined();
  });
});

describe('coalescing and abort', () => {
  it('shares one request between identical concurrent calls', async () => {
    const d = deferredResponse({ n: 1 });
    const ff = fakeFetch().on('a', d.respond);
    const http = testHttp(ff);
    const p1 = http.getJson(req('https://x.test/a'));
    const p2 = http.getJson(req('https://x.test/a'));
    await Promise.resolve();
    d.release();
    expect(await Promise.all([p1, p2])).toEqual([{ n: 1 }, { n: 1 }]);
    expect(ff.calls).toHaveLength(1);
  });

  it('one caller aborting does not cancel the request for the others', async () => {
    const d = deferredResponse({ n: 1 });
    const ff = fakeFetch().on('a', d.respond);
    const http = testHttp(ff);
    const ac = new AbortController();
    const p1 = http.getJson(req('https://x.test/a'), { signal: ac.signal });
    const p2 = http.getJson(req('https://x.test/a'));
    await new Promise((r) => setTimeout(r, 0));
    ac.abort();
    await expect(p1).rejects.toBeInstanceOf(AbortError);
    d.release();
    expect(await p2).toEqual({ n: 1 });
    expect(ff.calls[0]!.signal!.aborted).toBe(false);
  });

  it('the last caller aborting cancels the network request', async () => {
    const d = deferredResponse({ n: 1 });
    const ff = fakeFetch().on('a', d.respond);
    const http = testHttp(ff);
    const ac = new AbortController();
    const p = http.getJson(req('https://x.test/a'), { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 0));
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(AbortError);
    expect(ff.calls[0]!.signal!.aborted).toBe(true);
    expect(http.inflightCount).toBe(0);
  });

  it('rejects immediately with an already-aborted signal', async () => {
    const ff = fakeFetch();
    const ac = new AbortController();
    ac.abort();
    await expect(testHttp(ff).getJson(req('https://x.test/a'), { signal: ac.signal })).rejects.toBeInstanceOf(AbortError);
    expect(ff.calls).toHaveLength(0);
  });
});

describe('errors and retries', () => {
  it('retries a 429 after Retry-After and pauses the service', async () => {
    const clock = fakeClock();
    const ff = fakeFetch()
      .on('a', new Response('slow down', { status: 429, headers: { 'Retry-After': '3' } }), 1)
      .on('a', json({ n: 1 }));
    const http = testHttp(ff, { clock });
    expect(await http.getJson(req('https://x.test/a'))).toEqual({ n: 1 });
    expect(clock.sleeps).toContain(3000);
  });

  it('throws RateLimitedError when retries are exhausted', async () => {
    const ff = fakeFetch().on('a', new Response('', { status: 429 }));
    await expect(testHttp(ff, { maxRetries: 0 }).getJson(req('https://x.test/a'))).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('does not retry client errors', async () => {
    const ff = fakeFetch().on('a', new Response('bad', { status: 400 }));
    await expect(testHttp(ff).getJson(req('https://x.test/a'))).rejects.toBeInstanceOf(HttpError);
    expect(ff.calls).toHaveLength(1);
  });

  it('maps invalid JSON to BadResponseError', async () => {
    const ff = fakeFetch().on('a', new Response('<html>', { status: 200 }));
    await expect(testHttp(ff).getJson(req('https://x.test/a'))).rejects.toBeInstanceOf(BadResponseError);
  });

  it('returns accepted statuses as results', async () => {
    const ff = fakeFetch().on('a', new Response('', { status: 410 }));
    const r = await testHttp(ff).request({ ...req('https://x.test/a'), acceptStatus: [410] });
    expect(r).toMatchObject({ status: 410, data: null });
  });

  it('parses Retry-After dates', () => {
    const now = Date.parse('2026-10-26T12:00:00Z');
    expect(parseRetryAfter('Mon, 26 Oct 2026 12:00:10 GMT', now)).toBe(10_000);
    expect(parseRetryAfter('7', now)).toBe(7000);
    expect(parseRetryAfter('soon', now)).toBeUndefined();
  });
});

describe('rate limiter', () => {
  it('spaces request starts by minIntervalMs', async () => {
    const clock = fakeClock();
    const l = new RateLimiter({ minIntervalMs: 1000, maxConcurrent: 1 }, clock);
    const starts: number[] = [];
    await Promise.all([0, 1, 2].map(() => l.run(async () => void starts.push(clock.now()))));
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(1000);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(1000);
  });

  it('caps concurrency', async () => {
    const l = new RateLimiter({ minIntervalMs: 0, maxConcurrent: 2 }, fakeClock());
    let active = 0;
    let max = 0;
    const task = () =>
      l.run(async () => {
        active++;
        max = Math.max(max, active);
        await new Promise((r) => setTimeout(r, 1));
        active--;
      });
    await Promise.all([task(), task(), task(), task(), task()]);
    expect(max).toBe(2);
  });

  it('drops an aborted waiter from the queue', async () => {
    const l = new RateLimiter({ minIntervalMs: 0, maxConcurrent: 1 }, fakeClock());
    let release!: () => void;
    const first = l.run(() => new Promise<void>((r) => (release = r)));
    const ac = new AbortController();
    const second = l.run(async () => 'ran', ac.signal);
    expect(l.queued).toBe(1);
    ac.abort();
    await expect(second).rejects.toBeInstanceOf(AbortError);
    expect(l.queued).toBe(0);
    release();
    await first;
    expect(l.inFlight).toBe(0);
  });
});
