import { describe, expect, it } from 'vitest';
import {
  DecryptionError,
  decodeKeyExport,
  encodeKeyExport,
  FormatError,
  generateDeviceKeys,
  identityFromPhrase,
  openSharingKey,
  sealSharingKey,
  UnsupportedVersionError,
} from '../src/index';
import { person, te } from './helpers';

describe('sealed sharing key: device delivery', () => {
  it('reaches a certified device, bound to that device', () => {
    const p = person();
    const sealed = sealSharingKey({ keyPair: p.sharing, cert: p.cert, vaultDataKey: p.vaultDataKey }, p.deviceCert);
    expect(new TextDecoder().decode(sealed.subarray(0, 4))).toBe('TLSK');
    const got = openSharingKey(sealed, p.device, { expectedOwner: p.id.owner });
    expect(got.keyPair.secretKey).toEqual(p.sharing.secretKey);
    expect(got.cert.key).toBe(p.cert.key);
    expect(got.vaultDataKey).toEqual(p.vaultDataKey); // TLSK v2 carries the vault data key (V3-10)
    expect(() => openSharingKey(sealed, generateDeviceKeys())).toThrow(DecryptionError);
    expect(() => openSharingKey(sealed, p.device, { expectedOwner: person().id.owner })).toThrow(expect.objectContaining({ code: 'OWNER_MISMATCH' }));
  });

  it('refuses a device certificate of another owner and a key pair that does not match the cert', () => {
    const [a, b] = [person(), person()];
    expect(() => sealSharingKey({ keyPair: a.sharing, cert: a.cert, vaultDataKey: a.vaultDataKey }, b.deviceCert)).toThrow(expect.objectContaining({ code: 'OWNER_MISMATCH' }));
    expect(() => sealSharingKey({ keyPair: b.sharing, cert: a.cert, vaultDataKey: b.vaultDataKey }, a.deviceCert)).toThrow(FormatError);
  });

  it('rejects a mode that does not match the holder, other versions and tampering', () => {
    const p = person();
    const sealed = sealSharingKey({ keyPair: p.sharing, cert: p.cert, vaultDataKey: p.vaultDataKey }, p.deviceCert);
    expect(() => openSharingKey(sealed, p.id)).toThrow(FormatError);
    const v = sealed.slice();
    v[4] = 1;
    expect(() => openSharingKey(v, p.device)).toThrow(UnsupportedVersionError);
    const t = sealed.slice();
    t[t.length - 1] = (t[t.length - 1] as number) ^ 1;
    expect(() => openSharingKey(t, p.device)).toThrow(DecryptionError);
  });
});

describe('sealed sharing key: recovery vault', () => {
  it('is opened with the identity restored from the phrase', () => {
    const p = person();
    const sealed = sealSharingKey({ keyPair: p.sharing, cert: p.cert, vaultDataKey: p.vaultDataKey }, p.id);
    const got = openSharingKey(sealed, identityFromPhrase(p.phrase));
    expect(got.keyPair.publicKey).toEqual(p.sharing.publicKey);
    expect(got.cert).toEqual(p.cert);
    expect(got.vaultDataKey).toEqual(p.vaultDataKey);
  });
  it('cannot be opened by a device, another identity, or after tampering', () => {
    const [p, q] = [person(), person()];
    const sealed = sealSharingKey({ keyPair: p.sharing, cert: p.cert, vaultDataKey: p.vaultDataKey }, p.id);
    expect(() => openSharingKey(sealed, p.device)).toThrow(FormatError);
    expect(() => openSharingKey(sealed, q.id)).toThrow(DecryptionError);
    const t = sealed.slice();
    t[8] = (t[8] as number) ^ 1; // nonce is in the AD
    expect(() => openSharingKey(t, p.id)).toThrow(DecryptionError);
  });
  it('refuses to seal another owner’s sharing key into my vault', () => {
    const [p, q] = [person(), person()];
    expect(() => sealSharingKey({ keyPair: q.sharing, cert: q.cert, vaultDataKey: q.vaultDataKey }, p.id)).toThrow(expect.objectContaining({ code: 'OWNER_MISMATCH' }));
  });
});

describe('key export (link + code transfer payload)', () => {
  it('carries only the current sharing key, its certificate and the vault data key', () => {
    const p = person();
    const bytes = encodeKeyExport({ keyPair: p.sharing, cert: p.cert, vaultDataKey: p.vaultDataKey });
    const doc = JSON.parse(new TextDecoder().decode(bytes));
    expect(Object.keys(doc)).toEqual(['cert', 'secret', 'type', 'vault_key', 'version']);
    expect(doc.version).toBe(3);
    const got = decodeKeyExport(bytes, { expectedOwner: p.id.owner });
    expect(got.keyPair.secretKey).toEqual(p.sharing.secretKey);
    expect(got.vaultDataKey).toEqual(p.vaultDataKey);
    expect(() => encodeKeyExport({ keyPair: p.sharing, cert: p.cert, vaultDataKey: new Uint8Array(5) })).toThrow(FormatError);
  });
  it('rejects a mismatched key/cert, another owner, and other versions', () => {
    const [a, b] = [person(), person()];
    expect(() => encodeKeyExport({ keyPair: b.sharing, cert: a.cert, vaultDataKey: b.vaultDataKey })).toThrow(FormatError);
    const ok = encodeKeyExport({ keyPair: a.sharing, cert: a.cert, vaultDataKey: a.vaultDataKey });
    expect(() => decodeKeyExport(ok, { expectedOwner: b.id.owner })).toThrow(expect.objectContaining({ code: 'OWNER_MISMATCH' }));
    const doc = JSON.parse(new TextDecoder().decode(ok));
    doc.secret = Buffer.from(b.sharing.secretKey).toString('base64url');
    expect(() => decodeKeyExport(te.encode(JSON.stringify(doc)))).toThrow(FormatError);
    expect(() => decodeKeyExport(te.encode('{"type":"key-export","version":2}'))).toThrow(UnsupportedVersionError);
  });
});
