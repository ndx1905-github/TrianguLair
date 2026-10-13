import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AuthError,
  HttpsReadOnlyAdapter,
  MemoryAdapter,
  NetworkError,
} from '../src/index.ts';
import { runAdapterConformance } from '../src/testing/conformance.ts';
import { deadUrl, listen, type Running } from './support/http.ts';

/**
 * Local static HTTP server (stands in for any HTTPS host: Nextcloud public
 * share, S3 public bucket, GitHub Pages...). Serves a MemoryAdapter store
 * under /pub/ with ETag + Content-Length; /private/ always answers 401.
 */
let store: MemoryAdapter;
let server: Running;

beforeAll(async () => {
  server = await listen((req, res) => {
    const url = new URL(req.url!, 'http://x');
    if (url.pathname.startsWith('/private/')) {
      res.statusCode = 401;
      return res.end();
    }
    const path = decodeURIComponent(url.pathname.replace(/^\/pub\//, ''));
    const e = store.store.get(path);
    if (!e || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.statusCode = e ? 405 : 404;
      return res.end();
    }
    res.setHeader('etag', e.etag);
    res.setHeader('content-length', String(e.data.byteLength));
    res.end(req.method === 'HEAD' ? undefined : Buffer.from(e.data));
  });
});
afterAll(() => server.close());

runAdapterConformance('HTTPS read-only', async () => {
  store = new MemoryAdapter();
  return {
    adapter: new HttpsReadOnlyAdapter({ baseUrl: `${server.url}/pub/` }),
    seed: async (p, d) => void store.putUnchecked(p, d),
    publicUrlFetchable: true,
  };
});

describe('HTTPS read-only errors', () => {
  it('maps 401 to AuthError', async () => {
    const a = new HttpsReadOnlyAdapter({ baseUrl: `${server.url}/private` });
    await expect(a.get('index.json')).rejects.toBeInstanceOf(AuthError);
  });
  it('maps connection failure to NetworkError', async () => {
    const a = new HttpsReadOnlyAdapter({ baseUrl: await deadUrl() });
    await expect(a.head('index.json')).rejects.toBeInstanceOf(NetworkError);
  });
  it('uses the injected fetch', async () => {
    const calls: string[] = [];
    const a = new HttpsReadOnlyAdapter({
      baseUrl: 'https://friend.example/tl/',
      fetch: async (input) => {
        calls.push(String(input));
        return new Response(new Uint8Array([1, 2]), { headers: { etag: 'abc' } });
      },
    });
    const g = await a.get('packs/x.bin');
    expect(calls).toEqual(['https://friend.example/tl/packs/x.bin']);
    expect(g).toEqual({ data: new Uint8Array([1, 2]), etag: '"abc"' });
  });
});
