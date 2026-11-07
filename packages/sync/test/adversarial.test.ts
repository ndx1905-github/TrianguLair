// SPDX-License-Identifier: MPL-2.0
/** Races, lax servers, attacks on the storage, key rotation, invitations. */
import {
  createInvitation,
  generateVaultDataKey,
  generateX25519KeyPair,
  issueSharingCert,
  parseInvitationLink,
  serialize,
  signIndex,
  verifyPublicFile,
  type SharingKey,
} from '@triangulair/crypto';
import { MemoryAdapter, PreconditionFailed, type StorageAdapter } from '@triangulair/storage';
import { describe, expect, it } from 'vitest';
import { FriendReader } from '../src/reader.ts';
import { MemoryStateStore } from '../src/state.ts';
import { addDevice, befriend, counting, friendSaves, makeUser, point, World } from './helpers.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A server that checks If-Match / If-None-Match, then writes without a lock (like Nephele, Apache with weak ETags). */
function nonAtomic(inner: MemoryAdapter): StorageAdapter {
  return {
    capabilities: { ...inner.capabilities, conditionalWrites: false },
    get: (p) => inner.get(p),
    head: (p) => inner.head(p),
    list: (p) => inner.list(p),
    delete: (p, o) => inner.delete(p, o),
    async put(p, d, o = {}) {
      const h = await inner.head(p);
      if (o.ifMatch !== undefined && h?.etag !== o.ifMatch) throw new PreconditionFailed(p);
      if (o.ifNoneMatch === '*' && h) throw new PreconditionFailed(p);
      await sleep(2);
      return inner.put(p, d);
    },
  };
}

/** Coarse ETags (mtime-in-seconds + size, as Nextcloud and WsgiDAV): here, the size only. */
function coarse(inner: MemoryAdapter): StorageAdapter {
  // Every write lands within the same second: the ETag never changes.
  const tag = (_n: number) => '"coarse"';
  return {
    capabilities: inner.capabilities,
    get: async (p) => {
      const g = await inner.get(p);
      return g && { data: g.data, etag: tag(g.data.length) };
    },
    head: async (p) => {
      const h = await inner.head(p);
      return h && { etag: tag(h.size), size: h.size };
    },
    list: (p) => inner.list(p),
    delete: (p) => inner.delete(p),
    async put(p, d, o = {}) {
      const h = await inner.head(p);
      if (o.ifMatch !== undefined && (!h || tag(h.size) !== o.ifMatch)) throw new PreconditionFailed(p);
      if (o.ifNoneMatch === '*' && h) throw new PreconditionFailed(p);
      await inner.put(p, d);
      return { etag: tag(d.length) };
    },
  };
}

describe('concurrent publishers (compare-and-swap)', () => {
  for (const [name, wrap] of [
    ['atomic server', (m: MemoryAdapter) => m],
    ['non-atomic server (re-read check)', nonAtomic],
  ] as const) {
    it(`two of my devices publishing at once both land: ${name}`, async () => {
      const w = new World();
      const mem = new MemoryAdapter();
      const user = makeUser(w, 'alice', { storage: wrap(mem) });
      const a = addDevice(w, user);
      const b = addDevice(w, user);
      a.store.putSave({ place: point(1, 'base') });
      await a.engine.sync();
      await b.engine.sync();
      for (let round = 0; round < 3; round++) {
        a.store.putSave({ place: point(100 + round, `A${round}`) });
        b.store.putSave({ place: point(200 + round, `B${round}`) });
        const [ra, rb] = await Promise.all([a.engine.sync(), b.engine.sync()]);
        expect(ra.ok && rb.ok).toBe(true);
      }
      // Settle: whatever a lost race left behind is republished by the next passes.
      await a.engine.sync();
      await b.engine.sync();
      await a.engine.sync();
      expect(a.store.repo.dumpOwnData()).toBe(b.store.repo.dumpOwnData());
      for (const id of [1, 100, 101, 102, 200, 201, 202]) expect(a.store.repo.getMySaveForPlace(`osm:node/${id}`)).not.toBeNull();
      // A fresh device restores everything from the storage alone.
      const c = addDevice(w, user);
      await c.engine.sync();
      expect(c.store.repo.dumpOwnData()).toBe(a.store.repo.dumpOwnData());
      // Every listed pack exists (an index never points to a missing file).
      const idx = a.engine.own!.index!;
      for (const p of idx.packs) expect(await mem.head(p.file)).not.toBeNull();
    });
  }

  it('a lost race is retried after merging', async () => {
    const w = new World();
    const mem = new MemoryAdapter();
    const user = makeUser(w, 'alice', { storage: mem });
    const a = addDevice(w, user);
    const b = addDevice(w, user);
    a.store.putSave({ place: point(1, 'base') });
    await a.engine.sync();
    await b.engine.sync();
    b.store.putSave({ place: point(2, 'B') });
    a.store.putSave({ place: point(3, 'A') });
    // B publishes between A's pull and A's index write.
    const own = a.engine.own!;
    const origPut = mem.put.bind(mem);
    let once = true;
    mem.put = async (p, d, o) => {
      if (p === 'index.json' && once) {
        once = false;
        await b.engine.sync();
      }
      return origPut(p, d, o);
    };
    const r = await own.publish();
    mem.put = origPut;
    expect(r.published).toBe(true);
    expect(r.conflicts).toBe(1);
    expect(a.store.repo.getMySaveForPlace('osm:node/2')).not.toBeNull();
  });
});

