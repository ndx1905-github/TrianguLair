// SPDX-License-Identifier: MPL-2.0
/**
 * My devices in the vault, the declaration of loss (`rotateKey`), key delivery to devices added
 * since the last rotation, app values, and following a friend's identity move (T-206, T-207).
 */
import {
  createInvitation,
  devicePublicKeys,
  emptyVault,
  generateDeviceKeys,
  generateRecoveryPhrase,
  generateVaultDataKey,
  generateX25519KeyPair,
  identityFromPhrase,
  issueDeviceCert,
  issueIdentityMove,
  issueSharingCert,
  openSharingKey,
  sealSharingKey,
  type SharingKey,
} from '@triangulair/crypto';
import { DataStore } from '@triangulair/data';
import { NodeSqliteDriver } from '@triangulair/data/node';
import { describe, expect, it } from 'vitest';
import { ContactBook, mergeBooks } from '../src/contacts.ts';
import { MAX_DEVICE_NAME, cleanName, devicesOf } from '../src/devices.ts';
import { SyncEngine } from '../src/engine.ts';
import { keyPath } from '../src/own.ts';
import { MemoryStateStore } from '../src/state.ts';
import { addDevice, befriend, friendSaves, indexOf, makeUser, point, World } from './helpers.ts';

function newKey(user: ReturnType<typeof makeUser>, rotation: number, revokedDevices: string[] = []): SharingKey {
  const kp = generateX25519KeyPair();
  return { keyPair: kp, cert: issueSharingCert(user.identity, kp.publicKey, { rotation, location: user.location, revokedDevices }), vaultDataKey: generateVaultDataKey() };
}

describe('device list in the vault', () => {
  it('keeps master-signed devices only, merges renames, removal is sticky', () => {
    const w = new World();
    const user = makeUser(w, 'alice');
    const other = makeUser(w, 'mallory');
    const k1 = generateDeviceKeys();
    const k2 = generateDeviceKeys();
    const c1 = issueDeviceCert(user.identity, devicePublicKeys(k1));
    const c2 = issueDeviceCert(user.identity, devicePublicKeys(k2));
    const foreign = issueDeviceCert(other.identity, devicePublicKeys(generateDeviceKeys()));
    const a = ContactBook.empty(user.owner);
    a.putDevice(c1, { name: 'Phone', added: 1000, primary: true }, 1000);
    expect(() => a.putDevice(foreign, { name: 'Not mine' }, 1001)).toThrow();
    const b = new ContactBook(a.records);
    a.updateDevice(c1.device, { name: 'Anna’s phone' }, 2000);
    b.putDevice(c2, { name: 'Tablet', added: 1500 }, 1500);
    b.markDevicesRemoved([c2.device], 3000);
    const m = new ContactBook(mergeBooks(a.records, b.records));
    expect(m.devices().map((d) => [d.name, d.removed ?? null, d.primary ?? false])).toEqual([
      ['Anna’s phone', null, true],
      ['Tablet', 3000, false],
    ]);
    // A removal survives a later rename from a copy that had not seen it.
    const c = new ContactBook(a.records);
    c.putDevice(c2, { name: 'Tablet renamed' }, 4000);
    const m2 = new ContactBook(mergeBooks(c.records, m.records));
    expect(m2.devices().find((d) => d.cert.device === c2.device)!.removed).toBe(3000);
    // An entry planted with a foreign (or forged) certificate is ignored.
    const planted = { ...m.records, app: { ...m.records.app, triangulair_devices: { version: 1, devices: { ...(m.records.app!['triangulair_devices'] as { devices: object }).devices, [foreign.device]: { cert: foreign, name: 'x', added: 1, at: 1 } } } } };
    expect(devicesOf(planted as never).map((d) => d.cert.device)).not.toContain(foreign.device);
  });

  it('cleans names and merges app values per key', () => {
    expect(cleanName('  a‮ b\n c ')).toBe('a b c');
    expect([...cleanName('x'.repeat(200))].length).toBe(MAX_DEVICE_NAME);
    const a = ContactBook.empty('ed25519:' + 'A'.repeat(43));
    const b = new ContactBook(emptyVault(a.records.owner));
    a.setValue('storage', { url: 'one' }, 10);
    b.setValue('storage', { url: 'two' }, 20);
    b.setValue('profile', { name: 'Anna' }, 5);
    const m = new ContactBook(mergeBooks(a.records, b.records));
    expect(m.value('storage')!.value).toEqual({ url: 'two' });
    expect(m.value('profile')!.value).toEqual({ name: 'Anna' });
  });
});

