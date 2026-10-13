/**
 * Run the conformance suite against YOUR WebDAV server (Nextcloud, NAS...).
 * Skipped unless TL_WEBDAV_URL is set. Everything happens in a fresh
 * `triangulair-test-<uuid>/` folder, deleted at the end of each test.
 *
 *   TL_WEBDAV_URL=https://cloud.example.org/remote.php/dav/files/USER/ \
 *   TL_WEBDAV_USER=USER TL_WEBDAV_PASSWORD=... \
 *   npx vitest run --testTimeout=120000 test/integration/remote-webdav.test.ts
 *
 * Optional: TL_WEBDAV_PUBLIC_URL = anonymous HTTPS URL of the same folder.
 */
import { randomUUID } from 'node:crypto';
import { describe, it } from 'vitest';
import { WebDavAdapter, probeConditionalWrites } from '../../src/index.ts';
import { runAdapterConformance } from '../../src/testing/conformance.ts';

const URL_ = process.env.TL_WEBDAV_URL;
const auth = { username: process.env.TL_WEBDAV_USER ?? '', password: process.env.TL_WEBDAV_PASSWORD ?? '' };
const base = URL_ ? (URL_.endsWith('/') ? URL_ : `${URL_}/`) : '';
const basic = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;

if (URL_) {
  describe('remote WebDAV server', () => {
    it('reports whether it enforces If-Match / If-None-Match', async () => {
      const dir = `triangulair-test-${randomUUID()}/`;
      const ok = await probeConditionalWrites(new WebDavAdapter({ baseUrl: base + dir, auth }));
      await fetch(base + dir, { method: 'DELETE', headers: { authorization: basic } });
      console.log(`\n>>> native conditional writes: ${ok}\n`);
    });
  });

  runAdapterConformance('remote WebDAV', async () => {
    const dir = `triangulair-test-${randomUUID()}/`;
    return {
      adapter: new WebDavAdapter({ baseUrl: base + dir, auth }),
      nonAtomicConditionals: process.env.TL_NON_ATOMIC === '1',
      cleanup: async () => {
        await fetch(base + dir, { method: 'DELETE', headers: { authorization: basic } });
      },
    };
  });
} else {
  describe.skip('remote WebDAV (set TL_WEBDAV_URL)', () => {
    it('skipped', () => {});
  });
}
