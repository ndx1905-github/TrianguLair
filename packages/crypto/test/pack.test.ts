import { describe, expect, it } from 'vitest';
import {
  DecryptionError,
  FormatError,
  generateX25519KeyPair,
  InvalidKeyError,
  MAX_WRAPS,
  openPack,
  packEntry,
  packHash,
  paddedLength,
  readPackHeader,
  rewrapPack,
  sealPack,
  UnsupportedVersionError,
  verifyIndex,
} from '../src/index';
import { containsBytes, headerOf, mutateHeader, open, person, publish, seal, td, te, trust } from './helpers';

const payload = te.encode(JSON.stringify({ places: [{ name: 'Chez Paul', lat: 4885, lon: 235 }] }));

describe('content packs', () => {
  it('round-trips for every recipient', () => {
    const [a, b, c] = [person(), person(), person()];
    const pack = sealPack(a.id.owner, payload, [a.sharing.publicKey, b.sharing.publicKey, c.sharing.publicKey]);
    const index = publish(a, [pack]);
    for (const p of [a, b, c]) {
      const out = openPack(pack, index, [p.sharing]);
      expect(td.decode(out.payload)).toBe(td.decode(payload));
      expect(out.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(out.file).toBe(packEntry(pack).file);
    }
  });
  it('handles empty and large payloads', () => {
    const a = person();
    expect(open(seal(new Uint8Array(0), [a.sharing.publicKey]), [a.sharing]).payload).toHaveLength(0);
    const big = new Uint8Array(1 << 20).fill(7);
    expect(open(seal(big, [a.sharing.publicKey]), [a.sharing]).payload).toEqual(big);
  });
  it('has the documented layout; the logical id is not in the readable header', () => {
    const a = person();
    const pack = seal(payload, [a.sharing.publicKey], { padTo: 0, id: 'AAAAAAAAAAAAAAAAAAAAAA' });
    expect(td.decode(pack.subarray(0, 4))).toBe('TLPK');
    expect(pack[4]).toBe(3);
    const n = new DataView(pack.buffer, pack.byteOffset).getUint32(5, false);
    const h = headerOf(pack);
    expect(Object.keys(h)).toEqual(['alg', 'nonce', 'pad', 'type', 'version', 'wrapAlg', 'wraps']); // canonical order, no id
    expect(h).toMatchObject({ type: 'pack', version: 3, alg: 'xchacha20poly1305-ietf', wrapAlg: 'x25519-sealedbox', pad: 'padme' });
    expect(h['wraps']).toHaveLength(1);
    expect(pack.length - 9 - n).toBe(paddedLength(20 + payload.length) + 16);
    expect(td.decode(pack)).not.toContain('AAAAAAAAAAAAAAAAAAAAAA');
    expect(open(pack, [a.sharing]).id).toBe('AAAAAAAAAAAAAAAAAAAAAA');
  });
  it('uses fresh batch key/nonce every time', () => {
    const a = person();
    const p1 = seal(payload, [a.sharing.publicKey]);
    const p2 = seal(payload, [a.sharing.publicKey]);
    expect(readPackHeader(p1).nonce).not.toBe(readPackHeader(p2).nonce);
    expect(packHash(p1)).not.toBe(packHash(p2));
  });

  it('rejects a wrong key with NO_MATCHING_KEY', () => {
    const [a, eve] = [person(), person()];
    const pack = seal(payload, [a.sharing.publicKey]);
    expect(() => open(pack, [eve.sharing])).toThrow(expect.objectContaining({ code: 'NO_MATCHING_KEY' }));
    expect(() => open(pack, [])).toThrow(DecryptionError);
  });

  describe('payload padding (T-002 F-08)', () => {
    it('Padmé buckets with a 256-byte floor, overhead below 12 %', () => {
      expect(paddedLength(1)).toBe(256);
      expect(paddedLength(256)).toBe(256);
      expect(paddedLength(257)).toBe(272);
      for (const n of [300, 1000, 5000, 70_000, 1_000_000]) {
        const p = paddedLength(n);
        expect(p).toBeGreaterThanOrEqual(n);
        expect((p - n) / n).toBeLessThan(0.12);
      }
    });
    it('payloads of nearby sizes give packs of the same size', () => {
      const a = person();
      const sizes = new Set([100, 120, 150, 200, 230].map((n) => seal(new Uint8Array(n), [a.sharing.publicKey]).length));
      expect(sizes.size).toBe(1);
    });
    it('pad: "none" is visible in the header and exact', () => {
      const a = person();
      const pack = seal(payload, [a.sharing.publicKey], { pad: 'none', padTo: 0 });
      const n = new DataView(pack.buffer, pack.byteOffset).getUint32(5, false);
      expect(readPackHeader(pack).pad).toBe('none');
      expect(pack.length - 9 - n).toBe(20 + payload.length + 16);
      expect(open(pack, [a.sharing]).payload).toEqual(payload);
    });
    it('the padding mode is authenticated (AD)', () => {
      const a = person();
      const pack = seal(payload, [a.sharing.publicKey]);
      expect(() => open(mutateHeader(pack, (h) => (h['pad'] = 'none')), [a.sharing])).toThrow(expect.objectContaining({ code: 'DECRYPT' }));
    });
  });

  describe('index check before decryption (T-002 F-06)', () => {
    it('a pack not listed in the verified index is rejected with NOT_INDEXED', () => {
      const a = person();
      const listed = sealPack(a.id.owner, payload, [a.sharing.publicKey]);
      const other = sealPack(a.id.owner, payload, [a.sharing.publicKey]);
      const index = publish(a, [listed]);
      expect(() => openPack(other, index, [a.sharing])).toThrow(expect.objectContaining({ code: 'NOT_INDEXED' }));
      const flipped = listed.slice();
      flipped[flipped.length - 1] = (flipped[flipped.length - 1] as number) ^ 1;
      expect(() => openPack(flipped, index, [a.sharing])).toThrow(expect.objectContaining({ code: 'NOT_INDEXED' }));
    });
    it('only an index returned by verifyIndex / signIndex is accepted (not a look-alike object)', () => {
      const a = person();
      const pack = sealPack(a.id.owner, payload, [a.sharing.publicKey]);
      const index = publish(a, [pack]);
      expect(() => openPack(pack, { owner: a.id.owner, packs: [packEntry(pack)] }, [a.sharing])).toThrow(expect.objectContaining({ code: 'NOT_INDEXED' }));
      expect(() => openPack(pack, { ...index }, [a.sharing])).toThrow(expect.objectContaining({ code: 'NOT_INDEXED' }));
      expect(openPack(pack, verifyIndex(JSON.stringify(index)), [a.sharing]).payload).toEqual(payload);
      expect(Object.isFrozen(index.packs)).toBe(true);
    });
    it('the hash check happens before any key operation (no trial decryption of unlisted data)', () => {
      const a = person();
      const index = publish(a, []);
      const garbage = seal(payload, Array.from({ length: 200 }, () => generateX25519KeyPair().publicKey), { padTo: MAX_WRAPS });
      const t0 = performance.now();
      expect(() => openPack(garbage, index, Array.from({ length: 50 }, () => generateX25519KeyPair()))).toThrow(expect.objectContaining({ code: 'NOT_INDEXED' }));
      expect(performance.now() - t0).toBeLessThan(200);
    });
  });

  describe('tampering', () => {
    const a = person();
    const pack = seal(payload, [a.sharing.publicKey]);
    it('ciphertext byte flip -> DECRYPT', () => {
      for (const pos of [pack.length - 1, pack.length - 20]) {
        const t = pack.slice();
        t[pos] = (t[pos] as number) ^ 1;
        expect(() => open(t, [a.sharing])).toThrow(expect.objectContaining({ code: 'DECRYPT' }));
      }
    });
    it('truncated ciphertext -> DECRYPT', () => {
      expect(() => open(pack.subarray(0, pack.length - 1), [a.sharing])).toThrow(DecryptionError);
    });
    it('header nonce changed -> DECRYPT (header is AEAD associated data)', () => {
      const otherNonce = readPackHeader(seal(payload, [a.sharing.publicKey])).nonce;
      expect(() => open(mutateHeader(pack, (h) => (h['nonce'] = otherNonce)), [a.sharing])).toThrow(DecryptionError);
    });
    it('header alg changed, extra field, or non-canonical header -> FormatError', () => {
      expect(() => open(mutateHeader(pack, (h) => (h['alg'] = 'aes-gcm')), [a.sharing])).toThrow(FormatError);
      expect(() => open(mutateHeader(pack, (h) => (h['to'] = 'bob')), [a.sharing])).toThrow(FormatError);
      expect(() => open(mutateHeader(pack, (h) => (h['id'] = 'AAAAAAAAAAAAAAAAAAAAAA')), [a.sharing])).toThrow(FormatError);
      expect(() => open(mutateHeader(pack, () => {}, (h) => JSON.stringify(h, null, 1)), [a.sharing])).toThrow(FormatError);
      expect(() => open(mutateHeader(pack, () => {}, (h) => JSON.stringify(h).replace('"type":"pack"', '"type":"x","type":"pack"')), [a.sharing])).toThrow(FormatError);
    });
    it('wrap tampered -> cannot unwrap', () => {
      const t = mutateHeader(pack, (h) => {
        const w = h['wraps'] as string[];
        h['wraps'] = w.map((x) => (x[10] === 'A' ? x.slice(0, 10) + 'B' + x.slice(11) : x.slice(0, 10) + 'A' + x.slice(11)));
      });
      expect(() => open(t, [a.sharing])).toThrow(DecryptionError);
    });
    it('forged wrap with a random batch key to the recipient -> DECRYPT, not wrong plaintext', () => {
      const attackerPack = seal(te.encode('evil'), [a.sharing.publicKey], { padTo: 0 });
      const forgedWrap = readPackHeader(attackerPack).wraps[0] as string;
      const t = mutateHeader(pack, (h) => (h['wraps'] = [forgedWrap]));
      expect(() => open(t, [a.sharing])).toThrow(expect.objectContaining({ code: 'DECRYPT' }));
    });
    it('bad magic / short / bad header length -> FormatError', () => {
      const t = pack.slice();
      t[0] = 0;
      expect(() => open(t, [a.sharing])).toThrow(FormatError);
      expect(() => open(pack.subarray(0, 5), [a.sharing])).toThrow(FormatError);
      const t2 = pack.slice();
      new DataView(t2.buffer).setUint32(5, 0xffffff, false);
      expect(() => open(t2, [a.sharing])).toThrow(FormatError);
    });
  });

  describe('versioning', () => {
    const a = person();
    const pack = seal(payload, [a.sharing.publicKey]);
    it('other envelope versions -> UnsupportedVersionError', () => {
      for (const v of [2, 4]) {
        const t = pack.slice();
        t[4] = v;
        expect(() => open(t, [a.sharing])).toThrow(UnsupportedVersionError);
        try {
          readPackHeader(t);
        } catch (e) {
          expect(e).toMatchObject({ code: 'UNSUPPORTED_VERSION', found: v, supported: 3 });
        }
      }
    });
    it('header version 4 -> UnsupportedVersionError', () => {
      expect(() => open(mutateHeader(pack, (h) => (h['version'] = 4)), [a.sharing])).toThrow(UnsupportedVersionError);
    });
    it('envelope version 0 -> FormatError', () => {
      const t = pack.slice();
      t[4] = 0;
      expect(() => open(t, [a.sharing])).toThrow(FormatError);
    });
  });

  describe('wrap anonymity', () => {
    it('the pack contains no recipient public key bytes (raw or base64url) and no master key', () => {
      const [a, b] = [person(), person()];
      const pack = seal(payload, [a.sharing.publicKey, b.sharing.publicKey]);
      const headerText = td.decode(pack);
      for (const p of [a, b]) {
        expect(containsBytes(pack, p.sharing.publicKey)).toBe(false);
        expect(containsBytes(pack, p.id.master.publicKey)).toBe(false);
        expect(headerText).not.toContain(Buffer.from(p.sharing.publicKey).toString('base64url'));
        expect(headerText).not.toContain(Buffer.from(p.sharing.publicKey).toString('base64'));
        expect(headerText).not.toContain(Buffer.from(p.sharing.publicKey).toString('hex'));
        expect(headerText).not.toContain(p.id.owner);
      }
    });
    it('wraps to the same recipient differ across packs (no linkable hint)', () => {
      const a = person();
      const w1 = readPackHeader(seal(payload, [a.sharing.publicKey], { padTo: 0 })).wraps;
      const w2 = readPackHeader(seal(payload, [a.sharing.publicKey], { padTo: 0 })).wraps;
      expect(w1[0]).not.toBe(w2[0]);
      expect(w1[0]!.slice(0, 43)).not.toBe(w2[0]!.slice(0, 43)); // ephemeral keys differ
    });
    it('pads wrap count to a power of two by default; all wraps have the same size', () => {
      const ps = [person(), person(), person()];
      const h = readPackHeader(seal(payload, ps.map((p) => p.sharing.publicKey)));
      expect(h.wraps).toHaveLength(4);
      expect(new Set(h.wraps.map((w) => w.length)).size).toBe(1);
      expect(readPackHeader(seal(payload, [ps[0]!.sharing.publicKey])).wraps).toHaveLength(2);
      expect(readPackHeader(seal(payload, [ps[0]!.sharing.publicKey], { padTo: 10 })).wraps).toHaveLength(10);
      const pack = seal(payload, ps.map((q) => q.sharing.publicKey), { padTo: 16 });
      const index = trust(pack);
      for (const p of ps) expect(openPack(pack, index, [p.sharing]).payload).toEqual(payload);
    });
    it('wrap order is shuffled (recipient position is not stable)', () => {
      const ps = Array.from({ length: 8 }, () => generateX25519KeyPair());
      const firstOpener = new Set<number>();
      for (let i = 0; i < 12; i++) {
        const pack = seal(payload, ps.map((p) => p.publicKey), { padTo: 0 });
        const wraps = readPackHeader(pack).wraps;
        const idx = wraps.findIndex((w) => {
          try {
            open(mutateHeader(pack, (h) => (h['wraps'] = [w])), [ps[0]!]);
            return true;
          } catch {
            return false;
          }
        });
        firstOpener.add(idx);
      }
      expect(firstOpener.size).toBeGreaterThan(1);
    });
  });

  describe('rewrap', () => {
    it('adds a recipient without changing the ciphertext; the file name changes', () => {
      const [a, b] = [person(), person()];
      const pack = sealPack(a.id.owner, payload, [a.sharing.publicKey]);
      const re = rewrapPack(pack, publish(a, [pack]), [a.sharing], [a.sharing.publicKey, b.sharing.publicKey]);
      const index = publish(a, [re]);
      expect(openPack(re, index, [b.sharing]).payload).toEqual(payload);
      expect(openPack(re, index, [b.sharing]).id).toBe(openPack(pack, publish(a, [pack]), [a.sharing]).id);
      expect(readPackHeader(re).nonce).toBe(readPackHeader(pack).nonce);
      expect(re.subarray(re.length - 100)).toEqual(pack.subarray(pack.length - 100));
      expect(packEntry(re).file).not.toBe(packEntry(pack).file);
    });
    it('requires a key that can open the pack, and a verified index listing it', () => {
      const [a, eve] = [person(), person()];
      const pack = sealPack(a.id.owner, payload, [a.sharing.publicKey]);
      expect(() => rewrapPack(pack, publish(a, [pack]), [eve.sharing], [eve.sharing.publicKey])).toThrow(DecryptionError);
      expect(() => rewrapPack(pack, publish(a, []), [a.sharing], [eve.sharing.publicKey])).toThrow(expect.objectContaining({ code: 'NOT_INDEXED' }));
    });
  });

  it('rejects invalid recipients', () => {
    expect(() => seal(payload, [])).toThrow(FormatError);
    expect(() => seal(payload, [new Uint8Array(31)])).toThrow(InvalidKeyError);
    expect(() => seal(payload, [new Uint8Array(32)])).toThrow(InvalidKeyError);
    expect(() => seal(payload, [generateX25519KeyPair().publicKey], { id: 'short' })).toThrow(FormatError);
  });

  it('bounds the wrap count before doing any work (T-002 F-10)', () => {
    const a = person();
    expect(MAX_WRAPS).toBe(256);
    const t0 = performance.now();
    expect(() => seal(payload, [a.sharing.publicKey], { padTo: 5000 })).toThrow(FormatError);
    expect(performance.now() - t0).toBeLessThan(100);
    expect(readPackHeader(seal(payload, [a.sharing.publicKey], { padTo: 256 })).wraps).toHaveLength(256);
  });

  it('content hash and content-addressed file name', () => {
    const a = person();
    const pack = seal(payload, [a.sharing.publicKey]);
    expect(packHash(pack)).toBe(packHash(pack.slice()));
    expect(packHash(pack)).toMatch(/^b2b256:[A-Za-z0-9_-]{43}$/);
    expect(packEntry(pack)).toEqual({ file: `packs/b2b256-${packHash(pack).slice(7)}.bin`, hash: packHash(pack) });
    expect(packEntry(pack, 'media').file).toMatch(/^media\/b2b256-/);
    const t = pack.slice();
    t[t.length - 1] = (t[t.length - 1] as number) ^ 1;
    expect(packHash(t)).not.toBe(packHash(pack));
  });
});
