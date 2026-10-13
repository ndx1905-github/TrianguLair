import { describe, expect, it } from 'vitest';
import {
  DecryptionError,
  FormatError,
  generateX25519KeyPair,
  openPack,
  packEtag,
  readPackHeader,
  rewrapPack,
  sealPack,
  UnsupportedVersionError,
} from '../src/index';
import { containsBytes, mutateHeader, person, td, te } from './helpers';

const payload = te.encode(JSON.stringify({ places: [{ name: 'Chez Paul', lat: 48.85, lon: 2.35 }] }));

describe('content packs', () => {
  it('round-trips for every recipient', () => {
    const [a, b, c] = [person(), person(), person()];
    const pack = sealPack(payload, [a.sharing.publicKey, b.sharing.publicKey, c.sharing.publicKey]);
    for (const p of [a, b, c]) {
      const out = openPack(pack, [p.sharing]);
      expect(td.decode(out.payload)).toBe(td.decode(payload));
      expect(out.id).toBe(readPackHeader(pack).id);
    }
  });
  it('handles empty and large payloads', () => {
    const a = person();
    expect(openPack(sealPack(new Uint8Array(0), [a.sharing.publicKey]), [a.sharing]).payload).toHaveLength(0);
    const big = new Uint8Array(1 << 20).fill(7);
    expect(openPack(sealPack(big, [a.sharing.publicKey]), [a.sharing]).payload).toEqual(big);
  });
  it('has the documented layout', () => {
    const a = person();
    const pack = sealPack(payload, [a.sharing.publicKey], { padTo: 0 });
    expect(td.decode(pack.subarray(0, 4))).toBe('TLPK');
    expect(pack[4]).toBe(1);
    const n = new DataView(pack.buffer, pack.byteOffset).getUint32(5, false);
    const h = JSON.parse(td.decode(pack.subarray(9, 9 + n)));
    expect(Object.keys(h)).toEqual(['alg', 'id', 'nonce', 'type', 'version', 'wrapAlg', 'wraps']); // canonical order
    expect(h).toMatchObject({ type: 'pack', version: 1, alg: 'xchacha20poly1305-ietf', wrapAlg: 'x25519-sealedbox' });
    expect(h.wraps).toHaveLength(1);
    expect(pack.length - 9 - n).toBe(payload.length + 16);
  });
  it('uses fresh batch key/nonce every time', () => {
    const a = person();
    const p1 = sealPack(payload, [a.sharing.publicKey]);
    const p2 = sealPack(payload, [a.sharing.publicKey]);
    expect(readPackHeader(p1).nonce).not.toBe(readPackHeader(p2).nonce);
    expect(readPackHeader(p1).id).not.toBe(readPackHeader(p2).id);
  });

  it('rejects a wrong key with NO_MATCHING_KEY', () => {
    const [a, eve] = [person(), person()];
    const pack = sealPack(payload, [a.sharing.publicKey]);
    expect(() => openPack(pack, [eve.sharing])).toThrow(expect.objectContaining({ code: 'NO_MATCHING_KEY' }));
    expect(() => openPack(pack, [])).toThrow(DecryptionError);
  });

  describe('tampering', () => {
    const a = person();
    const pack = sealPack(payload, [a.sharing.publicKey]);
    it('ciphertext byte flip -> DECRYPT', () => {
      for (const pos of [pack.length - 1, pack.length - 20]) {
        const t = pack.slice();
        t[pos] = (t[pos] as number) ^ 1;
        expect(() => openPack(t, [a.sharing])).toThrow(expect.objectContaining({ code: 'DECRYPT' }));
      }
    });
    it('truncated ciphertext -> DECRYPT', () => {
      expect(() => openPack(pack.subarray(0, pack.length - 1), [a.sharing])).toThrow(DecryptionError);
    });
    it('header id / nonce changed -> DECRYPT (header is AEAD associated data)', () => {
      const otherId = readPackHeader(sealPack(payload, [a.sharing.publicKey])).id;
      expect(() => openPack(mutateHeader(pack, (h) => (h['id'] = otherId)), [a.sharing])).toThrow(expect.objectContaining({ code: 'DECRYPT' }));
      const otherNonce = readPackHeader(sealPack(payload, [a.sharing.publicKey])).nonce;
      expect(() => openPack(mutateHeader(pack, (h) => (h['nonce'] = otherNonce)), [a.sharing])).toThrow(DecryptionError);
    });
    it('header alg changed or extra field -> FormatError', () => {
      expect(() => openPack(mutateHeader(pack, (h) => (h['alg'] = 'aes-gcm')), [a.sharing])).toThrow(FormatError);
      expect(() => openPack(mutateHeader(pack, (h) => (h['to'] = 'bob')), [a.sharing])).toThrow(FormatError);
    });
    it('wrap tampered -> cannot unwrap', () => {
      const t = mutateHeader(pack, (h) => {
        const w = h['wraps'] as string[];
        h['wraps'] = w.map((x) => (x[10] === 'A' ? x.slice(0, 10) + 'B' + x.slice(11) : x.slice(0, 10) + 'A' + x.slice(11)));
      });
      expect(() => openPack(t, [a.sharing])).toThrow(DecryptionError);
    });
    it('forged wrap with a random batch key to the recipient -> DECRYPT, not wrong plaintext', () => {
      const attackerPack = sealPack(te.encode('evil'), [a.sharing.publicKey], { padTo: 0 });
      const forgedWrap = readPackHeader(attackerPack).wraps[0] as string;
      const t = mutateHeader(pack, (h) => (h['wraps'] = [forgedWrap]));
      expect(() => openPack(t, [a.sharing])).toThrow(expect.objectContaining({ code: 'DECRYPT' }));
    });
    it('bad magic / short / bad header length -> FormatError', () => {
      const t = pack.slice();
      t[0] = 0;
      expect(() => openPack(t, [a.sharing])).toThrow(FormatError);
      expect(() => openPack(pack.subarray(0, 5), [a.sharing])).toThrow(FormatError);
      const t2 = pack.slice();
      new DataView(t2.buffer).setUint32(5, 0xffffff, false);
      expect(() => openPack(t2, [a.sharing])).toThrow(FormatError);
    });
  });

  describe('versioning', () => {
    const a = person();
    const pack = sealPack(payload, [a.sharing.publicKey]);
    it('envelope version 2 -> UnsupportedVersionError', () => {
      const t = pack.slice();
      t[4] = 2;
      expect(() => openPack(t, [a.sharing])).toThrow(UnsupportedVersionError);
      try {
        readPackHeader(t);
      } catch (e) {
        expect(e).toMatchObject({ code: 'UNSUPPORTED_VERSION', found: 2, supported: 1 });
      }
    });
    it('header version 2 -> UnsupportedVersionError', () => {
      expect(() => openPack(mutateHeader(pack, (h) => (h['version'] = 2)), [a.sharing])).toThrow(UnsupportedVersionError);
    });
    it('envelope version 0 -> FormatError', () => {
      const t = pack.slice();
      t[4] = 0;
      expect(() => openPack(t, [a.sharing])).toThrow(FormatError);
    });
  });

  describe('wrap anonymity', () => {
    it('the pack contains no recipient public key bytes (raw or base64url) and no master key', () => {
      const [a, b] = [person(), person()];
      const pack = sealPack(payload, [a.sharing.publicKey, b.sharing.publicKey]);
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
      const w1 = readPackHeader(sealPack(payload, [a.sharing.publicKey], { padTo: 0 })).wraps;
      const w2 = readPackHeader(sealPack(payload, [a.sharing.publicKey], { padTo: 0 })).wraps;
      expect(w1[0]).not.toBe(w2[0]);
      expect(w1[0]!.slice(0, 43)).not.toBe(w2[0]!.slice(0, 43)); // ephemeral keys differ
    });
    it('pads wrap count to a power of two by default; all wraps have the same size', () => {
      const ps = [person(), person(), person()];
      const h = readPackHeader(sealPack(payload, ps.map((p) => p.sharing.publicKey)));
      expect(h.wraps).toHaveLength(4);
      expect(new Set(h.wraps.map((w) => w.length)).size).toBe(1);
      expect(readPackHeader(sealPack(payload, [ps[0]!.sharing.publicKey])).wraps).toHaveLength(2);
      expect(readPackHeader(sealPack(payload, [ps[0]!.sharing.publicKey], { padTo: 10 })).wraps).toHaveLength(10);
      for (const p of ps) expect(openPack(sealPack(payload, ps.map((q) => q.sharing.publicKey), { padTo: 16 }), [p.sharing]).payload).toEqual(payload);
    });
    it('wrap order is shuffled (recipient position is not stable)', () => {
      const ps = Array.from({ length: 8 }, () => generateX25519KeyPair());
      const firstOpener = new Set<number>();
      for (let i = 0; i < 12; i++) {
        const pack = sealPack(payload, ps.map((p) => p.publicKey), { padTo: 0 });
        const wraps = readPackHeader(pack).wraps;
        const idx = wraps.findIndex((w) => {
          try {
            openPack(mutateHeader(pack, (h) => (h['wraps'] = [w])), [ps[0]!]);
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
    it('adds a recipient without changing the ciphertext', () => {
      const [a, b] = [person(), person()];
      const pack = sealPack(payload, [a.sharing.publicKey]);
      const re = rewrapPack(pack, [a.sharing], [a.sharing.publicKey, b.sharing.publicKey]);
      expect(openPack(re, [b.sharing]).payload).toEqual(payload);
      expect(readPackHeader(re).id).toBe(readPackHeader(pack).id);
      expect(readPackHeader(re).nonce).toBe(readPackHeader(pack).nonce);
      expect(re.subarray(re.length - payload.length - 16)).toEqual(pack.subarray(pack.length - payload.length - 16));
    });
    it('requires a key that can open the pack', () => {
      const [a, eve] = [person(), person()];
      expect(() => rewrapPack(sealPack(payload, [a.sharing.publicKey]), [eve.sharing], [eve.sharing.publicKey])).toThrow(DecryptionError);
    });
  });

  it('rejects invalid recipients', () => {
    expect(() => sealPack(payload, [])).toThrow(FormatError);
    expect(() => sealPack(payload, [new Uint8Array(31)])).toThrow(FormatError);
  });

  it('etag is a stable content hash', () => {
    const a = person();
    const pack = sealPack(payload, [a.sharing.publicKey]);
    expect(packEtag(pack)).toBe(packEtag(pack.slice()));
    expect(packEtag(pack)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const t = pack.slice();
    t[t.length - 1] = (t[t.length - 1] as number) ^ 1;
    expect(packEtag(t)).not.toBe(packEtag(pack));
  });
});
