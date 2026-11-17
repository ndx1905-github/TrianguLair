import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { v2 as webdav } from 'webdav-server';
import { describe, expect, it } from 'vitest';
import { AuthError, NetworkError, WebDavAdapter, probeConditionalWrites } from '../src/index.ts';
import { runAdapterConformance } from '../src/testing/conformance.ts';
import { startDav } from './support/dav-server.ts';
import { deadUrl, listen } from './support/http.ts';

runAdapterConformance('WebDAV (nephele)', async () => {
  const srv = await startDav();
  return {
    adapter: new WebDavAdapter({
      baseUrl: `${srv.url}/dav/`,
      auth: { username: 'alice', password: 's3cret' },
      publicBaseUrl: `${srv.url}/pub/`,
    }),
    publicUrlFetchable: true,
    // Nephele checks If-Match / If-None-Match and then writes without a lock:
    // under concurrency several conditional writers can all succeed.
    nonAtomicConditionals: true,
    cleanup: srv.close,
  };
});

/**
 * Second real WebDAV server: the `webdav-server` npm package (in-memory
 * filesystem, no auth). It IGNORES If-Match / If-None-Match and sends no
 * ETag header on GET/HEAD/PUT (only `getetag` in PROPFIND), which makes it a
 * good stand-in for lax servers: the adapter must be configured with
 * `conditionalWrites: false` (emulated, racy) and fall back to PROPFIND for ETags.
 */
async function startWebdavServer() {
  const server = new webdav.WebDAVServer({ port: 0, hostname: '127.0.0.1' });
  const port = await new Promise<number>((resolve) =>
    server.start((s) => resolve((s!.address() as AddressInfo).port)),
  );
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.stop(() => resolve())),
  };
}

runAdapterConformance('WebDAV (webdav-server, emulated conditionals)', async () => {
  const srv = await startWebdavServer();
  return {
    adapter: new WebDavAdapter({ baseUrl: `${srv.url}/`, publicBaseUrl: `${srv.url}/`, conditionalWrites: false }),
    publicUrlFetchable: true,
    cleanup: srv.close,
  };
});

describe('WebDAV specifics', () => {
  it('probe detects a server that ignores conditional headers (webdav-server)', async () => {
    const srv = await startWebdavServer();
    try {
      expect(await probeConditionalWrites(new WebDavAdapter({ baseUrl: srv.url }))).toBe(false);
    } finally {
      await srv.close();
    }
  });


  it('maps bad credentials to AuthError', async () => {
    const srv = await startDav();
    try {
      const a = new WebDavAdapter({ baseUrl: `${srv.url}/dav`, auth: { username: 'alice', password: 'nope' } });
      await expect(a.get('index.json')).rejects.toBeInstanceOf(AuthError);
      await expect(a.put('index.json', new Uint8Array([1]))).rejects.toBeInstanceOf(AuthError);
    } finally {
      await srv.close();
    }
  });

  it('maps connection failure to NetworkError', async () => {
    const a = new WebDavAdapter({ baseUrl: await deadUrl() });
    await expect(a.get('index.json')).rejects.toBeInstanceOf(NetworkError);
  });

  it('server really enforces conditional writes (probe)', async () => {
    const srv = await startDav();
    try {
      const a = new WebDavAdapter({ baseUrl: `${srv.url}/dav/`, auth: { username: 'alice', password: 's3cret' } });
      expect(await probeConditionalWrites(a)).toBe(true);
    } finally {
      await srv.close();
    }
  });
});
