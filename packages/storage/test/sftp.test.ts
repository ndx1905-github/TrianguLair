import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuthError, NetworkError } from '../src/index.ts';
import { SftpAdapter, type SftpOptions } from '../src/sftp.ts';
import { runAdapterConformance } from '../src/testing/conformance.ts';
import { startSftpServer } from './support/sftp-server.ts';

async function setup(over: Partial<SftpOptions> = {}, password = 'pw') {
  const dir = mkdtempSync(join(tmpdir(), 'tl-sftp-'));
  const srv = await startSftpServer({ root: dir, username: 'alice', password: 'pw' });
  const adapter = new SftpAdapter({
    connect: { host: '127.0.0.1', port: srv.port, username: 'alice', password, readyTimeout: 5000 },
    root: '/home/alice/triangulair',
    ...over,
  });
  return {
    dir,
    adapter,
    cleanup: async () => {
      await adapter.close();
      await srv.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// In-process ssh2 SFTP server on a temp dir (see test/support/sftp-server.ts).
runAdapterConformance('SFTP (ssh2 in-process, hash ETags)', async () => {
  const { adapter, cleanup } = await setup();
  return { adapter, cleanup };
});

describe('SFTP specifics', () => {
  it('leaves no temp files behind and maps the root under the server dir', async () => {
    const { dir, adapter, cleanup } = await setup();
    try {
      await adapter.put('packs/a.bin', new Uint8Array([1]));
      await adapter.put('packs/a.bin', new Uint8Array([2]));
      expect(readdirSync(join(dir, 'home/alice/triangulair/packs'))).toEqual(['a.bin']);
    } finally {
      await cleanup();
    }
  });

  it('mtime-size ETag mode works for basic round trips', async () => {
    const { adapter, cleanup } = await setup({ etagMode: 'mtime-size' });
    try {
      const { etag } = await adapter.put('index.json', new Uint8Array([1, 2]));
      expect(await adapter.head('index.json')).toEqual({ etag, size: 2 });
      expect((await adapter.list(''))[0]).toEqual({ path: 'index.json', etag, size: 2 });
    } finally {
      await cleanup();
    }
  });

  it('maps bad password to AuthError', async () => {
    const { adapter, cleanup } = await setup({}, 'wrong');
    try {
      await expect(adapter.get('index.json')).rejects.toBeInstanceOf(AuthError);
    } finally {
      await cleanup();
    }
  });

  it('maps connection failure to NetworkError', async () => {
    const a = new SftpAdapter({ connect: { host: '127.0.0.1', port: 1, username: 'x', password: 'y' }, root: '/' });
    await expect(a.get('index.json')).rejects.toBeInstanceOf(NetworkError);
  });
});
