import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import nepheleServer from 'nephele';
import FileSystemAdapter from '@nephele/adapter-file-system';
import InsecureAuthenticator from '@nephele/authenticator-none';
import { describe, expect, it } from 'vitest';
import { AuthError, NetworkError, WebDavAdapter, probeConditionalWrites } from '../src/index.ts';
import { runAdapterConformance } from '../src/testing/conformance.ts';
import { deadUrl, listen } from './support/http.ts';

/**
 * Real WebDAV server in-process: Nephele (RFC 4918, honours If-Match /
 * If-None-Match, content-hash ETags) on a temp dir, behind a Basic-auth
 * check. The same dir is also served anonymously under /pub/ to emulate a
 * public share for friends.
 */
async function startDav() {
  const root = mkdtempSync(join(tmpdir(), 'tl-dav-'));
  const app = express();
  app.use('/pub', express.static(root, { dotfiles: 'allow' }));
  app.use('/dav', (req, res, next) => {
    const expected = `Basic ${Buffer.from('alice:s3cret').toString('base64')}`;
    if (req.headers.authorization !== expected) {
      res.status(401).setHeader('WWW-Authenticate', 'Basic realm="dav"').end();
      return;
    }
    next();
  });
  app.use(
    '/dav',
    nepheleServer({ adapter: new FileSystemAdapter({ root }), authenticator: new InsecureAuthenticator() }),
  );
  const running = await listen(createServer(app));
  return {
    url: running.url,
    close: async () => {
      await running.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

runAdapterConformance('WebDAV (nephele)', async () => {
  const srv = await startDav();
  return {
    adapter: new WebDavAdapter({
      baseUrl: `${srv.url}/dav/`,
      auth: { username: 'alice', password: 's3cret' },
      publicBaseUrl: `${srv.url}/pub/`,
    }),
    publicUrlFetchable: true,
    cleanup: srv.close,
  };
});

describe('WebDAV specifics', () => {
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
