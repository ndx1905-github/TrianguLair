import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import nepheleServer from 'nephele';
import FileSystemAdapter from '@nephele/adapter-file-system';
import InsecureAuthenticator from '@nephele/authenticator-none';
import { listen } from './http.ts';

/**
 * Real WebDAV server in-process: Nephele (RFC 4918, honours If-Match /
 * If-None-Match, content-hash ETags) on a temp dir, behind a Basic-auth
 * check. The same dir is also served anonymously under /pub/ to emulate a
 * public share for friends.
 */
export async function startDav(): Promise<{ url: string; root: string; close: () => Promise<void> }> {
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
    root,
    close: async () => {
      await running.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

