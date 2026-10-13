import { describe, expect, it } from 'vitest';
import {
  decodeKeyExport,
  decryptTransfer,
  DecryptionError,
  encodeKeyExport,
  encryptForTransfer,
  FormatError,
  generateTransferCode,
  normalizeTransferCode,
  openPack,
  sealPack,
  UnsupportedVersionError,
} from '../src/index';
import { person, td, te } from './helpers';

const FAST = { opslimit: 1, memlimit: 8192 * 1024 };

describe('transfer code', () => {
  it('generates 12-char Crockford codes, normalizes user input', () => {
    const c = generateTransferCode();
    expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(normalizeTransferCode(c.toLowerCase().replace(/-/g, ' '))).toBe(c.replace(/-/g, ''));
    expect(normalizeTransferCode('oooo-iiii-llll')).toBe('000011111111');
    expect(() => normalizeTransferCode('ABC')).toThrow(expect.objectContaining({ code: 'INVALID_CODE' }));
    expect(() => normalizeTransferCode('UUUU-UUUU-UUUU')).toThrow(expect.objectContaining({ code: 'INVALID_CODE' }));
  });

  it('round-trips with default Argon2id (interactive) params and documented layout', () => {
    const code = generateTransferCode();
    const blob = encryptForTransfer(te.encode('secret seed'), code);
    expect(td.decode(blob.subarray(0, 4))).toBe('TLTX');
    expect(blob[4]).toBe(1);
    expect(td.decode(decryptTransfer(blob, code.toLowerCase()))).toBe('secret seed');
  });

  it('wrong code / tampering fail', () => {
    const code = generateTransferCode();
    const blob = encryptForTransfer(te.encode('k'), code, FAST);
    expect(() => decryptTransfer(blob, generateTransferCode())).toThrow(DecryptionError);
    for (const pos of [20, blob.length - 1]) {
      const t = blob.slice();
      t[pos] = (t[pos] as number) ^ 1;
      expect(() => decryptTransfer(t, code)).toThrow(DecryptionError);
    }
    const t = blob.slice();
    t[4] = 2;
    expect(() => decryptTransfer(t, code)).toThrow(UnsupportedVersionError);
    const huge = blob.slice();
    new DataView(huge.buffer).setUint32(9, 0xffffffff, false);
    expect(() => decryptTransfer(huge, code)).toThrow(FormatError);
  });

  it('moves a full identity to a new device', () => {
    const a = person();
    const code = generateTransferCode();
    const blob = encryptForTransfer(encodeKeyExport({ identity: a.id }), code, FAST);
    const got = decodeKeyExport(decryptTransfer(blob, code));
    expect(got.identity!.master.publicKey).toEqual(a.id.master.publicKey);
    expect(got.identity!.owner).toBe(a.id.owner);
  });

  it('moves only a sharing key (limited device) which can open content', () => {
    const a = person();
    const code = generateTransferCode();
    const blob = encryptForTransfer(encodeKeyExport({ sharing: { keyPair: a.sharing, cert: a.cert } }), code, FAST);
    const got = decodeKeyExport(decryptTransfer(blob, code));
    expect(got.identity).toBeUndefined();
    const pack = sealPack(te.encode('hello'), [a.sharing.publicKey]);
    expect(td.decode(openPack(pack, [got.sharing!.keyPair]).payload)).toBe('hello');
  });

  it('key export rejects mismatched key/cert and newer versions', () => {
    const [a, b] = [person(), person()];
    expect(() => decodeKeyExport(encodeKeyExport({ sharing: { keyPair: b.sharing, cert: a.cert } }))).toThrow(FormatError);
    expect(() => decodeKeyExport(te.encode('{"type":"key-export","version":3}'))).toThrow(UnsupportedVersionError);
    expect(() => encodeKeyExport({})).toThrow(FormatError);
  });
});
