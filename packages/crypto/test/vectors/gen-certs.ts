import { canonicalize, formatKey, issueIdentityMove, issueSharingCert, serialize, toB64Url } from '../../src/index';
import { FileBuilder, type VectorFile } from './builder';
import { iso, plain, rawCert, signDoc, T0 } from './fixtures';
import type { JsonObj } from './ops';
import type { Shared } from './shared';

const lowOrder = 'x25519:' + toB64Url(Uint8Array.of(1, ...new Array<number>(31).fill(0)));

export function sharingCertVectors(sh: Shared): VectorFile {
  const { w } = sh;
  const { alice, bob } = w;
  const b = new FileBuilder('sharing-cert', 'sharing-cert.md', 'Master-signed sharing certificate (key, read address, revoked devices, rotation).');
  const c0 = serialize(alice.cert0);
  const c1 = serialize(w.aliceCert1);
  const base = plain(alice.cert0);
  const body1 = plain(w.aliceCert1);
  const re = (over: JsonObj, from: JsonObj = base) => rawCert(alice.id, { ...from, ...over });
  const v = (name: string, d: string, text: string, want: string, options?: JsonObj) => b.add(name, d, 'verify_sharing_cert', options ? { text, options } : { text }, want);
  const { signature: _s, ...unsigned } = base;
  v('cert-rotation-0', 'Alice, rotation 0, with read address.', c0, 'ok', { expectedOwner: alice.id.owner });
  b.file.vectors[b.file.vectors.length - 1]!.details = { signed_message: canonicalize(unsigned) };
  v('cert-rotation-1', 'Rotation 1: new key, d2 revoked; lastSeen = rotation 0.', c1, 'ok', { lastSeen: c0 });
  v('cert-same-as-lastseen', 'Re-delivery of the certificate already held.', c1, 'ok', { lastSeen: c1 });
  v('cert-no-location', 'An owner who publishes nothing: no "location".', serialize(issueSharingCert(alice.id, alice.sharing.publicKey, { rotation: 0 })), 'ok');
  v('cert-minor-extension', 'minor 1: an unknown field is accepted and covered by the signature.', re({ minor: 1, x_note: 'future' }), 'ok');
  v('cert-crit-known', 'crit lists a known field ("location").', re({ crit: ['location'] }), 'ok');
  v('cert-max-rotation', 'rotation 2^32 - 1.', re({ rotation: 4294967295 }), 'ok');
  v('cert-tampered', 'Rotation changed after signing.', canonicalize({ ...base, rotation: 7 }), 'SIGNATURE');
  v('cert-domain-confusion', 'Body signed under the "device-cert" domain.', signDoc('device-cert', base, alice.id.master.secretKey), 'SIGNATURE');
  v('cert-signed-by-device', 'Signed by a device key instead of the master.', signDoc('sharing-cert', base, alice.d1.sign.secretKey), 'SIGNATURE');
  v('cert-version-4', 'Major version 4.', re({ version: 4 }), 'UNSUPPORTED_VERSION');
  v('cert-version-0', 'Version 0.', re({ version: 0 }), 'FORMAT');
  v('cert-minor-0', 'minor 0 must be omitted.', re({ minor: 0 }), 'FORMAT');
  v('cert-unknown-field', 'Unknown field without a higher minor.', re({ x_note: 'future' }), 'FORMAT');
  v('cert-unknown-crit', 'crit names a field this reader does not know.', re({ minor: 1, x_new: 1, crit: ['x_new'] }), 'UNSUPPORTED_VERSION');
  v('cert-crit-absent', 'crit names an absent field.', re({ crit: ['x_new'] }), 'FORMAT');
  v('cert-crit-reserved', 'crit names a reserved field.', re({ crit: ['signature'] }), 'FORMAT');
  v('cert-crit-unsorted', 'crit not sorted.', re({ crit: ['rotation', 'location'] }), 'FORMAT');
  v('cert-crit-empty', 'crit empty.', re({ crit: [] }), 'FORMAT');
  v('cert-wrong-type', 'type = "device-cert".', re({ type: 'device-cert' }), 'FORMAT');
  v('cert-revoked-unsorted', 'revoked_devices not sorted.', re({ revoked_devices: [alice.d2.id, alice.d1.id].sort().reverse() }), 'FORMAT');
  v('cert-revoked-duplicate', 'revoked_devices with a duplicate.', re({ revoked_devices: [alice.d2.id, alice.d2.id] }), 'FORMAT');
  v('cert-rotation-2-32', 'rotation 2^32 (not a u32).', re({ rotation: 4294967296 }), 'FORMAT');
  v('cert-rotation-negative', 'rotation -1.', re({ rotation: -1 }), 'FORMAT');
  v('cert-low-order-key', 'Sharing key u = 1.', re({ key: lowOrder }), 'INVALID_KEY');
  const high = Buffer.from((base['key'] as string).slice(7), 'base64url');
  high[31] = (high[31] as number) | 0x80;
  v('cert-key-bit255', 'Sharing key with bit 255 set.', re({ key: 'x25519:' + toB64Url(high) }), 'INVALID_KEY');
  v('cert-http-location', 'location over http.', re({ location: 'http://storage.example.org/alice/' }), 'FORMAT');
  v('cert-local-location', 'location on a private address.', re({ location: 'https://192.168.1.10/alice/' }), 'FORMAT');
  v('cert-whitespace', 'Non-canonical text (a space).', c0.replace(',', ', '), 'FORMAT');
  v('cert-bom', 'Leading BOM.', '﻿' + c0, 'FORMAT');
  v('cert-duplicate-key', 'A duplicated "rotation" key (the JS parser keeps the last one).', c0.replace('"rotation":0', '"rotation":9,"rotation":0'), 'FORMAT');
  v('cert-expected-owner', 'expectedOwner = Bob.', c0, 'OWNER_MISMATCH', { expectedOwner: bob.id.owner });
  v('cert-retired-owner', 'Alice is a retired owner (moved identity).', c0, 'REVOKED', { retiredOwners: [alice.id.owner] });
  v('cert-rollback', 'Rotation 0 after rotation 1.', c0, 'ROLLBACK', { lastSeen: c1 });
  v('cert-fork', 'Another certificate for rotation 1 (other key).', re({ key: formatKey('x25519', bob.sharing.publicKey) }, body1), 'ROLLBACK', { lastSeen: c1 });
  v('cert-fork-extension', 'Same rotation, same key, one extension field more: still a fork.', re({ minor: 1, x_note: 'x' }, body1), 'ROLLBACK', { lastSeen: c1 });
  v('cert-unrevoke', 'Rotation 2 that no longer revokes d2.', re({ rotation: 2, revoked_devices: [] }, body1), 'ROLLBACK', { lastSeen: c1 });
  v('cert-lastseen-other-owner', 'lastSeen belongs to Bob.', c1, 'OWNER_MISMATCH', { lastSeen: serialize(bob.cert0) });
  return b.file;
}