describe('coarse ETags', () => {
  it('a friend still sees a same-size change thanks to the periodic full read', async () => {
    const w = new World();
    const mem = new MemoryAdapter();
    const alice = addDevice(w, makeUser(w, 'alice', { storage: coarse(mem) }));
    const bob = addDevice(w, makeUser(w, 'bob'));
    alice.store.putSave({ place: point(1, 'P1'), status: 'tried' });
    await alice.engine.sync();
    await bob.engine.sync();
    await befriend(w, alice, bob);
    await alice.engine.sync();
    await bob.engine.sync();
    alice.store.updateSave('osm:node/1', { status: 'favorite' });
    await alice.engine.sync();

    // A reader that trusts the ETag for long misses it…
    const lazy = new FriendReader({ store: bob.store, state: new MemoryStateStore(), keys: () => bob.engine.keys(), readAdapter: w.readAdapter, fullCheckMs: 3_600_000 });
    const t = { owner: alice.user.owner, location: alice.user.location };
    await lazy.read(t);
    alice.store.updateSave('osm:node/1', { status: 'tried' });
    await alice.engine.sync();
    expect((await lazy.read(t)).status).toBe('unchanged');
    // …the engine's reader (full read when the ETag is old) does not.
    const r = await bob.engine.sync();
    expect(r.friends[0]!.status).toBe('updated');
    expect(friendSaves(bob, alice.user.owner).get('osm:node/1')!.status).toBe('tried');
  });
});

