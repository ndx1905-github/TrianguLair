// SPDX-License-Identifier: MPL-2.0
/**
 * Review of PR #86 (T-206 / T-207), docs/reviews/2026-11-16-devices-review.md. Each `it.fails`
 * states the DESIRED behaviour and fails today; it starts passing (and must then become `it`)
 * once the finding is fixed.
 *
 * The attacker here is a device of mine that was stolen and is not declared yet: it holds the
 * sharing key, the vault data key and the storage credentials, and runs a modified client (spec
 * "Recovery kit": "a stolen device can write anything into the vault until the declaration, and
 * what it wrote is carried over when the vault is saved with the new key").
 */
import {
  generateVaultDataKey,
  generateX25519KeyPair,
  issueSharingCert,
  sealSharingKey,
  type SharingKey,
  type VaultRecords,
} from '@triangulair/crypto';
import { describe, expect, it } from 'vitest';
import { ContactBook, mergeBooks } from '../src/contacts.ts';
import { DEVICES_KEY } from '../src/devices.ts';
import { keyPath } from '../src/own.ts';
import { addDevice, makeUser, World } from './helpers.ts';

function newKey(user: ReturnType<typeof makeUser>, rotation: number, revokedDevices: string[] = []): SharingKey {
  const kp = generateX25519KeyPair();
  return { keyPair: kp, cert: issueSharingCert(user.identity, kp.publicKey, { rotation, location: user.location, revokedDevices }), vaultDataKey: generateVaultDataKey() };
}

/** The thief edits the devices part of its copy of the vault (a modified client). */
function tamperDevices(r: VaultRecords, edit: (devices: Record<string, Record<string, unknown>>) => void): VaultRecords {
  const part = JSON.parse(JSON.stringify(r.app?.[DEVICES_KEY] ?? { version: 1, devices: {} })) as { devices: Record<string, Record<string, unknown>> };
  edit(part.devices);
  return { ...r, app: { ...(r.app ?? {}), [DEVICES_KEY]: part } } as VaultRecords;
}

describe('review F-02: the device list in the vault is writable by a stolen device', () => {
  it('a stolen device cannot mark itself removed, so it stays selectable in "Declare a device lost"', async () => {
    const w = new World();
    const user = makeUser(w, 'alice');
    const a = addDevice(w, user);
    const thief = addDevice(w, user);
    a.engine.putDevice(a.signer.cert, { name: 'Phone' });
    a.engine.putDevice(thief.signer.cert, { name: 'Tablet' });
    await a.engine.sync();
    await thief.engine.sync();
    // Stolen, not declared yet: it marks its own entry removed (sticky: the earliest removal wins).
    thief.engine.book.markDevicesRemoved([thief.signer.keys.id], 1);
    thief.engine.updateDevice(thief.signer.keys.id, { name: 'Tablet' }); // any change: the vault is pushed
    await thief.engine.sync();
    await a.engine.sync();
    // app/devices/lost.tsx offers only `removed === undefined` devices: the thief would not be listed.
    // Desired: "removed" follows the master-signed revocation only (sharing certificate), never a vault mark.
    const entry = a.engine.devices().find((d) => d.cert.device === thief.signer.keys.id)!;
    expect(entry.removed).toBeUndefined();
  });

  it('a stolen device cannot hide another device of mine from the next key delivery', async () => {
    const w = new World();
    const user = makeUser(w, 'alice');
    const a = addDevice(w, user);
    const b = addDevice(w, user);
    const thief = addDevice(w, user);
    for (const d of [a, b, thief]) a.engine.putDevice(d.signer.cert, { name: d === a ? 'Phone' : d === b ? 'Tablet' : 'Old phone' });
    await a.engine.sync();
    await b.engine.sync();
    await thief.engine.sync();
    // The thief replaces b's entry by one with a broken certificate and a far-future change time:
    // it wins every merge (`later` by `at`) and `devicesOf` then drops b altogether.
    thief.engine.book.records = tamperDevices(thief.engine.book.records, (devices) => {
      devices[b.signer.keys.id] = { cert: { broken: true }, info: {}, name: 'x', added: 1, at: Number.MAX_SAFE_INTEGER };
    });
    thief.engine.updateDevice(thief.signer.keys.id, { name: 'Old phone' });
    await thief.engine.sync();
    await a.engine.sync();
    // a declares the thief lost: the new key must reach b.
    const res = await a.engine.rotateKey(newKey(user, 1, [thief.signer.keys.id]), { cancelInvitations: true, recoveryCopy: sealSharingKey(newKey(user, 1), user.identity) });
    expect(res.delivered).toContain(b.signer.keys.id);
    expect(await user.storage.get(keyPath(b.signer.keys.id))).not.toBeNull();
  });
});

