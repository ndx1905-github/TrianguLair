import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  deriveSharingKeyPair,
  FormatError,
  generateRecoveryPhrase,
  identityFromPhrase,
  issueSharingCert,
  RollbackError,
  SignatureError,
  TLCryptoError,
  UnsupportedVersionError,
  verifySharingCert,
} from '../src/index';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('recovery phrase -> identity', () => {
  it('generates 12 valid words', () => {
    const p = generateRecoveryPhrase();
    expect(p.split(' ')).toHaveLength(12);
    expect(() => identityFromPhrase(p)).not.toThrow();
  });
  it('is deterministic and tolerant to case/whitespace', () => {
    const a = identityFromPhrase(PHRASE);
    const b = identityFromPhrase(`  ${PHRASE.toUpperCase().replace(/ /g, '   ')} `);
    expect(b.master.publicKey).toEqual(a.master.publicKey);
    expect(a.owner).toMatch(/^ed25519:[A-Za-z0-9_-]{43}$/);
    expect(a.master.secretKey).toHaveLength(64);
  });
  it('different phrases give different identities', () => {
    expect(identityFromPhrase(generateRecoveryPhrase()).owner).not.toBe(identityFromPhrase(PHRASE).owner);
  });
  it('rejects bad checksum, unknown words and wrong length', () => {
    const bad = PHRASE.replace(/about$/, 'abandon');
    for (const p of [bad, 'foo '.repeat(12), 'abandon '.repeat(10) + 'about', `${PHRASE} abandon abandon abandon`, '']) {
      expect(() => identityFromPhrase(p)).toThrow(TLCryptoError);
      expect(() => identityFromPhrase(p)).toThrow(expect.objectContaining({ code: 'INVALID_PHRASE' }));
    }
  });
  it('sharing keys are deterministic per rotation and distinct across rotations', () => {
    const id = identityFromPhrase(PHRASE);
    const k0 = deriveSharingKeyPair(id, 0);
    expect(deriveSharingKeyPair(identityFromPhrase(PHRASE), 0).publicKey).toEqual(k0.publicKey);
    expect(deriveSharingKeyPair(id, 1).publicKey).not.toEqual(k0.publicKey);
    // sharing key is unrelated to master key bytes
    expect(k0.publicKey).not.toEqual(id.master.publicKey);
  });
});

describe('sharing certificate', () => {
  const id = identityFromPhrase(PHRASE);
  const other = identityFromPhrase(generateRecoveryPhrase());
  const k1 = deriveSharingKeyPair(id, 1);
  const cert = issueSharingCert(id, k1.publicKey, { rotation: 1, now: new Date('2026-10-01T00:00:00Z') });

  it('verifies and returns keys', () => {
    const v = verifySharingCert(canonicalize(cert), { expectedOwner: id.master.publicKey });
    expect(v.sharingPublicKey).toEqual(k1.publicKey);
    expect(v.ownerPublicKey).toEqual(id.master.publicKey);
    expect(v.cert.rotation).toBe(1);
  });
  it('rejects tampering of any field', () => {
    const k2 = deriveSharingKeyPair(id, 2);
    for (const t of [
      { ...cert, rotation: 5 },
      { ...cert, issued: '2026-10-02T00:00:00.000Z' },
      { ...cert, key: `x25519:${Buffer.from(k2.publicKey).toString('base64url')}` },
    ]) expect(() => verifySharingCert(t)).toThrow(SignatureError);
  });
  it('rejects a cert re-signed by another owner when an owner is expected', () => {
    const forged = issueSharingCert(other, k1.publicKey, { rotation: 1 });
    expect(() => verifySharingCert(forged)).not.toThrow();
    expect(() => verifySharingCert(forged, { expectedOwner: id.owner })).toThrow(expect.objectContaining({ code: 'OWNER_MISMATCH' }));
    // swapping the owner field breaks the signature
    expect(() => verifySharingCert({ ...cert, owner: other.owner })).toThrow(SignatureError);
  });
  it('rotation: new cert accepted, older rotation rejected as rollback', () => {
    const k2 = deriveSharingKeyPair(id, 2);
    const cert2 = issueSharingCert(id, k2.publicKey, { rotation: 2 });
    expect(verifySharingCert(cert2, { lastSeen: cert }).sharingPublicKey).toEqual(k2.publicKey);
    expect(() => verifySharingCert(cert, { lastSeen: cert2 })).toThrow(RollbackError);
    const conflicting = issueSharingCert(id, k2.publicKey, { rotation: 1 });
    expect(() => verifySharingCert(conflicting, { lastSeen: cert })).toThrow(RollbackError);
  });
  it('rejects unknown higher versions with UnsupportedVersionError, and unknown fields', () => {
    expect(() => verifySharingCert({ ...cert, version: 2 })).toThrow(UnsupportedVersionError);
    expect(() => verifySharingCert({ ...cert, extra: 1 })).toThrow(FormatError);
    expect(() => verifySharingCert('{not json')).toThrow(FormatError);
  });
});
