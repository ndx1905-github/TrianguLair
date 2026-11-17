/**
 * Simulated failures against the real servers of scripts/real-servers.sh
 * (TL_REAL_SERVERS=1): what each server really does when the quota is full,
 * when credentials are refused, when it does not answer, and when the
 * connection drops in the middle of an upload. Timeouts and cuts are injected
 * by the fault proxy (src/testing/faults.ts) in front of the real server;
 * quota and credentials are the servers' own answers.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AuthError, NetworkError, QuotaExceeded, S3Adapter, TimeoutError, WebDavAdapter, type StorageAdapter } from '../../src/index.ts';
import { SftpAdapter } from '../../src/sftp.ts';
import { startFaultProxy } from '../../src/testing/faults.ts';

const ON = process.env.TL_REAL_SERVERS === '1';
const auth = { username: 'alice', password: 's3cret' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Real {
  name: string;
  upstream: () => Promise<string>;
  adapter: (url: string, timeoutMs?: number) => StorageAdapter;
  /** What a PUT cut in the middle leaves at the path (observed; see README "Tested against real servers"). */
  afterCut: 'unchanged' | 'truncated';
}

const reals: Real[] = [
  {
    name: 'Apache mod_dav',
    upstream: async () => `http://127.0.0.1:8081/dav/f-${randomUUID()}/`,
    adapter: (url, timeoutMs) => new WebDavAdapter({ baseUrl: url, auth, ...(timeoutMs && { timeoutMs }) }),
    // mod_dav_fs writes to a temporary file and renames it once the body is complete.
    afterCut: 'unchanged',
  },
  {
    name: 'WsgiDAV',
    upstream: async () => `http://127.0.0.1:8082/dav/f-${randomUUID()}/`,
    adapter: (url, timeoutMs) => new WebDavAdapter({ baseUrl: url, auth, conditionalWrites: false, ...(timeoutMs && { timeoutMs }) }),
    // Streams into the target file: a cut leaves the first bytes of the new content.
    afterCut: 'truncated',
  },
  {
    name: 'moto S3',
    upstream: async () => {
      await fetch('http://127.0.0.1:5005/tl-it', { method: 'PUT' });
      return 'http://127.0.0.1:5005';
    },
    adapter: (url, timeoutMs) =>
      new S3Adapter({ endpoint: url, bucket: 'tl-it', region: 'us-east-1', accessKeyId: 'test', secretAccessKey: 'test', prefix: `f-${randomUUID()}/`, ...(timeoutMs && { timeoutMs }) }),
    // S3 stores an object only once the whole body (and its signed hash) arrived.
    afterCut: 'unchanged',
  },
];

if (ON) {
  for (const r of reals) {
    describe(`faults on ${r.name} (real server)`, () => {
      it('connection lost in the middle of an index upload', async () => {
        const proxy = await startFaultProxy(await r.upstream());
        try {
          const a = r.adapter(proxy.url);
          await a.put('index.json', new Uint8Array(256 * 1024).fill(1));
          await sleep(1100); // Apache: a strong ETag once the file is older than one second
          const before = (await a.head('index.json'))!.etag;
          proxy.inject({ method: 'PUT', times: 1, action: { kind: 'drop-upload', afterBytes: 64 * 1024 } });
          await expect(a.put('index.json', new Uint8Array(256 * 1024).fill(2), { ifMatch: before })).rejects.toBeInstanceOf(NetworkError);
          await sleep(500);
          const now = (await a.get('index.json'))!;
          if (r.afterCut === 'unchanged') {
            expect(now.etag).toBe(before);
            expect(now.data.byteLength).toBe(256 * 1024);
            expect(now.data[0]).toBe(1);
          } else {
            // The damage is real: a partial new index is visible. The sync engine must recover.
            expect(now.data.byteLength).toBeLessThan(256 * 1024);
            expect(now.data[0]).toBe(2);
          }
        } finally {
          await proxy.close();
        }
      });

      it('no answer → TimeoutError; the next request works', async () => {
        const proxy = await startFaultProxy(await r.upstream());
        try {
          const a = r.adapter(proxy.url, 400);
          await a.put('packs/a.bin', new Uint8Array([1]));
          proxy.inject({ times: 1, action: { kind: 'hang' } });
          await expect(a.head('packs/a.bin')).rejects.toBeInstanceOf(TimeoutError);
          expect(await a.head('packs/a.bin')).not.toBeNull();
        } finally {
          await proxy.close();
        }
      });
    });
  }

  describe('quota and credentials: the servers\' own answers', () => {
    it('Apache on a full disk (1 MiB tmpfs): 507 → QuotaExceeded, no partial file left', async () => {
      const dir = `q-${randomUUID()}/`;
      const a = new WebDavAdapter({ baseUrl: `http://127.0.0.1:8081/full/${dir}`, auth });
      await a.put('packs/small.bin', new Uint8Array(1000));
      const err = await a.put('packs/big.bin', new Uint8Array(2 * 1024 * 1024)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(QuotaExceeded);
      expect(err).toMatchObject({ status: 507, path: 'packs/big.bin' });
      expect((await a.list('')).map((e) => e.path)).toEqual(['packs/small.bin']);
      await a.delete('packs/small.bin');
    });

    it('Apache with LimitRequestBody: 413 → QuotaExceeded', async () => {
      const a = new WebDavAdapter({ baseUrl: `http://127.0.0.1:8081/small/s-${randomUUID()}/`, auth });
      await a.put('packs/ok.bin', new Uint8Array(100));
      await expect(a.put('packs/big.bin', new Uint8Array(8192))).rejects.toMatchObject({ code: 'QUOTA', status: 413 });
    });

    it('wrong password → AuthError (Apache, WsgiDAV, OpenSSH)', async () => {
      const bad = { username: 'alice', password: 'wrong' };
      await expect(new WebDavAdapter({ baseUrl: 'http://127.0.0.1:8081/dav/', auth: bad }).head('index.json')).rejects.toBeInstanceOf(AuthError);
      await expect(new WebDavAdapter({ baseUrl: 'http://127.0.0.1:8082/dav/', auth: bad }).put('x.bin', new Uint8Array(1))).rejects.toBeInstanceOf(AuthError);
      const s = new SftpAdapter({ connect: { host: '127.0.0.1', port: 2222, ...bad }, root: '/home/alice/x' });
      try {
        await expect(s.head('index.json')).rejects.toBeInstanceOf(AuthError);
      } finally {
        await (s as unknown as { close?: () => Promise<void> }).close?.();
      }
    });

    it('S3 credentials refused (moto accepts any key: 403 InvalidAccessKeyId injected) → AuthError', async () => {
      const proxy = await startFaultProxy('http://127.0.0.1:5005');
      try {
        proxy.inject({ action: { kind: 'status', status: 403, body: '<Error><Code>InvalidAccessKeyId</Code></Error>', headers: { 'content-type': 'application/xml' } } });
        await expect(reals[2]!.adapter(proxy.url).put('index.json', new Uint8Array(1))).rejects.toBeInstanceOf(AuthError);
      } finally {
        await proxy.close();
      }
    });
  });
} else {
  describe.skip('real-server faults (set TL_REAL_SERVERS=1)', () => {
    it('skipped', () => {});
  });
}
