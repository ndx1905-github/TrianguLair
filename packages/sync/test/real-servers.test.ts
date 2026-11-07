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
import { generateVaultDataKey, generateX25519KeyPair, issueSharingCert } from '@triangulair/crypto';
import { HttpsReadOnlyAdapter, S3Adapter, WebDavAdapter, type StorageAdapter } from '@triangulair/storage';
import { SftpAdapter } from '@triangulair/storage/sftp';
import { describe, expect, it } from 'vitest';
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
    });
  }
} else {
  describe.skip('real servers (set TL_REAL_SERVERS=1)', () => {
    it('skipped', () => {});
  });
}