describe('attacks on the storage', () => {
  it('a rollback of the index is refused by friends and repaired by the owner', async () => {
    const w = new World();
    const mem = new MemoryAdapter();
    const alice = addDevice(w, makeUser(w, 'alice', { storage: mem }));
    const bob = addDevice(w, makeUser(w, 'bob'));
    alice.store.putSave({ place: point(1, 'P1') });
    await alice.engine.sync();
    await bob.engine.sync();
    await befriend(w, alice, bob);
    await alice.engine.sync();
    await bob.engine.sync();
    const old = (await mem.get('index.json'))!.data;
    const oldFiles = new Map<string, Uint8Array>();
    for (const e of await mem.list('packs/')) oldFiles.set(e.path, (await mem.get(e.path))!.data);
    alice.store.putSave({ place: point(2, 'P2') });
    await alice.engine.sync();
    await bob.engine.sync();
    expect(friendSaves(bob, alice.user.owner).size).toBe(2);

    // The host serves the older (validly signed) index and its packs again.
    for (const [p, d] of oldFiles) mem.putUnchecked(p, d);
    mem.putUnchecked('index.json', old);
    const r = await bob.engine.sync();
    expect(r.friends[0]!.problem?.kind).toBe('rollback');
    expect(friendSaves(bob, alice.user.owner).size).toBe(2); // last valid content kept

    // The owner notices (index older than its anchor) and publishes above it.
    const ra = await alice.engine.sync();
    expect(ra.own!.pull.rolledBack).toBe(true);
    expect(ra.own!.published).toBe(true);
    const rb = await bob.engine.sync();
    expect(rb.ok).toBe(true);
    expect(friendSaves(bob, alice.user.owner).size).toBe(2);
  });

  it('a modified pack or index is rejected and the cache kept', async () => {
    const w = new World();
    const mem = new MemoryAdapter();
    const alice = addDevice(w, makeUser(w, 'alice', { storage: mem }));
    const bob = addDevice(w, makeUser(w, 'bob'));
    alice.store.putSave({ place: point(1, 'P1') });
    await alice.engine.sync();
    await bob.engine.sync();
    await befriend(w, alice, bob);
    await alice.engine.sync();
    await bob.engine.sync();
    alice.store.putSave({ place: point(2, 'P2') });
    await alice.engine.sync();
    // Swap the bytes of every pack the index lists.
    for (const p of alice.engine.own!.index!.packs) {
      const d = (await mem.get(p.file))!.data;
      d[d.length - 1] = d[d.length - 1]! ^ 1;
      mem.putUnchecked(p.file, d);
    }
    const r = await bob.engine.sync();
    expect(r.friends[0]!.problem?.kind).toBe('tampered');
    expect(friendSaves(bob, alice.user.owner).size).toBe(1);
    // A forged index (signature broken).
    const idx = new TextDecoder().decode((await mem.get('index.json'))!.data).replace('"seq":', '"seq":1');
    mem.putUnchecked('index.json', new TextEncoder().encode(idx));
    expect((await bob.engine.sync()).friends[0]!.problem?.kind).toBe('tampered');
    expect(friendSaves(bob, alice.user.owner).size).toBe(1);
  });

  it('a pack copied into someone else\'s index does not open (owner binding)', async () => {
    const w = new World();
    const alice = addDevice(w, makeUser(w, 'alice'));
    const mallory = addDevice(w, makeUser(w, 'mallory'));
    const bob = addDevice(w, makeUser(w, 'bob'));
    alice.store.putSave({ place: point(1, 'P1') });
    await Promise.all([alice.engine.sync(), mallory.engine.sync(), bob.engine.sync()]);
    await befriend(w, alice, bob);
    await befriend(w, mallory, bob);
    await alice.engine.sync();
    // Mallory copies Alice's packs to her storage and lists them in her own validly signed index.
    const ms = mallory.user.storage as MemoryAdapter;
    const packs = alice.engine.own!.index!.packs;
    for (const p of packs) ms.putUnchecked(p.file, (await alice.user.storage.get(p.file))!.data);
    const prev = mallory.engine.own!.index!;
    const forged = signIndex(mallory.signer, { seq: prev.seq + 1, sharingCert: mallory.user.sharing.cert, packs, vaultDataKey: mallory.user.sharing.vaultDataKey, previous: prev });
    ms.putUnchecked('index.json', new TextEncoder().encode(serialize(forged)));
    const r = await bob.engine.sync();
    expect(friendSaves(bob, mallory.user.owner).size).toBe(0);
    expect(r.friends.find((f) => f.owner === mallory.user.owner)!.problem?.kind).toBe('tampered');
    expect(r.friends.find((f) => f.owner === alice.user.owner)!.status).toBe('updated');
  });
});

