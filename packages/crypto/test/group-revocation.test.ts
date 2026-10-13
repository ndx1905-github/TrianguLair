import { describe, expect, it } from 'vitest';
import {
  createGroup,
  DecryptionError,
  openGroupKey,
  openPack,
  readPackHeader,
  reencryptPack,
  rotateGroup,
  sealGroupKey,
  sealPack,
  UnsupportedVersionError,
} from '../src/index';
import { containsBytes, person, te } from './helpers';

const payload = te.encode('{"list":"Restos du dimanche"}');

describe('recipient groups', () => {
  it('members recover the group key and open packs wrapped to the group', () => {
    const [owner, m1, m2, outsider] = [person(), person(), person(), person()];
    const group = createGroup();
    const gk = sealGroupKey(group, [owner.sharing.publicKey, m1.sharing.publicKey, m2.sharing.publicKey]);
    const pack = sealPack(payload, [owner.sharing.publicKey, group.keyPair.publicKey]);

    for (const m of [m1, m2]) {
      const g = openGroupKey(gk, [m.sharing]);
      expect(g.id).toBe(group.id);
      expect(g.generation).toBe(1);
      expect(g.keyPair.publicKey).toEqual(group.keyPair.publicKey);
      expect(openPack(pack, [m.sharing, g.keyPair]).payload).toEqual(payload);
      expect(() => openPack(pack, [m.sharing])).toThrow(DecryptionError); // needs the group key
    }
    expect(() => openGroupKey(gk, [outsider.sharing])).toThrow(DecryptionError);
    expect(() => openPack(pack, [outsider.sharing])).toThrow(DecryptionError);
  });

  it('group key pack does not reveal the group public key or members', () => {
    const [m1] = [person()];
    const group = createGroup();
    const gk = sealGroupKey(group, [m1.sharing.publicKey]);
    expect(containsBytes(gk, group.keyPair.publicKey)).toBe(false);
    expect(containsBytes(gk, m1.sharing.publicKey)).toBe(false);
    const pack = sealPack(payload, [group.keyPair.publicKey]);
    expect(containsBytes(pack, group.keyPair.publicKey)).toBe(false);
  });

  it('rejects group-key payload with a newer version', () => {
    const m = person();
    const forged = sealPack(te.encode(JSON.stringify({ type: 'group-key', version: 9 })), [m.sharing.publicKey]);
    expect(() => openGroupKey(forged, [m.sharing])).toThrow(UnsupportedVersionError);
  });
});

describe('revocation', () => {
  it('revoked friend cannot open re-encrypted packs; remaining recipients can', () => {
    const [owner, alice, bob] = [person(), person(), person()];
    const packs = [sealPack(payload, [owner.sharing.publicKey, alice.sharing.publicKey, bob.sharing.publicKey]), sealPack(te.encode('second'), [owner.sharing.publicKey, bob.sharing.publicKey])];
    expect(openPack(packs[0]!, [bob.sharing]).payload).toEqual(payload);

    // Revoke bob: new batch keys, rewrap to remaining recipients only.
    const after = packs.map((p) => reencryptPack(p, [owner.sharing], p === packs[0] ? [owner.sharing.publicKey, alice.sharing.publicKey] : [owner.sharing.publicKey]));
    for (const p of after) expect(() => openPack(p, [bob.sharing])).toThrow(expect.objectContaining({ code: 'NO_MATCHING_KEY' }));
    expect(openPack(after[0]!, [alice.sharing]).payload).toEqual(payload);
    expect(openPack(after[0]!, [owner.sharing]).payload).toEqual(payload);
    expect(openPack(after[1]!, [owner.sharing]).payload).toEqual(te.encode('second'));
    // Same logical pack id, but new nonce (and batch key).
    expect(readPackHeader(after[0]!).id).toBe(readPackHeader(packs[0]!).id);
    expect(readPackHeader(after[0]!).nonce).not.toBe(readPackHeader(packs[0]!).nonce);
  });

  it('old batch key does not decrypt the re-encrypted pack (wrap transplant fails)', () => {
    const [owner, bob] = [person(), person()];
    const old = sealPack(payload, [owner.sharing.publicKey, bob.sharing.publicKey], { padTo: 0 });
    const fresh = reencryptPack(old, [owner.sharing], [owner.sharing.publicKey], { padTo: 0 });
    // Bob splices his old wrap (old batch key) into the new pack header.
    const td = new TextDecoder();
    const n = new DataView(fresh.buffer, fresh.byteOffset).getUint32(5, false);
    const h = JSON.parse(td.decode(fresh.subarray(9, 9 + n)));
    h.wraps = readPackHeader(old).wraps;
    const hb = te.encode(JSON.stringify(h));
    const spliced = new Uint8Array([...fresh.subarray(0, 5), 0, 0, 0, 0, ...hb, ...fresh.subarray(9 + n)]);
    new DataView(spliced.buffer).setUint32(5, hb.length, false);
    expect(() => openPack(spliced, [bob.sharing])).toThrow(expect.objectContaining({ code: 'DECRYPT' }));
  });

  it('removing a group member: rotate group, re-seal, re-encrypt', () => {
    const [owner, m1, m2] = [person(), person(), person()];
    const g1 = createGroup();
    const gk1 = sealGroupKey(g1, [m1.sharing.publicKey, m2.sharing.publicKey]);
    const pack = sealPack(payload, [owner.sharing.publicKey, g1.keyPair.publicKey]);
    const m2g1 = openGroupKey(gk1, [m2.sharing]);
    expect(openPack(pack, [m2g1.keyPair]).payload).toEqual(payload);

    const g2 = rotateGroup(g1);
    const gk2 = sealGroupKey(g2, [m1.sharing.publicKey]);
    const pack2 = reencryptPack(pack, [owner.sharing], [owner.sharing.publicKey, g2.keyPair.publicKey]);

    expect(() => openGroupKey(gk2, [m2.sharing])).toThrow(DecryptionError);
    expect(() => openPack(pack2, [m2.sharing, m2g1.keyPair])).toThrow(DecryptionError);
    const m1g2 = openGroupKey(gk2, [m1.sharing]);
    expect(m1g2.generation).toBe(2);
    expect(m1g2.id).toBe(g1.id);
    expect(openPack(pack2, [m1.sharing, m1g2.keyPair]).payload).toEqual(payload);
  });
});