describe('declare a device lost (rotateKey)', () => {
  it('revokes it, cancels every open invitation, delivers the new key, wipes the lost device, friends follow', async () => {
    const w = new World();
    const user = makeUser(w, 'alice');
    const a = addDevice(w, user);
    const b = addDevice(w, user);
    const lost = addDevice(w, user);
    const bob = addDevice(w, makeUser(w, 'bob'));
    for (const d of [a, b, lost]) a.engine.putDevice(d.signer.cert, { name: d === a ? 'Phone' : d === b ? 'Tablet' : 'Old phone' });
    a.store.putSave({ place: point(1, 'P1') });
    await a.engine.sync();
    await b.engine.sync();
    await lost.engine.sync();
    await bob.engine.sync();
    expect(b.engine.devices()).toHaveLength(3);
    await befriend(w, a, bob);
    // An invitation made on the device about to be stolen.
    const { invitation } = createInvitation(lost.signer, user.sharing.cert);
    lost.engine.addInvitation(invitation);
    await lost.engine.sync();
    await a.engine.sync();
    expect(a.engine.book.invitations()).toHaveLength(1);
    await bob.engine.sync();
    expect(friendSaves(bob, user.owner).size).toBe(1);
    // Every listed device got the current key (the same one it already had).
    expect(await user.storage.get(keyPath(lost.signer.keys.id))).not.toBeNull();

    // Declared lost from a (primary): new key and vault data key, rotation 1, lost revoked.
    const next = newKey(user, 1, [lost.signer.keys.id]);
    const recovery = sealSharingKey(next, user.identity);
    const res = await a.engine.rotateKey(next, { cancelInvitations: true, recoveryCopy: recovery });
    expect(res.cancelled.map((c) => c.id)).toEqual([invitation.id]);
    expect(res.delivered).toEqual([b.signer.keys.id]);
    expect(a.engine.book.invitations()).toEqual([]);
    expect(await user.storage.get(keyPath(lost.signer.keys.id))).toBeNull();
    expect(a.engine.devices().find((d) => d.cert.device === lost.signer.keys.id)!.removed).toBeDefined();
    const r = await a.engine.sync();
    expect(r.ok).toBe(true);
    expect(r.own!.published).toBe(true);
    // Published index: new certificate, no invitation listed.
    expect(a.engine.own!.index!.sharing_cert.rotation).toBe(1);
    expect(a.engine.own!.index!.revoked_devices).toEqual([lost.signer.keys.id]);
    // The recovery copy opens with the phrase identity only.
    const copy = await user.storage.get(keyPath(user.owner));
    expect(openSharingKey(copy!.data, user.identity, { expectedOwner: user.owner }).cert.rotation).toBe(1);

    // b picks the key up; the lost device erases itself at its next sync.
    const rb = await b.engine.sync();
    expect(rb.ok).toBe(true);
    expect(b.engine.own!.sharing.cert.rotation).toBe(1);
    const rl = await lost.engine.sync();
    expect(rl.wiped).toBe(true);
    expect(lost.engine.isWiped).toBe(true);
    expect(() => lost.store.repo.db.all(`SELECT id FROM saves`)).toThrow(); // erased and closed

    // Bob keeps reading Alice with the new key and is told.
    a.store.updateSave('osm:node/1', { comment: 'after the declaration' });
    await a.engine.sync();
    const rbob = await bob.engine.sync();
    expect(rbob.friends[0]!.keyChanged).toBe(true);
    expect(friendSaves(bob, user.owner).get('osm:node/1')!.comment).toBe('after the declaration');
  });

  it('refuses an older rotation or another identity', async () => {
    const w = new World();
    const user = makeUser(w, 'alice');
    const a = addDevice(w, user);
    await a.engine.sync();
    await expect(a.engine.rotateKey(newKey(user, 0))).rejects.toThrow(/newer/);
    const other = makeUser(w, 'eve');
    await expect(a.engine.rotateKey(newKey(other, 5))).rejects.toThrow(/identity/);
  });

  it('a device added after the rotation gets the current key at the next publication', async () => {
    const w = new World();
    const user = makeUser(w, 'alice');
    const a = addDevice(w, user);
    await a.engine.sync();
    await a.engine.rotateKey(newKey(user, 1));
    await a.engine.sync();
    // A new device, certified by the master, listed in the vault by a.
    const keys = generateDeviceKeys();
    const cert = issueDeviceCert(user.identity, devicePublicKeys(keys));
    a.engine.putDevice(cert, { name: 'New tablet' });
    a.store.putSave({ place: point(2, 'P2') });
    await a.engine.sync();
    const g = await user.storage.get(keyPath(cert.device));
    expect(openSharingKey(g!.data, keys, { expectedOwner: user.owner }).cert.rotation).toBe(1);
    // Not written again when nothing changed.
    await user.storage.delete(keyPath(cert.device));
    a.store.putSave({ place: point(3, 'P3') });
    await a.engine.sync();
    expect(await user.storage.get(keyPath(cert.device))).toBeNull();
  });
});

