import { describe, expect, it } from 'vitest';
import { canonicalize, FormatError, fromB64Url, toB64Url } from '../src/index';

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
