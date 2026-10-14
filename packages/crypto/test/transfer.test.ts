import { describe, expect, it } from 'vitest';
import {
  decodeKeyExport,
  decryptTransfer,
  DecryptionError,
  encodeKeyExport,
  encryptForTransfer,
  ExpiredError,
  FormatError,
  generateTransferCode,
  normalizeTransferCode,
  openPack,
  sealPack,
  UnsupportedVersionError,
} from '../src/index';
import { person, publish, td, te } from './helpers';

const now = new Date('2026-10-13T12:00:00.000Z');
const at = (ms: number) => new Date(now.getTime() + ms);

describe('transfer code', () => {
  it('generates 6 words (66 bits) and normalizes user input', () => {
    const c = generateTransferCode();
    expect(c.split(' ')).toHaveLength(6);
    expect(normalizeTransferCode(`  ${c.toUpperCase().replace(/ /g, ' - ')} `)).toBe(c);
    expect(normalizeTransferCode('aban abil able abou abov abse')).toBe('abandon ability able about above absent');
    expect(normalizeTransferCode('act add age aim air all')).toBe('act add age aim air all'); // 3-letter words
    for (let i = 0; i < 50; i++) {
      const g = generateTransferCode();
      expect(normalizeTransferCode(g)).toBe(g);
    }
    for (const bad of ['abandon ability', 'abandon ability able about above xyzzy', 'abandonx ability able about above absent', 'aba ability able about above absent']) {
      expect(() => normalizeTransferCode(bad)).toThrow(expect.objectContaining({ code: 'INVALID_CODE' }));
    }
  });

  it('round-trips with default Argon2id params and the documented layout', () => {
    const code = generateTransferCode();
    const blob = encryptForTransfer(te.encode('secret'), code, { now });
    expect(td.decode(blob.subarray(0, 4))).toBe('TLTX');
    expect(blob[4]).toBe(2);
    expect(blob[5]).toBe(1);
    const dv = new DataView(blob.buffer, blob.byteOffset);
    expect(dv.getUint32(14)).toBe(Math.floor(now.getTime() / 1000) + 15 * 60);
    expect(td.decode(decryptTransfer(blob, code.toUpperCase(), { now: at(1000) }))).toBe('secret');
  });

  it('expires after 15 minutes (T-002 F-09), and the expiry is authenticated', () => {
    const code = generateTransferCode();
    const blob = encryptForTransfer(te.encode('k'), code, { now });
    expect(() => decryptTransfer(blob, code, { now: at(15 * 60 * 1000) })).toThrow(ExpiredError);
    const t = blob.slice();
    new DataView(t.buffer).setUint32(14, 0xfffffff0, false);
    expect(() => decryptTransfer(t, code, { now: at(20 * 60 * 1000) })).toThrow(DecryptionError);
    expect(() => encryptForTransfer(te.encode('k'), code, { ttlMs: 16 * 60 * 1000 })).toThrow(FormatError);
  });

  it('wrong code / tampering fail', () => {
    const code = generateTransferCode();
    const blob = encryptForTransfer(te.encode('k'), code, { now });
    expect(() => decryptTransfer(blob, generateTransferCode(), { now })).toThrow(DecryptionError);
    for (const pos of [20, blob.length - 1]) {
      const t = blob.slice();
      t[pos] = (t[pos] as number) ^ 1;
      expect(() => decryptTransfer(t, code, { now })).toThrow(DecryptionError);
    }
    const v = blob.slice();
    v[4] = 3;
    expect(() => decryptTransfer(v, code, { now })).toThrow(UnsupportedVersionError);
    const p = blob.slice();
    p[5] = 2;
    expect(() => decryptTransfer(p, code, { now })).toThrow(FormatError);
  });

  it('Argon2 parameters are floored on encrypt and capped on decrypt (T-002 F-09)', () => {
    const code = generateTransferCode();
    expect(() => encryptForTransfer(te.encode('k'), code, { params: { opslimit: 1, memlimit: 8192 } })).toThrow(FormatError);
    const blob = encryptForTransfer(te.encode('k'), code, { now });
    const huge = blob.slice();
    new DataView(huge.buffer).setUint32(10, 512 * 1024 * 1024, false);
    expect(() => decryptTransfer(huge, code, { now })).toThrow(FormatError);
    const weak = blob.slice();
    new DataView(weak.buffer).setUint32(6, 1, false);
    expect(() => decryptTransfer(weak, code, { now })).toThrow(FormatError);
  });

  it('moves the current sharing key to a new device, which can then read content', () => {
    const a = person();
    const code = generateTransferCode();
    const blob = encryptForTransfer(encodeKeyExport({ keyPair: a.sharing, cert: a.cert }), code, { now });
    const got = decodeKeyExport(decryptTransfer(blob, code, { now }), { expectedOwner: a.id.owner });
    const pack = sealPack(te.encode('hello'), [a.sharing.publicKey]);
    expect(td.decode(openPack(pack, publish(a, [pack]), [got.keyPair]).payload)).toBe('hello');
  });
});
