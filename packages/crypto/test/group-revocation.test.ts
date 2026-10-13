import { describe, expect, it } from 'vitest';
import {
  createGroup,
  DecryptionError,
  FormatError,
  openGroupKey,
  openPack,
  packEntry,
  readPackHeader,
  reencryptPack,
  rotateGroup,
  sealGroupKey,
  sealPack,
  UnsupportedVersionError,
} from '../src/index';
import { containsBytes, headerOf, open, person, publish, te, trust } from './helpers';

const payload = te.encode('{"list":"Restos du dimanche"}');

describe('recipient groups', () => {
  it('members recover the group key and open packs wrapped to the group', () => {
    const [owner, m1, m2, outsider] = [person(), person(), person(), person()];
    const group = createGroup();
    const gk = sealGroupKey(group, owner.id.owner, [owner.sharing.publicKey, m1.sharing.publicKey, m2.sharing.publicKey]);
    const pack = sealPack(payload, [owner.sharing.publicKey, group.keyPair.publicKey]);
    const index = publish(owner, [gk, pack]);

    for (const m of [m1, m2]) {
      const g = openGroupKey(gk, index, [m.sharing]);
      expect(g.id).toBe(group.id);
      expect(g.owner).toBe(owner.id.owner);
      expect(g.generation).toBe(1);
      expect(g.keyPair.publicKey).toEqual(group.keyPair.publicKey);
      expect(openPack(pack, index, [m.sharing, g.keyPair]).payload).toEqual(payload);
      expect(() => openPack(pack, index, [m.sharing])).toThrow(DecryptionError); // needs the group key
    }
    expect(() => openGroupKey(gk, index, [outsider.sharing])).toThrow(DecryptionError);
    expect(() => openPack(pack, index, [outsider.sharing])).toThrow(DecryptionError);
  });

  it('group key pack does not reveal the group public key or members', () => {
    const [m1] = [person()];
    const group = createGroup();
    const gk = sealGroupKey(group, m1.id.owner, [m1.sharing.publicKey]);
    expect(containsBytes(gk, group.keyPair.publicKey)).toBe(false);
    expect(containsBytes(gk, m1.sharing.publicKey)).toBe(false);
    const pack = sealPack(payload, [group.keyPair.publicKey]);
    expect(containsBytes(pack, group.keyPair.publicKey)).toBe(false);
  });

  it('rejects group-key payloads with another version, generation 0, or another owner (T-002 F-06, F-13)', () => {
    const m = person();
    const v9 = sealPack(te.encode(JSON.stringify({ type: 'group-key', version: 9 })), [m.sharing.publicKey]);
    expect(() => openGroupKey(v9, trust(v9), [m.sharing])).toThrow(UnsupportedVersionError);
    const g0 = sealGroupKey({ ...createGroup(), generation: 0 }, m.id.owner, [m.sharing.publicKey]);
    expect(() => openGroupKey(g0, publish(m, [g0]), [m.sharing])).toThrow(FormatError);
    // A group-key pack naming another owner, listed in m's index.
    const other = person();
    const foreign = sealGroupKey(createGroup(), other.id.owner, [m.sharing.publicKey]);
    expect(() => openGroupKey(foreign, publish(m, [foreign]), [m.sharing])).toThrow(expect.objectContaining({ code: 'OWNER_MISMATCH' }));
  });
});

