import { describe, expect, it } from 'vitest';
import { assertX25519PublicKey, isoDate, parseJsonObject } from '../src/encoding';
import { canonicalize, FormatError, fromB64Url, generateX25519KeyPair, InvalidKeyError, parseKey, toB64Url } from '../src/index';

describe('canonical JSON', () => {
  it('sorts keys recursively and strips whitespace', () => {
    expect(canonicalize({ b: 1, a: { d: [3, { z: true, y: null }], c: 'x' } })).toBe('{"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1}');
  });
  it('is independent of insertion order', () => {
    expect(canonicalize({ x: 1, y: 2 })).toBe(canonicalize({ y: 2, x: 1 }));
  });
  it('sorts by UTF-16 code units (JCS) and escapes like JSON.stringify', () => {
    expect(canonicalize({ é: 1, Z: 2, a: 3, '€': 4 })).toBe('{"Z":2,"a":3,"é":1,"€":4}');
    expect(canonicalize('a"b\n')).toBe('"a\\"b\\n"');
  });
  it('rejects floats, NaN, undefined, bigint and class instances', () => {
    expect(() => canonicalize(1.5)).toThrow(FormatError);
    expect(() => canonicalize(NaN)).toThrow(FormatError);
    expect(() => canonicalize({ a: undefined })).toThrow(FormatError);
    expect(() => canonicalize(10n)).toThrow(FormatError);
    expect(() => canonicalize(new Date())).toThrow(FormatError);
    expect(canonicalize(-0)).toBe('0');
  });
  it('does not echo a rejected number in the error message (T-002 F-15)', () => {
    let msg = '';
    try {
      canonicalize({ lat: 48.8566 });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).not.toBe('');
    expect(msg).not.toContain('48');
  });
});

describe('canonical input (T-002 F-05)', () => {
  it('accepts canonical text and in-process objects', () => {
    expect(parseJsonObject('{"a":1,"b":2}', 'x')).toEqual({ a: 1, b: 2 });
    expect(parseJsonObject({ b: 2, a: 1 }, 'x')).toEqual({ a: 1, b: 2 });
  });
  it('rejects duplicate keys, whitespace, key-order and number-format variants in transported JSON', () => {
    for (const s of ['{"a":1,"a":2}', '{"b":2,"a":1}', '{"a": 1}', '{"a":1.0}', ' {"a":1}', '{"a":"\\u0041"}']) {
      expect(() => parseJsonObject(s, 'x')).toThrow(FormatError);
    }
  });
});

describe('base64url', () => {
  it('round-trips and is strict', () => {
    const b = new Uint8Array([0xfb, 0xff, 0x00, 1]);
    const s = toB64Url(b);
    expect(s).toBe('-_8AAQ');
    expect(fromB64Url(s)).toEqual(b);
    expect(() => fromB64Url('-_8AAQ==')).toThrow(FormatError);
    expect(() => fromB64Url('+/8AAQ')).toThrow(FormatError);
    expect(() => fromB64Url('-_8AAR')).toThrow(FormatError); // non-canonical trailing bits
    expect(() => fromB64Url(s, 'x', 5)).toThrow(FormatError);
  });
});

describe('dates (T-002 F-13)', () => {
  it('accepts real instants with or without milliseconds', () => {
    expect(isoDate({ d: '2026-02-28T23:59:59.999Z' }, 'd', 'x')).toBe(Date.parse('2026-02-28T23:59:59.999Z'));
    expect(isoDate({ d: '2026-10-13T15:10:00Z' }, 'd', 'x')).toBe(Date.parse('2026-10-13T15:10:00Z'));
  });
  it('rejects impossible calendar dates and other forms', () => {
    for (const d of ['2026-02-30T00:00:00.000Z', '2026-13-01T00:00:00.000Z', '2026-01-01T24:00:00.000Z', '2026-01-01 00:00:00Z', '2026-01-01T00:00:00+01:00']) {
      expect(() => isoDate({ d }, 'd', 'x')).toThrow(FormatError);
    }
  });
});

describe('X25519 public key validation (T-002 F-03)', () => {
  const lowOrder = [
    new Uint8Array(32),
    Uint8Array.from([1, ...new Array<number>(31).fill(0)]),
    // a point of order 8 (from the libsodium blacklist)
    Uint8Array.from(Buffer.from('e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800', 'hex')),
  ];
  it('rejects all-zero and low-order keys with InvalidKeyError', () => {
    for (const k of lowOrder) {
      expect(() => assertX25519PublicKey(k)).toThrow(InvalidKeyError);
      expect(() => parseKey('x25519', `x25519:${toB64Url(k)}`)).toThrow(expect.objectContaining({ code: 'INVALID_KEY' }));
    }
  });
  it('accepts ordinary keys', () => {
    expect(() => assertX25519PublicKey(generateX25519KeyPair().publicKey)).not.toThrow();
  });
});