export function deviceCertVectors(sh: Shared): VectorFile {
  const { w } = sh;
  const { alice, bob } = w;
  const b = new FileBuilder('device-cert', 'device-cert.md', 'Master-signed device certificate.');
  const t = serialize(alice.dc1);
  const base = plain(alice.dc1);
  const re = (over: JsonObj) => signDoc('device-cert', { ...base, ...over }, alice.id.master.secretKey);
  const v = (name: string, d: string, text: string, want: string, options?: JsonObj) => b.add(name, d, 'verify_device_cert', options ? { text, options } : { text }, want);
  v('dc-ok', 'Device d1 of Alice.', t, 'ok', { expectedOwner: alice.id.owner });
  v('dc-minor-extension', 'minor 1 with an unknown field.', re({ minor: 1, name: 'phone' }), 'ok');
  v('dc-tampered', 'box key replaced after signing.', canonicalize({ ...base, box: plain(alice.dc2)['box'] }), 'SIGNATURE');
  v('dc-other-master', 'owner = Alice, signed by Bob\'s master.', signDoc('device-cert', base, bob.id.master.secretKey), 'SIGNATURE');
  v('dc-domain-confusion', 'Signed under "sharing-cert".', signDoc('sharing-cert', base, alice.id.master.secretKey), 'SIGNATURE');
  v('dc-version-2', 'Version 2.', re({ version: 2 }), 'UNSUPPORTED_VERSION');
  const { box: _b, ...noBox } = base;
  v('dc-missing-box', 'box missing.', signDoc('device-cert', noBox, alice.id.master.secretKey), 'FORMAT');
  v('dc-unknown-field', 'Unknown field without minor.', re({ name: 'phone' }), 'FORMAT');
  v('dc-low-order-box', 'box u = 1.', re({ box: lowOrder }), 'INVALID_KEY');
  v('dc-device-as-x25519', 'device given as an x25519 key.', re({ device: 'x25519:' + (base['device'] as string).slice(8) }), 'FORMAT');
  v('dc-expected-owner', 'expectedOwner = Bob.', t, 'OWNER_MISMATCH', { expectedOwner: bob.id.owner });
  v('dc-retired', 'Alice retired.', t, 'REVOKED', { retiredOwners: [alice.id.owner] });
  v('dc-key-order', 'Keys out of order.', t.replace(/^\{("box":"[^"]+"),("device":"[^"]+")/, '{$2,$1'), 'FORMAT');
  return b.file;
}

export function identityMoveVectors(sh: Shared): VectorFile {
  const { w } = sh;
  const { alice, aliceNew, bob } = w;
  const b = new FileBuilder('identity-move', 'identity-move.md', 'Identity move: the old master signs, the new master countersigns.');
  const m = issueIdentityMove(alice.id, aliceNew.id, { now: T0 });
  const t = serialize(m);
  const base = plain(m);
  const { signature: _s, to_signature: _ts, ...core } = base;
  const resign = (body: JsonObj) => {
    const to = signDoc('identity-move-to', body, aliceNew.id.master.secretKey);
    const toSig = (JSON.parse(to) as JsonObj)['signature'] as string;
    return signDoc('identity-move', { ...body, to_signature: toSig }, alice.id.master.secretKey);
  };
  const v = (name: string, d: string, text: string, want: string, options?: JsonObj) => b.add(name, d, 'verify_identity_move', options ? { text, options } : { text }, want);
  v('move-ok', 'Alice -> Alice-new.', t, 'ok', { expectedFrom: alice.id.owner });
  b.file.vectors[0]!.details = { to_signature_message: canonicalize(core), signature_message: canonicalize({ ...core, to_signature: base['to_signature'] }) };
  v('move-resigned', 'Written from the documented signed bytes.', resign(core), 'ok');
  v('move-expected-from', 'expectedFrom = Bob.', t, 'OWNER_MISMATCH', { expectedFrom: bob.id.owner });
  v('move-bad-to-signature', 'to_signature replaced by the old master\'s signature over the same bytes (no countersignature).', (() => {
    const fake = (JSON.parse(signDoc('identity-move-to', core, alice.id.master.secretKey)) as JsonObj)['signature'] as string;
    return signDoc('identity-move', { ...core, to_signature: fake }, alice.id.master.secretKey);
  })(), 'SIGNATURE');
  v('move-tampered-issued', 'issued changed after signing.', canonicalize({ ...base, issued: iso(new Date(T0.getTime() + 1000)) }), 'SIGNATURE');
  v('move-same-identity', 'from = to.', resign({ ...core, to: alice.id.owner }), 'FORMAT');
  v('move-bad-date', 'issued = 30 February.', resign({ ...core, issued: '2026-02-30T00:00:00.000Z' }), 'FORMAT');
  v('move-date-no-millis', 'issued without milliseconds is a valid date.', resign({ ...core, issued: '2026-10-20T12:00:00Z' }), 'ok');
  v('move-date-offset', 'issued with a +01:00 offset is refused (UTC "Z" only).', resign({ ...core, issued: '2026-10-20T13:00:00+01:00' }), 'FORMAT');
  v('move-version-2', 'Version 2.', resign({ ...core, version: 2 }), 'UNSUPPORTED_VERSION');
  v('move-unknown-field', 'Unknown field.', resign({ ...core, reason: 'stolen' }), 'FORMAT');
  return b.file;
}