describe('revocation', () => {
  it('revoked friend cannot open re-encrypted packs; remaining recipients can', () => {
    const [owner, alice, bob] = [person(), person(), person()];
    const packs = [sealPack(payload, [owner.sharing.publicKey, alice.sharing.publicKey, bob.sharing.publicKey]), sealPack(te.encode('second'), [owner.sharing.publicKey, bob.sharing.publicKey])];
    const index = publish(owner, packs);
    expect(openPack(packs[0]!, index, [bob.sharing]).payload).toEqual(payload);

    // Revoke bob: new batch keys, wraps to remaining recipients only.
    const after = packs.map((p) => reencryptPack(p, index, [owner.sharing], p === packs[0] ? [owner.sharing.publicKey, alice.sharing.publicKey] : [owner.sharing.publicKey]));
    const next = publish(owner, after);
    for (const p of after) expect(() => openPack(p, next, [bob.sharing])).toThrow(expect.objectContaining({ code: 'NO_MATCHING_KEY' }));
    expect(openPack(after[0]!, next, [alice.sharing]).payload).toEqual(payload);
    expect(openPack(after[0]!, next, [owner.sharing]).payload).toEqual(payload);
    expect(openPack(after[1]!, next, [owner.sharing]).payload).toEqual(te.encode('second'));
    // Same logical id (inside), but new nonce, batch key and file name: versions are unlinkable from outside.
    expect(openPack(after[0]!, next, [owner.sharing]).id).toBe(openPack(packs[0]!, index, [owner.sharing]).id);
    expect(readPackHeader(after[0]!).nonce).not.toBe(readPackHeader(packs[0]!).nonce);
    expect(packEntry(after[0]!).file).not.toBe(packEntry(packs[0]!).file);
    // The old index no longer opens the new files (content-addressed).
    expect(() => openPack(after[0]!, index, [alice.sharing])).toThrow(expect.objectContaining({ code: 'NOT_INDEXED' }));
  });

  it('old batch key does not decrypt the re-encrypted pack (wrap transplant fails)', () => {
    const [owner, bob] = [person(), person()];
    const old = sealPack(payload, [owner.sharing.publicKey, bob.sharing.publicKey], { padTo: 0 });
    const fresh = reencryptPack(old, trust(old), [owner.sharing], [owner.sharing.publicKey], { padTo: 0 });
    const h = headerOf(fresh);
    h['wraps'] = readPackHeader(old).wraps;
    const n = new DataView(fresh.buffer, fresh.byteOffset).getUint32(5, false);
    const hb = te.encode(JSON.stringify(Object.fromEntries(Object.entries(h).sort(([a], [b]) => (a < b ? -1 : 1)))));
    const spliced = new Uint8Array([...fresh.subarray(0, 5), 0, 0, 0, 0, ...hb, ...fresh.subarray(9 + n)]);
    new DataView(spliced.buffer).setUint32(5, hb.length, false);
    expect(() => open(spliced, [bob.sharing])).toThrow(expect.objectContaining({ code: 'DECRYPT' }));
  });

  it('removing a group member: rotate group, re-seal, re-encrypt', () => {
    const [owner, m1, m2] = [person(), person(), person()];
    const g1 = createGroup();
    const gk1 = sealGroupKey(g1, owner.id.owner, [m1.sharing.publicKey, m2.sharing.publicKey]);
    const pack = sealPack(payload, [owner.sharing.publicKey, g1.keyPair.publicKey]);
    const i1 = publish(owner, [gk1, pack]);
    const m2g1 = openGroupKey(gk1, i1, [m2.sharing]);
    expect(openPack(pack, i1, [m2g1.keyPair]).payload).toEqual(payload);

    const g2 = rotateGroup(g1);
    const gk2 = sealGroupKey(g2, owner.id.owner, [m1.sharing.publicKey]);
    const pack2 = reencryptPack(pack, i1, [owner.sharing], [owner.sharing.publicKey, g2.keyPair.publicKey]);
    const i2 = publish(owner, [gk2, pack2]);

    expect(() => openGroupKey(gk2, i2, [m2.sharing])).toThrow(DecryptionError);
    expect(() => openPack(pack2, i2, [m2.sharing, m2g1.keyPair])).toThrow(DecryptionError);
    const m1g2 = openGroupKey(gk2, i2, [m1.sharing]);
    expect(m1g2.generation).toBe(2);
    expect(m1g2.id).toBe(g1.id);
    expect(openPack(pack2, i2, [m1.sharing, m1g2.keyPair]).payload).toEqual(payload);
  });
});