describe('key rotation', () => {
  it('a new sharing key reaches my other device, friends follow, everything is re-encrypted', async () => {
    const w = new World();
    const user = makeUser(w, 'alice');
    const a = addDevice(w, user);
    const b = addDevice(w, user);
    const bob = addDevice(w, makeUser(w, 'bob'));
    for (let i = 1; i <= 5; i++) a.store.putSave({ place: point(i, `P${i}`) });
    bob.store.putSave({ place: point(50, 'Bob place') });
    await a.engine.sync();
    await b.engine.sync();
    await bob.engine.sync();
    await befriend(w, a, bob, { mutual: true });
    await a.engine.sync();
    await bob.engine.sync();
    await a.engine.sync();
    expect(friendSaves(a, bob.user.owner).size).toBe(1);
    const before = new Set((await user.storage.list('packs/')).map((e) => e.path));

    // The primary device (it holds the identity) issues rotation 1 with a new key and vault data key.
    const kp = generateX25519KeyPair();
    const next: SharingKey = {
      keyPair: kp,
      cert: issueSharingCert(user.identity, kp.publicKey, { rotation: 1, location: user.location }),
      vaultDataKey: generateVaultDataKey(),
    };
    await a.engine.own!.rotate(next, [b.signer.cert]);
    const ra = await a.engine.sync();
    expect(ra.own!.published).toBe(true);
    const after = (await user.storage.list('packs/')).map((e) => e.path);
    expect(after.filter((f) => before.has(f))).toEqual([]); // nothing sealed for the old key remains

    // My other device picks the key up and keeps working.
    b.store.putSave({ place: point(6, 'P6 from B') });
    const rb = await b.engine.sync();
    expect(rb.ok).toBe(true);
    expect(rb.own!.pull.adoptedKey || b.engine.own!.sharing.cert.rotation === 1).toBe(true);
    expect(b.engine.own!.sharing.cert.rotation).toBe(1);

    // Bob accepts the new certificate (master-signed) and is told.
    const r = await bob.engine.sync();
    expect(r.ok).toBe(true);
    expect(r.friends[0]!.keyChanged).toBe(true);
    expect(friendSaves(bob, user.owner).size).toBe(6);
    expect(bob.engine.contacts()[0]!.sharingCert.rotation).toBe(1);
    // Bob's next publication wraps to Alice's new key; Alice reads it (and could with the old one meanwhile).
    bob.store.updateSave('osm:node/50', { comment: 'for the new key' });
    await bob.engine.sync();
    await a.engine.sync();
    expect(friendSaves(a, bob.user.owner).get('osm:node/50')!.comment).toBe('for the new key');
  });

  it('a device without the new key stops publishing and asks for the recovery kit', async () => {
    const w = new World();
    const user = makeUser(w, 'alice');
    const a = addDevice(w, user);
    const b = addDevice(w, user);
    a.store.putSave({ place: point(1, 'P1') });
    await a.engine.sync();
    await b.engine.sync();
    const kp = generateX25519KeyPair();
    await a.engine.own!.rotate({ keyPair: kp, cert: issueSharingCert(user.identity, kp.publicKey, { rotation: 1, location: user.location }), vaultDataKey: generateVaultDataKey() }, []);
    await a.engine.sync();
    const r = await b.engine.sync();
    expect(r.problems[0]!.problem.kind).toBe('needs-key');
  });

  it('a device declared lost finds itself revoked (remote wipe)', async () => {
    const w = new World();
    const user = makeUser(w, 'alice');
    const a = addDevice(w, user);
    const stolen = addDevice(w, user);
    a.store.putSave({ place: point(1, 'P1') });
    await a.engine.sync();
    await stolen.engine.sync();
    const kp = generateX25519KeyPair();
    await a.engine.own!.rotate({
      keyPair: kp,
      cert: issueSharingCert(user.identity, kp.publicKey, { rotation: 1, location: user.location, revokedDevices: [stolen.signer.keys.id] }),
      vaultDataKey: generateVaultDataKey(),
    });
    await a.engine.sync();
    const r = await stolen.engine.sync();
    expect(r.problems[0]!.problem.kind).toBe('device-revoked');
    expect(r.problems[0]!.problem.blocksWrites).toBe(true);
  });
});

describe('invitations', () => {
  it('the invitee reads what I share with friends with the invitation key, until accepted', async () => {
    const w = new World();
    const alice = addDevice(w, makeUser(w, 'alice'));
    alice.store.putSave({ place: point(1, 'Shared') });
    alice.store.putSave({ place: point(2, 'Private'), sharing: 'private' });
    await alice.engine.sync();
    const { invitation, fragment } = createInvitation(alice.signer, alice.user.sharing.cert);
    alice.engine.addInvitation(invitation);
    await alice.engine.sync(); // publish the index that lists it BEFORE sending the link
    const received = parseInvitationLink(`https://triangulair.app/i#${fragment}`);
    const carol = addDevice(w, makeUser(w, 'carol'));
    const r = await carol.engine.reader.read({ owner: received.owner, location: received.location, extraKeys: [received.keyPair] });
    expect(r.status).toBe('updated');
    expect([...friendSaves(carol, alice.user.owner).keys()]).toEqual(['osm:node/1']);
  });
});

