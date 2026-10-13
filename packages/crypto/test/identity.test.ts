import { describe, expect, it } from 'vitest';
import {
  decodePrimaryIdentity,
  devicePublicKeys,
  encodePrimaryIdentity,
  FormatError,
  generateDeviceKeys,
  generateRecoveryPhrase,
  generateX25519KeyPair,
  identityFromPhrase,
  issueDeviceCert,
  issueIdentityMove,
  issueSharingCert,
  RollbackError,
  serialize,
  SignatureError,
  TLCryptoError,
  UnsupportedVersionError,
  verifyDeviceCert,
  verifyIdentityMove,
  verifySharingCert,
} from '../src/index';
import { signBody } from '../src/sign';

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
    expect(b.vaultKey).toEqual(a.vaultKey);
    expect(a.owner).toMatch(/^ed25519:[A-Za-z0-9_-]{43}$/);
    expect(a.master.secretKey).toHaveLength(64);
    expect(a.vaultKey).toHaveLength(32);
  });
  it('known-answer vectors (phrase -> owner id)', () => {
    expect(identityFromPhrase(PHRASE).owner).toBe('ed25519:-fgIxqXPzFIS2x-jBHynqSYhE09pR9YHwiLO2AQ4GBk');
    expect(identityFromPhrase('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong').owner).toBe('ed25519:2Jq2aakrbCMmfTnYcUEL7rNpLWpomO67NGibOr9zb4k');
  });
  it('different phrases give different identities', () => {
    expect(identityFromPhrase(generateRecoveryPhrase()).owner).not.toBe(identityFromPhrase(PHRASE).owner);
  });
  it('the identity holds no root seed: only the master key and the vault key (T-002 F-01, F-14)', () => {
    expect(Object.keys(identityFromPhrase(PHRASE)).sort()).toEqual(['master', 'owner', 'vaultKey']);
  });
  it('rejects bad checksum, unknown words and wrong length', () => {
    const bad = PHRASE.replace(/about$/, 'abandon');
    for (const p of [bad, 'foo '.repeat(12), 'abandon '.repeat(10) + 'about', `${PHRASE} abandon abandon abandon`, '']) {
      expect(() => identityFromPhrase(p)).toThrow(TLCryptoError);
      expect(() => identityFromPhrase(p)).toThrow(expect.objectContaining({ code: 'INVALID_PHRASE' }));
    }
  });
});

describe('primary device', () => {
  it('stores and restores the master key and vault key (69 bytes)', () => {
    const id = identityFromPhrase(PHRASE);
    const bytes = encodePrimaryIdentity(id);
    expect(bytes).toHaveLength(69);
    const back = decodePrimaryIdentity(bytes);
    expect(back.owner).toBe(id.owner);
    expect(back.master.secretKey).toEqual(id.master.secretKey);
    expect(back.vaultKey).toEqual(id.vaultKey);
  });
  it('rejects bad magic, version and length', () => {
    const bytes = encodePrimaryIdentity(identityFromPhrase(PHRASE));
    const t = bytes.slice();
    t[0] = 0;
    expect(() => decodePrimaryIdentity(t)).toThrow(FormatError);
    const v = bytes.slice();
    v[4] = 2;
    expect(() => decodePrimaryIdentity(v)).toThrow(UnsupportedVersionError);
    expect(() => decodePrimaryIdentity(bytes.subarray(0, 68))).toThrow(FormatError);
  });
});

describe('device keys and certificates', () => {
  const id = identityFromPhrase(PHRASE);
  it('each device generates its own keys', () => {
    const [d1, d2] = [generateDeviceKeys(), generateDeviceKeys()];
    expect(d1.id).toMatch(/^ed25519:/);
    expect(d1.id).not.toBe(d2.id);
    expect(d1.sign.secretKey).toHaveLength(64);
    expect(d1.box.secretKey).toHaveLength(32);
  });
  it('the master certifies a device; the certificate verifies and binds both device keys', () => {
    const d = generateDeviceKeys();
    const cert = issueDeviceCert(id, devicePublicKeys(d));
    expect(cert).toMatchObject({ type: 'device-cert', version: 1, owner: id.owner, device: d.id });
    expect(verifyDeviceCert(serialize(cert), { expectedOwner: id.owner }).device).toBe(d.id);
    expect(() => verifyDeviceCert({ ...cert, device: generateDeviceKeys().id })).toThrow(SignatureError);
    expect(() => verifyDeviceCert({ ...cert, box: devicePublicKeys(generateDeviceKeys()).box })).toThrow(SignatureError);
    expect(() => verifyDeviceCert(cert, { expectedOwner: identityFromPhrase(generateRecoveryPhrase()).owner })).toThrow(
      expect.objectContaining({ code: 'OWNER_MISMATCH' }),
    );
  });
  it('a device key cannot certify another device (only the master can)', () => {
    const d = generateDeviceKeys();
    const forged = signBody('device-cert', { type: 'device-cert', version: 1, owner: id.owner, ...devicePublicKeys(generateDeviceKeys()) }, d.sign.secretKey);
    expect(() => verifyDeviceCert(forged)).toThrow(SignatureError);
  });
});

