import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  checkNoRollback,
  FormatError,
  packEtag,
  RollbackError,
  sealPack,
  serialize,
  SignatureError,
  signIndex,
  UnsupportedVersionError,
  verifyIndex,
} from '../src/index';
import { person, te } from './helpers';

const t0 = new Date('2026-10-13T10:00:00.000Z');
const t1 = new Date('2026-10-13T11:00:00.000Z');

describe('signed index', () => {
  const alice = person();
  const pack = sealPack(te.encode('x'), [alice.sharing.publicKey]);
  const idx = signIndex(alice.id, { seq: 1, packs: [{ file: 'packs/7c1e.bin', etag: packEtag(pack) }], public: 'public/lists.geojson', now: t0 });
  const json = serialize(idx);

  it('has the spec shape and canonical serialization', () => {
    const o = JSON.parse(json);
    expect(Object.keys(o)).toEqual(['owner', 'packs', 'public', 'seq', 'signature', 'updated', 'version']);
    expect(o).toMatchObject({ version: 1, owner: alice.id.owner, updated: '2026-10-13T10:00:00.000Z', public: 'public/lists.geojson' });
    expect(json).toBe(canonicalize(JSON.parse(json)));
    expect(json).not.toMatch(/\s/);
  });

  it('verifies from JSON string, from object, and from re-ordered/pretty JSON', () => {
    expect(verifyIndex(json).seq).toBe(1);
    expect(verifyIndex(idx, { expectedOwner: alice.id.master.publicKey }).owner).toBe(alice.id.owner);
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(json)).reverse()), null, 2);
    expect(verifyIndex(reordered).seq).toBe(1);
  });

  it('works without the optional public field', () => {
    const i = signIndex(alice.id, { seq: 2, packs: [] });
    expect('public' in i).toBe(false);
    expect(verifyIndex(serialize(i)).packs).toEqual([]);
  });

  it('rejects tampering of any field', () => {
    const o = JSON.parse(json);
    const cases = [
      { ...o, seq: 2 },
      { ...o, updated: '2027-01-01T00:00:00.000Z' },
      { ...o, public: 'public/other.geojson' },
      { ...o, packs: [{ file: 'packs/evil.bin', etag: o.packs[0].etag }] },
      { ...o, packs: [] },
    ];
    for (const c of cases) expect(() => verifyIndex(JSON.stringify(c))).toThrow(SignatureError);
    const sig = o.signature as string;
    const flipped = (sig[5] === 'A' ? 'B' : 'A');
    expect(() => verifyIndex({ ...o, signature: sig.slice(0, 5) + flipped + sig.slice(6) })).toThrow(SignatureError);
    expect(() => verifyIndex({ ...o, signature: undefined })).toThrow(FormatError);
  });

  it('rejects wrong owner', () => {
    const mallory = person();
    const o = JSON.parse(json);
    // Swapping in another owner breaks the signature.
    expect(() => verifyIndex({ ...o, owner: mallory.id.owner })).toThrow(SignatureError);
    // A valid index by mallory is rejected when alice is expected.
    const mi = signIndex(mallory.id, { seq: 5, packs: o.packs });
    expect(() => verifyIndex(serialize(mi), { expectedOwner: alice.id.master.publicKey })).toThrow(expect.objectContaining({ code: 'OWNER_MISMATCH' }));
    expect(() => verifyIndex(serialize(mi), { expectedOwner: alice.id.owner })).toThrow(SignatureError);
  });

  it('rejects rollback and forks', () => {
    const newer = signIndex(alice.id, { seq: 2, packs: [], now: t1 });
    expect(verifyIndex(serialize(newer), { lastSeen: idx }).seq).toBe(2);
    expect(() => verifyIndex(json, { lastSeen: newer })).toThrow(RollbackError);
    // same date, lower seq
    const lowerSeq = signIndex(alice.id, { seq: 0, packs: [], now: t1 });
    expect(() => checkNoRollback(lowerSeq, newer)).toThrow(RollbackError);
    // higher seq but older date
    const olderDate = signIndex(alice.id, { seq: 3, packs: [], now: t0 });
    expect(() => checkNoRollback(olderDate, newer)).toThrow(RollbackError);
    // same seq, different content = fork
    const fork = signIndex(alice.id, { seq: 2, packs: [{ file: 'packs/x.bin', etag: 'y' }], now: t1 });
    expect(() => checkNoRollback(fork, newer)).toThrow(RollbackError);
    // identical re-delivery is fine
    expect(() => checkNoRollback(verifyIndex(serialize(newer)), newer)).not.toThrow();
    // lastSeen of another owner
    const bob = person();
    expect(() => checkNoRollback(newer, signIndex(bob.id, { seq: 1, packs: [] }))).toThrow(expect.objectContaining({ code: 'OWNER_MISMATCH' }));
  });

  it('rejects unknown higher versions and malformed documents', () => {
    const o = JSON.parse(json);
    expect(() => verifyIndex({ ...o, version: 2 })).toThrow(UnsupportedVersionError);
    expect(() => verifyIndex({ ...o, version: 0 })).toThrow(FormatError);
    expect(() => verifyIndex({ ...o, extra: true })).toThrow(FormatError);
    expect(() => verifyIndex({ ...o, updated: 'yesterday' })).toThrow(FormatError);
    expect(() => verifyIndex({ ...o, packs: [{ file: 'a' }] })).toThrow(FormatError);
    expect(() => verifyIndex({ ...o, owner: 'rsa:abc' })).toThrow(FormatError);
    expect(() => verifyIndex('[]')).toThrow(FormatError);
  });
});
