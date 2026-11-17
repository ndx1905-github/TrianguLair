// SPDX-License-Identifier: MPL-2.0
/**
 * The sync scenarios against real, separately running servers. Skipped
 * unless TL_REAL_SERVERS=1; start them with packages/storage/scripts/real-servers.sh
 * (as root): Apache mod_dav (8081, public /pub), WsgiDAV (8082, coarse ETags,
 * ignores If-Match on missing files), moto S3 (5005), OpenSSH sftp (2222).
 *
 * Friends read Apache over its public HTTP folder (HttpsReadOnlyAdapter);
 * the others through a read-only view of the owner's adapter. The certified
 * read addresses are https://<name>.example/… (the format refuses local
 * addresses) mapped to the servers by the test world.
 */
import { randomUUID } from 'node:crypto';
import { generateVaultDataKey, generateX25519KeyPair, issueSharingCert, packEntry, sealPack, serialize, signIndex } from '@triangulair/crypto';
import { HttpsReadOnlyAdapter, S3Adapter, WebDavAdapter, type StorageAdapter } from '@triangulair/storage';
import { SftpAdapter } from '@triangulair/storage/sftp';
import { startFaultProxy } from '@triangulair/storage/testing/faults';
import { describe, expect, it } from 'vitest';
import { encodePayload, utf8 } from '../src/payload.ts';
import { addDevice, befriend, friendSaves, makeUser, point, readOnly, World } from './helpers.ts';

const ON = process.env.TL_REAL_SERVERS === '1';
const auth = { username: 'alice', password: 's3cret' };

interface Server {
  name: string;
  make: () => Promise<{ write: StorageAdapter; read: StorageAdapter; close?: () => Promise<void> }>;
}

const servers: Server[] = [
  {
    name: 'Apache mod_dav (friends read over plain HTTP)',
    make: async () => {
      const dir = `s-${randomUUID()}/`;
      return {
        write: new WebDavAdapter({ baseUrl: `http://127.0.0.1:8081/dav/${dir}`, auth }),
        read: new HttpsReadOnlyAdapter({ baseUrl: `http://127.0.0.1:8081/pub/${dir}` }),
      };
    },
  },
  {
    name: 'WsgiDAV (coarse ETags, emulated conditions)',
    make: async () => {
      const a = new WebDavAdapter({ baseUrl: `http://127.0.0.1:8082/dav/s-${randomUUID()}/`, auth, conditionalWrites: false });
      return { write: a, read: readOnly(a) };
    },
  },
  {
    name: 'moto S3',
    make: async () => {
      await fetch('http://127.0.0.1:5005/tl-sync', { method: 'PUT' });
      const a = new S3Adapter({ endpoint: 'http://127.0.0.1:5005', bucket: 'tl-sync', region: 'us-east-1', accessKeyId: 'test', secretAccessKey: 'test', prefix: `s-${randomUUID()}/` });
      return { write: a, read: readOnly(a) };
    },
  },
  {
    name: 'OpenSSH sftp',
    make: async () => {
      const a = new SftpAdapter({ connect: { host: '127.0.0.1', port: 2222, ...auth }, root: `/home/alice/s-${randomUUID()}` });
      return { write: a, read: readOnly(a), close: async () => (a as unknown as { close?: () => Promise<void> }).close?.() };
    },
  },
];