describe('review F-01: app values (storage settings) in the vault', () => {
  it('a value planted with a far-future time does not beat a later legitimate change', () => {
    const w = new World();
    const user = makeUser(w, 'alice');
    const a = addDevice(w, user);
    const thief = addDevice(w, user);
    const honest = ContactBook.empty(user.owner);
    honest.putDeviceCert(a.signer.cert);
    honest.putDeviceCert(thief.signer.cert);
    const signer = (d: typeof a) => ({ id: d.signer.keys.id, secretKey: d.signer.keys.sign.secretKey });
    honest.setValue('storage', { url: 'https://dav.example/me/', password: 'old' }, signer(a), 1000);
    // The stolen device's copy: same read address, its own write endpoint, time = 2^53 - 1, and
    // validly signed with its own (still certified) device key.
    const thiefBook = new ContactBook(honest.records);
    thiefBook.setValue('storage', { url: 'https://evil.example/dav/', password: 'x' }, signer(thief), Number.MAX_SAFE_INTEGER);
    // An unsigned copy of the old format, stamped likewise.
    const planted = { ...(thiefBook.records.app!['triangulair_values'] as { values: Record<string, unknown> }) };
    thiefBook.records = {
      ...thiefBook.records,
      app: { ...thiefBook.records.app, triangulair_values: { version: 2, values: { ...planted.values, profile: { [thief.signer.keys.id]: { value: { name: 'x' }, at: Number.MAX_SAFE_INTEGER, sig: 'AAAA' } } } } },
    } as VaultRecords;
    // The honest device merges it (before the declaration), then the user changes the password
    // as the declaration guide says.
    const merged = new ContactBook(mergeBooks(honest.records, thiefBook.records));
    expect(merged.value('storage')?.value).toEqual({ url: 'https://dav.example/me/', password: 'old' });
    expect(merged.value('profile')).toBeUndefined();
    merged.setValue('storage', { url: 'https://dav.example/me/', password: 'new' }, signer(a), 5000);
    const again = new ContactBook(mergeBooks(merged.records, thiefBook.records));
    expect(again.value('storage')?.value).toEqual({ url: 'https://dav.example/me/', password: 'new' });
  });

  it('after the declaration, nothing the lost device signed is taken, and values are the declaring device\'s', async () => {
    const w = new World();
    const user = makeUser(w, 'alice');
    const a = addDevice(w, user);
    const thief = addDevice(w, user);
    a.engine.putDevice(a.signer.cert, { name: 'Phone' });
    a.engine.setValue('storage', { url: 'https://dav.example/me/', password: 'old' });
    await a.engine.sync();
    await thief.engine.sync();
    // Within the allowed clock skew, newer than a's: it wins until the declaration.
    thief.engine.setValue('storage', { url: 'https://evil.example/dav/', password: 'x' });
    await thief.engine.sync();
    await a.engine.sync();
    expect(a.engine.value<{ url: string }>('storage')!.value.url).toBe('https://evil.example/dav/');
    await a.engine.rotateKey(newKey(user, 1, [thief.signer.keys.id]), { cancelInvitations: true, values: { storage: { url: 'https://dav.example/me/', password: 'new' } } });
    expect(a.engine.value<{ url: string }>('storage')!.value).toEqual({ url: 'https://dav.example/me/', password: 'new' });
    await a.engine.sync();
    // Even a copy that still holds the thief's entry (merged by a device that had not seen the
    // declaration) does not bring it back: its signer is revoked.
    const stale = new ContactBook(mergeBooks(a.engine.book.records, thief.engine.book.records, { revoked: [thief.signer.keys.id] }));
    expect(stale.value<{ url: string }>('storage', { revoked: [thief.signer.keys.id] })!.value.url).toBe('https://dav.example/me/');
  });
});
