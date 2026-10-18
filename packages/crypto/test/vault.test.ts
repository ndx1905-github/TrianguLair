import { describe, expect, it } from 'vitest';
import {
  collectInvitationAnswers,
  contactRecord,
  createInvitation,
  createInvitationResponse,
  emptyVault,
  generateVaultDataKey,
  invitationFromRecord,
  invitationRecord,
  issueSharingCert,
  generateX25519KeyPair,
  mergeVaults,
  openSharingKey,
  openVault,
  sealSharingKey,
  sealVault,
  serialize,
  signIndex,
  verifyIndex,
  type VaultRecords,
} from '../src/index';
import { accept, invite, person, PAD_KEY } from './helpers';

const now = new Date('2026-10-18T12:00:00.000Z');

/** Marie's vault: one friend (Léa) with her last index, one open invitation with an answer. */
function setup() {
  const marie = person();
  const lea = person();
  const leaIndex = signIndex(lea.signer, { vaultDataKey: PAD_KEY, seq: 7, sharingCert: lea.cert, packs: [] });
  const { invitation, fragment, index } = invite(marie, { now });
  const answer = createInvitationResponse(accept(fragment, index, now), lea.signer, lea.cert, { now });
  const records: VaultRecords = {
    ...emptyVault(marie.id.owner),
    contacts: [contactRecord(leaIndex, true)],
    invitations: [invitationRecord(invitation, { answers: [answer], accepted: lea.id.owner })],
    retired_owners: [person().id.owner],
    app: { storage: { protocol: 'webdav', user: 'marie' }, groups: [{ name: 'friends' }] },
  };
  return { marie, lea, leaIndex, invitation, index, answer, records };
}

