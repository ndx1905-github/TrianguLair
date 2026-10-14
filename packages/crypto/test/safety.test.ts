import { describe, expect, it } from 'vitest';
import { FormatError, identityFromPhrase, matchSafetyQr, safetyCode, safetyQrPayload } from '../src/index';
import { person } from './helpers';

const A = identityFromPhrase('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const B = identityFromPhrase('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong');

describe('safety code (T-002 Q5)', () => {
  it('is 12 groups of 5 digits, identical on both sides', () => {
    const ab = safetyCode(A.owner, B.owner);
    expect(ab).toHaveLength(12);
    for (const g of ab) expect(g).toMatch(/^\d{5}$/);
    expect(safetyCode(B.owner, A.owner)).toEqual(ab);
    expect(safetyCode(A.master.publicKey, B.master.publicKey)).toEqual(ab);
  });
  it('known-answer vector', () => {
    expect(safetyCode(A.owner, B.owner).join(' ')).toBe('68837 97144 34561 87987 02914 75540 69933 29066 37597 82790 51294 14392');
  });
  it('changes when either identity changes', () => {
    const c = person();
    expect(safetyCode(A.owner, c.id.owner)).not.toEqual(safetyCode(A.owner, B.owner));
    expect(safetyCode(c.id.owner, B.owner)).not.toEqual(safetyCode(A.owner, B.owner));
  });
  it('QR payload: order-independent, matches only the same pair', () => {
    const qr = safetyQrPayload(A.owner, B.owner);
    expect(qr).toMatch(/^tlsafe1:[A-Za-z0-9_-]{43}$/);
    expect(matchSafetyQr(qr, B.owner, A.owner)).toBe(true);
    expect(matchSafetyQr(qr, B.owner, person().id.owner)).toBe(false);
    expect(matchSafetyQr('garbage', B.owner, A.owner)).toBe(false);
  });
  it('rejects malformed owner ids', () => {
    expect(() => safetyCode('ed25519:abc', B.owner)).toThrow(FormatError);
  });
});