if (ON) {
  for (const srv of servers) {
    describe(`sync on ${srv.name}`, () => {
      it('publish, read, edit, revoke; two own devices; concurrent publishers', async () => {
        const w = new World();
        const s = await srv.make();
        const user = makeUser(w, 'alice', { storage: s.write });
        w.storages.set(user.location, s.read);
        // World.readAdapter wraps in a read-only view; for Apache the reader is the HTTP adapter itself.
        const a = addDevice(w, user, { concurrency: 4 });
        const a2 = addDevice(w, user, { concurrency: 4 });
        const bob = addDevice(w, makeUser(w, 'bob'));
        for (let i = 1; i <= 50; i++) a.store.putSave({ place: point(i, `P${i}`), comment: `c${i}` });
        a.store.putSave({ place: point(99, 'private'), sharing: 'private' });
        expect((await a.engine.sync()).ok).toBe(true);
        await bob.engine.sync();
        await befriend(w, a, bob);
        expect((await a.engine.sync()).own!.published).toBe(true);
        let r = await bob.engine.sync();
        expect(r.ok).toBe(true);
        expect(friendSaves(bob, user.owner).size).toBe(50);

        // Edit, friend sees the diff.
        a.store.updateSave('osm:node/7', { status: 'favorite' });
        await a.engine.sync();
        r = await bob.engine.sync();
        expect(r.friends[0]!.whatsNew.changed).toEqual([{ placeId: 'osm:node/7', meaningful: true, fields: ['status'] }]);

        // Second device converges; both publish at once.
        await a2.engine.sync();
        expect(a2.store.repo.dumpOwnData()).toBe(a.store.repo.dumpOwnData());
        a.store.putSave({ place: point(200, 'from a') });
        a2.store.putSave({ place: point(300, 'from a2') });
        const both = await Promise.all([a.engine.sync(), a2.engine.sync()]);
        expect(both.every((x) => x.ok)).toBe(true);
        await a.engine.sync();
        await a2.engine.sync();
        await a.engine.sync();
        expect(a2.store.repo.dumpOwnData()).toBe(a.store.repo.dumpOwnData());
        expect(a.store.repo.getMySaveForPlace('osm:node/300')).not.toBeNull();
        await bob.engine.sync();
        expect(friendSaves(bob, user.owner).size).toBe(52);

        // Revocation.
        a.engine.setPolicy(bob.user.owner, { share: false });
        await a.engine.sync();
        r = await bob.engine.sync();
        expect(r.ok).toBe(true);
        expect(friendSaves(bob, user.owner).size).toBe(0);
        // Only listed files remain on the storage.
        const listed = new Set(a.engine.own!.index!.packs.map((p) => p.file));
        const onDisk = (await s.write.list('packs/')).map((e) => e.path);
        expect(onDisk.filter((f) => !listed.has(f))).toEqual([]);
        await s.close?.();
      });

      it('rollback attempt rejected, key rotation adopted by my other device and by a friend', async () => {
        const w = new World();
        const s = await srv.make();
        const user = makeUser(w, 'alice', { storage: s.write });
        w.storages.set(user.location, s.read);
        const a = addDevice(w, user);
        const a2 = addDevice(w, user);
        const bob = addDevice(w, makeUser(w, 'bob'));
        a.store.putSave({ place: point(1, 'P1') });
        await a.engine.sync();
        await a2.engine.sync();
        await bob.engine.sync();
        await befriend(w, a, bob);
        await a.engine.sync();
        await bob.engine.sync();
        const old = (await s.write.get('index.json'))!.data;
        a.store.putSave({ place: point(2, 'P2') });
        await a.engine.sync();
        await bob.engine.sync();
        // The host puts the older signed index back.
        await s.write.put('index.json', old);
        const r = await bob.engine.sync();
        expect(r.friends[0]!.problem?.kind).toBe('rollback');
        expect(friendSaves(bob, user.owner).size).toBe(2);
        expect((await a.engine.sync()).own!.published).toBe(true); // republished above the anchor
        expect((await bob.engine.sync()).ok).toBe(true);

        // Rotation from the primary device.
        const kp = generateX25519KeyPair();
        await a.engine.own!.rotate(
          { keyPair: kp, cert: issueSharingCert(user.identity, kp.publicKey, { rotation: 1, location: user.location }), vaultDataKey: generateVaultDataKey() },
          [a2.signer.cert],
        );
        expect((await a.engine.sync()).ok).toBe(true);
        const r2 = await a2.engine.sync();
        expect(r2.ok).toBe(true);
        expect(a2.engine.own!.sharing.cert.rotation).toBe(1);
        const rb = await bob.engine.sync();
        expect(rb.friends[0]!.keyChanged).toBe(true);
        expect(friendSaves(bob, user.owner).size).toBe(2);
        await s.close?.();
      });

      it('review fixes: a race under an unchanged ETag loses nothing (R-08); a declared-lost device cannot inject (R-01)', async () => {
        const w = new World();
        const s = await srv.make();
        const user = makeUser(w, 'alice', { storage: s.write });
        w.storages.set(user.location, s.read);
        // A long full-check period: passes trust the HEAD ETag, as on a phone between two full checks.
        const a = addDevice(w, user, { fullCheckMs: 3_600_000 });
        const a2 = addDevice(w, user, { fullCheckMs: 3_600_000 });
        a.store.putSave({ place: point(1, 'base') });
        await a.engine.sync();
        await a2.engine.sync();
        a2.store.putSave({ place: point(2, 'from a2') });
        expect((await a2.engine.sync()).own!.published).toBe(true);
        a.store.putSave({ place: point(3, 'from a') });
        expect((await a.engine.sync()).own!.published).toBe(true);
        expect(a.store.repo.getMySaveForPlace('osm:node/2')).not.toBeNull();
        // The other device writes while this one uploads its packs (after its pull, before its index).
        a.store.putSave({ place: point(4, 'from a, again') });
        a2.store.putSave({ place: point(5, 'from a2, again') });
        const put = s.write.put.bind(s.write);
        let once = true;
        s.write.put = async (p, d, o) => {
          if (once && p.startsWith('media/')) {
            once = false;
            await a2.engine.sync();
          }
          return put(p, d, o);
        };
        const r = await a.engine.own!.publish();
        s.write.put = put;
        expect(r.published).toBe(true);
        expect(r.conflicts).toBeGreaterThanOrEqual(1);
        await a2.engine.own!.pull({ full: true });
        await a2.engine.sync();
        await a.engine.own!.pull({ full: true });
        for (const d of [a, a2]) for (const id of [1, 2, 3, 4, 5]) expect(d.store.repo.getMySaveForPlace(`osm:node/${id}`)).not.toBeNull();
        for (const p of a.engine.own!.index!.packs) expect(await s.write.head(p.file)).not.toBeNull();

        // Declaration of loss of a2; a2 (the thief) still has the storage credentials and plants an
        // own-document update in an index of the old rotation.
        const kp = generateX25519KeyPair();
        await a.engine.own!.rotate({
          keyPair: kp,
          cert: issueSharingCert(user.identity, kp.publicKey, { rotation: 1, location: user.location, revokedDevices: [a2.signer.keys.id] }),
          vaultDataKey: generateVaultDataKey(),
        });
        expect((await a.engine.sync()).own!.published).toBe(true);
        a2.store.putSave({ place: point(666, 'INJECTED') });
        const update = a2.store.exportDoc();
        const body = new Uint8Array(update.length + 1);
        body[0] = 1;
        body.set(update, 1);
        const pack = sealPack(user.owner, encodePayload('own-doc', body), [kp.publicKey]);
        const e = packEntry(pack, 'media');
        await s.write.put(e.file, pack);
        await s.write.put('index.json', utf8(serialize(signIndex(a2.signer, { seq: 9999, sharingCert: user.sharing.cert, packs: [e], vaultDataKey: user.sharing.vaultDataKey }))));
        const ra = await a.engine.own!.publish();
        expect(ra.pull.rolledBack).toBe(true);
        expect(ra.published).toBe(true);
        expect(a.store.repo.getMySaveForPlace('osm:node/666')).toBeNull();
        expect(await s.write.head(e.file)).toBeNull();
        await s.close?.();
      });
    });
  }
  // T-202 simulated failures on the real servers: an index upload cut in the middle (fault proxy
  // between the adapter and the server). Apache and moto keep the previous index; WsgiDAV keeps
  // a truncated one, which the next pass republishes. Friends never see a partial publication.
  const cut: { name: string; upstream: () => Promise<string>; adapter: (url: string) => StorageAdapter }[] = [
    { name: 'Apache mod_dav', upstream: async () => `http://127.0.0.1:8081/dav/c-${randomUUID()}/`, adapter: (url) => new WebDavAdapter({ baseUrl: url, auth, timeoutMs: 5000 }) },
    { name: 'WsgiDAV', upstream: async () => `http://127.0.0.1:8082/dav/c-${randomUUID()}/`, adapter: (url) => new WebDavAdapter({ baseUrl: url, auth, conditionalWrites: false, timeoutMs: 5000 }) },
    {
      name: 'moto S3',
      upstream: async () => (await fetch('http://127.0.0.1:5005/tl-sync', { method: 'PUT' }), 'http://127.0.0.1:5005'),
      adapter: (url) => new S3Adapter({ endpoint: url, bucket: 'tl-sync', region: 'us-east-1', accessKeyId: 'test', secretAccessKey: 'test', prefix: `c-${randomUUID()}/`, timeoutMs: 5000 }),
    },
  ];
  for (const c of cut) {
    describe(`sync on ${c.name} with failures`, () => {
      it('index upload cut in the middle, then a timeout: friends keep the last good state, the next pass publishes', async () => {
        const proxy = await startFaultProxy(await c.upstream());
        try {
          const w = new World();
          const write = c.adapter(proxy.url);
          const user = makeUser(w, 'alice', { storage: write });
          const a = addDevice(w, user, { concurrency: 4 });
          const bob = addDevice(w, makeUser(w, 'bob'));
          for (let i = 1; i <= 5; i++) a.store.putSave({ place: point(i, `P${i}`) });
          expect((await a.engine.sync()).ok).toBe(true);
          await bob.engine.sync();
          await befriend(w, a, bob);
          expect((await a.engine.sync()).ok).toBe(true);
          await bob.engine.sync();
          expect(friendSaves(bob, user.owner).size).toBe(5);

          a.store.putSave({ place: point(6, 'P6') });
          proxy.inject({ method: 'PUT', path: /index\.json$/, times: 1, action: { kind: 'drop-upload', afterBytes: 300 } });
          const r = await a.engine.sync();
          expect(r.ok).toBe(false);
          expect(r.problems.find((p) => p.about === 'own')?.problem.kind).toBe('unreachable');
          await bob.engine.sync();
          expect(friendSaves(bob, user.owner).size).toBe(5);

          proxy.inject({ times: 1, action: { kind: 'hang' } });
          const t = await a.engine.sync();
          expect(t.ok).toBe(false);
          expect(t.problems.find((p) => p.about === 'own')?.problem.detail).toMatch(/no response/);

          const ok = await a.engine.sync();
          expect(ok.problems).toEqual([]);
          expect((await bob.engine.sync()).ok).toBe(true);
          expect(friendSaves(bob, user.owner).size).toBe(6);
        } finally {
          await proxy.close();
        }
      });
    });
  }
} else {
  describe.skip('real servers (set TL_REAL_SERVERS=1)', () => {
    it('skipped', () => {});
  });
}