describe('incremental publication', () => {
  it('editing one place of 1,000 rewrites about two packs; the friend downloads only those', async () => {
    const w = new World();
    const mem = new MemoryAdapter();
    const cnt = counting(mem);
    const alice = addDevice(w, makeUser(w, 'alice', { storage: cnt }));
    const bob = addDevice(w, makeUser(w, 'bob'));
    alice.store.change((tx) => {
      for (let i = 1; i <= 1000; i++) tx.putSave({ place: point(i, `P${i}`, 43 + (i % 50) * 0.1, 1 + Math.floor(i / 50) * 0.1) });
    });
    await alice.engine.sync();
    await bob.engine.sync();
    await befriend(w, alice, bob);
    const first = await alice.engine.sync();
    // 5 places packs of 200 re-sealed for the new recipient set, and the manifest (the document did not change).
    expect(first.own!.packsWritten).toBe(5 + 1);
    await bob.engine.sync();
    expect(friendSaves(bob, alice.user.owner).size).toBe(1000);

    alice.store.updateSave('osm:node/500', { comment: 'edited' });
    const r = await alice.engine.sync();
    expect(r.own!.packsWritten).toBe(3); // the pack of that place, one blurred, the own-document delta
    expect(r.own!.packsKept).toBe(3);
    const rb = await bob.engine.sync();
    expect(rb.friends[0]!.downloaded.packs).toBe(3);
    expect(rb.friends[0]!.whatsNew.changed.map((c) => c.placeId)).toEqual(['osm:node/500']);
  });
});

describe('public lists', () => {
  it('publishes public/lists.geojson in clear, verified through the index, with ODbL attribution', async () => {
    const w = new World();
    const alice = addDevice(w, makeUser(w, 'alice'), { author: 'Alice' });
    const s = alice.store;
    const tag = s.createTag({ name: 'Brunch', color: '#16A34A' });
    s.putSave({ place: point(1, 'Open'), comment: 'public note', commentVisibility: 'public' });
    s.putSave({ place: point(2, 'Friends note'), comment: 'friends only' });
    s.putSave({ place: point(3, 'Private'), sharing: 'private' });
    for (const id of ['osm:node/1', 'osm:node/2', 'osm:node/3']) s.addSaveTag(id, tag);
    s.createList({ name: 'Brunch spots', kind: 'filter', visibility: 'public', filter: { tags: [tag] } });
    await alice.engine.sync();
    const bytes = (await w.readAdapter(alice.user.location).get('public/lists.geojson'))!.data;
    verifyPublicFile(bytes, alice.engine.own!.index!);
    const geo = JSON.parse(new TextDecoder().decode(bytes));
    expect(geo.type).toBe('FeatureCollection');
    expect(geo.attribution).toContain('OpenStreetMap');
    expect(geo.license.name).toBe('ODbL-1.0');
    expect(geo.features.map((f: { properties: { name: string } }) => f.properties.name).sort()).toEqual(['Friends note', 'Open']);
    const open = geo.features.find((f: { properties: { name: string } }) => f.properties.name === 'Open');
    expect(open.properties.description).toBe('public note');
    expect(open.properties._umap_options.color).toBe('#16A34A');
    const fr = geo.features.find((f: { properties: { name: string } }) => f.properties.name === 'Friends note');
    expect(fr.properties.comment).toBeUndefined();
    // Unchanged content: not rewritten; no public list any more: removed.
    expect((await alice.engine.sync()).own!.published).toBe(false);
    s.deleteList(s.repo.lists()[0]!.id);
    await alice.engine.sync();
    expect(alice.engine.own!.index!.public).toBeUndefined();
    expect(await alice.user.storage.head('public/lists.geojson')).toBeNull();
  });
});