describe('recovery vault records (V3-10)', () => {
  it('round-trips through the vault data key; certificates and anchors are verified on the way back', () => {
    const { marie, lea, leaIndex, invitation, index, answer, records } = setup();
    const bytes = sealVault(records, marie.vaultDataKey);
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('TLVD');
    expect(bytes[4]).toBe(3);
    const back = openVault(bytes, marie.id.owner, marie.vaultDataKey);
    expect(back.contacts[0]!.owner).toBe(lea.id.owner);
    expect(back.contacts[0]!.verified).toBe(true);
    expect(back.contacts[0]!.sharing_cert).toEqual(lea.cert);
    expect(back.app).toEqual(records.app);
    // The anchor is a lastSeen: an older index of Léa is refused, the same one accepted.
    const anchor = back.contacts[0]!.anchor!;
    expect(() => verifyIndex(serialize(leaIndex), { expectedOwner: lea.id.owner, lastSeen: anchor })).not.toThrow();
    const older = signIndex(lea.signer, { vaultDataKey: PAD_KEY, seq: 6, sharingCert: lea.cert, packs: [] });
    expect(() => verifyIndex(serialize(older), { expectedOwner: lea.id.owner, lastSeen: anchor })).toThrow(expect.objectContaining({ code: 'ROLLBACK' }));
    // Another device restores the open invitation and its answers, and keeps collecting (R-04, V3-02).
    const rec = invitationFromRecord(back.invitations[0]!, marie.id.owner);
    expect(rec.invitation.keyPair.publicKey).toEqual(invitation.keyPair.publicKey);
    expect(rec.invitation.seed).toEqual(invitation.seed);
    expect(rec.invitation.rotation).toBe(invitation.rotation);
    expect(rec.invitation.device).toBe(marie.device.id);
    // ... and keeps it listed in the indexes it publishes until expiry (the link keeps working).
    const relisted = signIndex(marie.signer, { seq: 9, sharingCert: marie.cert, packs: [], invitations: [rec.invitation], vaultDataKey: marie.vaultDataKey, now });
    expect(relisted.invitations).toEqual(index.invitations);
    expect(rec.answers[0]).toEqual(answer);
    expect(collectInvitationAnswers(rec.invitation, rec.answers, { now, acceptedOwner: rec.accepted! }).accepted?.owner).toBe(lea.id.owner);
  });

  it('hides the number of records in a padded size, and refuses another key, another owner or tampering', () => {
    const { marie, records } = setup();
    const bytes = sealVault(records, marie.vaultDataKey);
    expect(sealVault(emptyVault(marie.id.owner), marie.vaultDataKey).length).toBe(5 + 24 + 256 + 16);
    expect(() => openVault(bytes, marie.id.owner, generateVaultDataKey())).toThrow(expect.objectContaining({ code: 'DECRYPT' }));
    expect(() => openVault(bytes, person().id.owner, marie.vaultDataKey)).toThrow(expect.objectContaining({ code: 'DECRYPT' }));
    const t = bytes.slice();
    t[10] = (t[10] as number) ^ 1;
    expect(() => openVault(t, marie.id.owner, marie.vaultDataKey)).toThrow(expect.objectContaining({ code: 'DECRYPT' }));
    const v = bytes.slice();
    v[4] = 1;
    expect(() => openVault(v, marie.id.owner, marie.vaultDataKey)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_VERSION' }));
    expect(() => sealVault(records, new Uint8Array(16))).toThrow(expect.objectContaining({ code: 'FORMAT' }));
  });

  it('validates what it seals: forged certificates, bad keys and records of another owner are refused', () => {
    const { marie, lea, records } = setup();
    const mallory = person();
    const forged = { ...records.contacts[0]!, sharing_cert: issueSharingCert(mallory.id, lea.sharing.publicKey, { rotation: 0 }) };
    expect(() => sealVault({ ...records, contacts: [forged] }, marie.vaultDataKey)).toThrow(expect.objectContaining({ code: 'OWNER_MISMATCH' }));
    expect(() => sealVault({ ...records, retired_owners: ['nope'] }, marie.vaultDataKey)).toThrow(expect.objectContaining({ code: 'FORMAT' }));
    const bad = { ...records.invitations[0]!, seed: 'AAAA' };
    expect(() => sealVault({ ...records, invitations: [bad] }, marie.vaultDataKey)).toThrow(expect.objectContaining({ code: 'FORMAT' }));
    // The id must match the seed; rotation is a u32; the device certificate and signature verify.
    const otherSeed = invitationRecord(createInvitation(marie.signer, marie.cert, { now }).invitation);
    expect(() => sealVault({ ...records, invitations: [{ ...records.invitations[0]!, seed: otherSeed.seed }] }, marie.vaultDataKey)).toThrow(expect.objectContaining({ code: 'FORMAT' }));
    expect(() => sealVault({ ...records, invitations: [{ ...records.invitations[0]!, rotation: -1 }] }, marie.vaultDataKey)).toThrow(expect.objectContaining({ code: 'FORMAT' }));
    const rec = records.invitations[0]!;
    expect(() => sealVault({ ...records, invitations: [{ ...rec, device_cert: { ...rec.device_cert, device: 'x' } }] }, marie.vaultDataKey)).toThrow(expect.objectContaining({ code: 'FORMAT' }));
    expect(() => sealVault({ ...records, invitations: [{ ...rec, created: new Date(Date.parse(rec.created) + 1000).toISOString() }] }, marie.vaultDataKey)).toThrow(expect.objectContaining({ code: 'SIGNATURE' }));
    expect(() => sealVault({ ...records, invitations: [{ ...rec, location: 'https://elsewhere.example/x' }] }, marie.vaultDataKey)).toThrow(expect.objectContaining({ code: 'SIGNATURE' }));
    const { signature: _sig, ...unsigned } = rec;
    expect(() => sealVault({ ...records, invitations: [unsigned as typeof rec] }, marie.vaultDataKey)).toThrow(expect.objectContaining({ code: 'FORMAT' }));
    expect(() => sealVault({ ...records, extra: 1 } as VaultRecords, marie.vaultDataKey)).toThrow(expect.objectContaining({ code: 'FORMAT' }));
    // A newer minor may add fields (kept, ignored).
    expect(() => sealVault({ ...records, minor: 1, extra: 1 } as VaultRecords, marie.vaultDataKey)).not.toThrow();
  });

  it('merges two concurrent versions: later anchors win, answers and retired owners are united', () => {
    const { marie, lea, records } = setup();
    const lea8 = signIndex(lea.signer, { vaultDataKey: PAD_KEY, seq: 8, sharingCert: lea.cert, packs: [] });
    const paul = person();
    const other: VaultRecords = {
      ...records,
      contacts: [contactRecord(lea8, false), contactRecord(signIndex(paul.signer, { vaultDataKey: PAD_KEY, seq: 1, sharingCert: paul.cert, packs: [] }))],
      invitations: [{ ...records.invitations[0]!, answers: ['AAAA'] }],
      retired_owners: [person().id.owner],
    };
    const m = mergeVaults(records, other);
    expect(m.contacts.map((c) => c.owner)).toEqual([lea.id.owner, paul.id.owner].sort());
    const leaRec = m.contacts.find((c) => c.owner === lea.id.owner)!;
    expect(leaRec.anchor!.seq).toBe(8);
    expect(leaRec.verified).toBe(true);
    expect(m.invitations[0]!.answers).toHaveLength(2);
    expect(m.retired_owners).toHaveLength(2);
    expect(openVault(sealVault(m, marie.vaultDataKey), marie.id.owner, marie.vaultDataKey).contacts).toHaveLength(2);
    expect(() => mergeVaults(records, emptyVault(paul.id.owner))).toThrow(expect.objectContaining({ code: 'OWNER_MISMATCH' }));
  });

  it('"Declare a device lost": a new vault data key reaches remaining devices and the phrase copy only', () => {
    const { marie, records } = setup();
    const k1 = generateX25519KeyPair();
    const cert1 = issueSharingCert(marie.id, k1.publicKey, { rotation: 1, location: marie.location, revokedDevices: [marie.device.id] });
    const fresh = { keyPair: k1, cert: cert1, vaultDataKey: generateVaultDataKey() };
    const vault = sealVault(records, fresh.vaultDataKey);
    // The stolen device holds only the old vault data key.
    expect(() => openVault(vault, marie.id.owner, marie.vaultDataKey)).toThrow(expect.objectContaining({ code: 'DECRYPT' }));
    expect(() => sealSharingKey(fresh, marie.deviceCert)).toThrow(expect.objectContaining({ code: 'REVOKED' }));
    const phraseCopy = sealSharingKey(fresh, marie.id);
    const restored = openSharingKey(phraseCopy, marie.id);
    expect(openVault(vault, marie.id.owner, restored.vaultDataKey).contacts).toHaveLength(1);
  });
});