describe('a friend changes identity (theft of their primary device)', () => {
  it('is followed to the new identity at the same certified address, not verified any more', async () => {
    const w = new World();
    const user = makeUser(w, 'alice');
    const a = addDevice(w, user);
    const bob = addDevice(w, makeUser(w, 'bob'));
    a.store.putSave({ place: point(1, 'Before') });
    await a.engine.sync();
    await bob.engine.sync();
    await befriend(w, a, bob);
    bob.engine.book.records = { ...bob.engine.book.records, contacts: bob.engine.book.records.contacts.map((c) => ({ ...c, verified: true })) };
    await a.engine.sync();
    await bob.engine.sync();
    expect(friendSaves(bob, user.owner).size).toBe(1);

    // Alice: new identity, move signed by both masters, the same storage and read address.
    const id2 = identityFromPhrase(generateRecoveryPhrase());
    const move = issueIdentityMove(user.identity, id2);
    const kp = generateX25519KeyPair();
    const sharing: SharingKey = { keyPair: kp, cert: issueSharingCert(id2, kp.publicKey, { rotation: 0, location: user.location }), vaultDataKey: generateVaultDataKey() };
    const keys = generateDeviceKeys();
    const driver = new NodeSqliteDriver(':memory:');
    const store = DataStore.open({ driver, meId: id2.owner, actor: 'actor-moved' });
    store.putSave({ place: point(1, 'Before') });
    store.putSave({ place: point(2, 'After the move') });
    await user.storage.delete('index.json');
    const moved = new SyncEngine({
      store, state: new MemoryStateStore(), sharing, move, storage: user.storage, readAdapter: w.readAdapter, fullCheckMs: 0,
      device: { keys, cert: issueDeviceCert(id2, devicePublicKeys(keys)) },
    });
    moved.addContact(await indexOf(w, bob.user), { share: true, follow: false });
    const rm = await moved.sync();
    expect(rm.ok).toBe(true);
    expect(moved.own!.index!.move!.from).toBe(user.owner);

    const r = await bob.engine.sync();
    const fromReport = r.friends.find((f) => f.owner === user.owner)!;
    expect(fromReport.identityMove).toMatchObject({ from: user.owner, to: id2.owner, followed: true });
    expect(r.problems).toEqual([]);
    const contacts = bob.engine.contacts();
    expect(contacts.map((c) => c.owner)).toEqual([id2.owner]);
    expect(contacts[0]!.verified).toBe(false);
    expect(contacts[0]!.policy.follow).toBe(true);
    expect(bob.engine.book.retiredOwners()).toEqual([user.owner]);
    expect(friendSaves(bob, user.owner).size).toBe(0);
    expect(friendSaves(bob, id2.owner).size).toBe(2);
    // The next pass reads the new identity normally.
    const r2 = await bob.engine.sync();
    expect(r2.ok).toBe(true);
  });
});