describe('sharing certificate', () => {
  const id = identityFromPhrase(PHRASE);
  const other = identityFromPhrase(generateRecoveryPhrase());
  const k1 = generateX25519KeyPair();
  const cert = issueSharingCert(id, k1.publicKey, { rotation: 1 });

  it('sharing keys are random, never derived from the phrase', () => {
    expect(generateX25519KeyPair().publicKey).not.toEqual(generateX25519KeyPair().publicKey);
  });
  it('verifies and returns keys', () => {
    const v = verifySharingCert(serialize(cert), { expectedOwner: id.master.publicKey });
    expect(v.sharingPublicKey).toEqual(k1.publicKey);
    expect(v.ownerPublicKey).toEqual(id.master.publicKey);
    expect(v.cert.rotation).toBe(1);
    expect(v.cert.revoked_devices).toEqual([]);
  });
  it('rejects tampering of any field', () => {
    const k2 = generateX25519KeyPair();
    for (const t of [
      { ...cert, rotation: 5 },
      { ...cert, revoked_devices: [generateDeviceKeys().id] },
      { ...cert, key: `x25519:${Buffer.from(k2.publicKey).toString('base64url')}` },
    ]) expect(() => verifySharingCert(t)).toThrow(SignatureError);
  });
  it('rejects a cert re-signed by another owner when an owner is expected', () => {
    const forged = issueSharingCert(other, k1.publicKey, { rotation: 1 });
    expect(() => verifySharingCert(forged)).not.toThrow();
    expect(() => verifySharingCert(forged, { expectedOwner: id.owner })).toThrow(expect.objectContaining({ code: 'OWNER_MISMATCH' }));
    expect(() => verifySharingCert({ ...cert, owner: other.owner })).toThrow(SignatureError);
  });
  it('rotation: new cert accepted, older rotation rejected, same rotation with other content is a fork', () => {
    const k2 = generateX25519KeyPair();
    const cert2 = issueSharingCert(id, k2.publicKey, { rotation: 2 });
    expect(verifySharingCert(cert2, { lastSeen: cert }).sharingPublicKey).toEqual(k2.publicKey);
    expect(() => verifySharingCert(cert, { lastSeen: cert2 })).toThrow(RollbackError);
    const conflicting = issueSharingCert(id, k2.publicKey, { rotation: 1 });
    expect(() => verifySharingCert(conflicting, { lastSeen: cert })).toThrow(expect.objectContaining({ code: 'ROLLBACK', fork: true }));
    expect(() => verifySharingCert(cert, { lastSeen: cert })).not.toThrow();
  });
  it('revocations are sorted, deduplicated and permanent', () => {
    const [a, b] = [generateDeviceKeys().id, generateDeviceKeys().id];
    const c2 = issueSharingCert(id, generateX25519KeyPair().publicKey, { rotation: 2, revokedDevices: [b, a, b] });
    expect(c2.revoked_devices).toEqual([a, b].sort());
    const c3 = issueSharingCert(id, generateX25519KeyPair().publicKey, { rotation: 3, revokedDevices: [a] });
    expect(() => verifySharingCert(c3, { lastSeen: c2 })).toThrow(RollbackError);
    const unsorted = signBody('sharing-cert', { ...c2, signature: undefined, revoked_devices: [...c2.revoked_devices].reverse() } as never, id.master.secretKey);
    expect(() => verifySharingCert(unsorted)).toThrow(FormatError);
  });
  it('rejects other versions with UnsupportedVersionError, and unknown fields', () => {
    expect(() => verifySharingCert({ ...cert, version: 3 })).toThrow(UnsupportedVersionError);
    expect(() => verifySharingCert({ ...cert, version: 1 })).toThrow(UnsupportedVersionError);
    expect(() => verifySharingCert({ ...cert, extra: 1 })).toThrow(FormatError);
    expect(() => verifySharingCert('{not json')).toThrow(FormatError);
  });
  it('retired owners (identity moved away) are refused', () => {
    expect(() => verifySharingCert(cert, { retiredOwners: [id.owner] })).toThrow(expect.objectContaining({ code: 'REVOKED' }));
  });
});

describe('identity move', () => {
  const oldId = identityFromPhrase(PHRASE);
  const newId = identityFromPhrase(generateRecoveryPhrase());
  const now = new Date('2026-10-13T12:00:00.000Z');
  const move = issueIdentityMove(oldId, newId, { now });

  it('is signed by the old master and countersigned by the new one', () => {
    expect(move).toMatchObject({ type: 'identity-move', version: 1, from: oldId.owner, to: newId.owner, issued: now.toISOString() });
    expect(verifyIdentityMove(serialize(move), { expectedFrom: oldId.owner }).to).toBe(newId.owner);
  });
  it('rejects tampering, a move to a key without its countersignature, and the wrong origin', () => {
    const third = identityFromPhrase(generateRecoveryPhrase());
    expect(() => verifyIdentityMove({ ...move, to: third.owner })).toThrow(SignatureError);
    expect(() => verifyIdentityMove({ ...move, issued: '2026-10-14T12:00:00.000Z' })).toThrow(SignatureError);
    expect(() => verifyIdentityMove(move, { expectedFrom: third.owner })).toThrow(expect.objectContaining({ code: 'OWNER_MISMATCH' }));
    expect(() => issueIdentityMove(oldId, oldId)).toThrow(FormatError);
  });
});
