/**
 * Review of PR #86 (T-206 / T-207), docs/reviews/2026-11-16-devices-review.md. Each `it.fails`
 * states the DESIRED behaviour and fails today; once a finding is fixed its test passes and must
 * become a plain `it`. In-memory storages, real SQLite (sql.js), real crypto.
 */
import { describe, expect, it } from 'vitest';
import initSqlJs from 'sql.js';
import {
  decodeKeyExport,
  devicePublicKeys,
  generateDeviceKeys,
  decryptTransfer,
  issueDeviceCert,
  openVault,
  ready,
  sealVault,
  toB64Url,
  type VaultRecords,
} from '@triangulair/crypto';
import { DataStore } from '@triangulair/data';
import { MemoryAdapter, ReadOnly, StorageError, type StorageAdapter } from '@triangulair/storage';
import { ContactBook, SqliteStateStore, VAULT_PATH, keyPath } from '@triangulair/sync';

import { SqlJsDriver } from '../data/sqljsDriver';
import { createIdentity, type IdentityRecord } from '../identity/create';
import { staleSyncAction } from '../identity/lock';
import { masterIdentity, rotateStoredSharingKey } from '../storage/certify';
import type { StorageConfig } from '../storage/config';
import type { StorageAccess } from '../storage/interfaces';
import { encodeRecoveryCopy, recoveryCopyFor, sealRecoveryCopy } from '../identity/recovery';
import { SyncController } from '../sync/controller';
import { openSyncKeys, sealForThisDevice, serializeSyncKeys } from '../sync/keys';
import { decodeInvite, deviceFingerprint, encodeRequestLink, sealRequest } from './channel';
import { LinkSender, QrReceiver, QrSender, lastDigits, restoreWithPhrase } from './sessions';

await ready();
const SQL = await initSqlJs();

const world = new Map<string, StorageAdapter>();
function readOnly(a: StorageAdapter): StorageAdapter {
  return {
    capabilities: { ...a.capabilities, readOnly: true },
    get: (p, o) => a.get(p, o),
    head: (p) => a.head(p),
    put: async (p) => {
      throw new ReadOnly(p);
    },
    delete: async (p) => {
      throw new ReadOnly(p);
    },
    list: (p) => a.list(p),
  };
}
const readAdapter = (loc: string) => {
  const a = world.get(loc);
  if (!a) throw new StorageError('NETWORK', `no server at ${loc}`);
  return readOnly(a);
};

function cfg(location: string): StorageConfig {
  return { kind: 'webdav', flavor: 'generic', url: `${location}dav/`, username: 'u', password: 'p', readUrl: location, conditionalWrites: true };
}

let ids = 0;
interface Dev {
  record: IdentityRecord;
  deviceKeys: string;
  sharingKey: string;
  syncKeys: string | null;
  primaryIdentity: string | null;
  recoveryCopy: string | null;
  store: DataStore;
  ctl: SyncController;
  adopted: unknown[];
}

function person(name: string, opts: { recoveryCopy?: boolean } = {}) {
  const created = createIdentity({ primary: true });
  const location = `https://${name}-${++ids}.example/tl/`;
  const rot = rotateStoredSharingKey(created.record, created.secrets, { location }, { kind: 'primary' });
  const storage = new MemoryAdapter();
  world.set(location, storage);
  const driver = new SqlJsDriver(new SQL.Database());
  const store = DataStore.open({ driver, meId: created.record.owner, actor: (++ids).toString(16).padStart(32, '0'), newId: () => `id${++ids}` });
  const d = {
    record: created.record,
    deviceKeys: created.secrets.deviceKeys,
    sharingKey: rot.sealedForThisDevice,
    syncKeys: null,
    primaryIdentity: created.secrets.primaryIdentity,
    recoveryCopy: opts.recoveryCopy === false ? null : encodeRecoveryCopy(rot.vaultCopy, rot.cert),
    store,
    adopted: [] as unknown[],
  } as unknown as Dev;
  const config = cfg(location);
  const access: StorageAccess = {
    config: () => config,
    writeAdapter: () => storage,
    readAdapter: () => readOnly(storage),
    readAddress: () => location,
    redirects: () => [],
    republishPending: () => false,
    markRepublished: async () => {},
  };
  d.ctl = new SyncController({
    store,
    state: new SqliteStateStore(driver),
    loadKeys: async () => openSyncKeys(d.record, { deviceKeys: d.deviceKeys, sharingKey: d.sharingKey, syncKeys: d.syncKeys }),
    saveKeys: async (k) => {
      d.syncKeys = serializeSyncKeys(k);
      d.sharingKey = sealForThisDevice(k.sharing, d.record);
    },
    access,
    readAdapter,
    wipe: { secrets: async () => {}, data: async () => store.wipe() },
    onData: () => {},
    onChange: () => {},
    author: () => name,
    device: () => ({ name, added: d.record.createdAt, primary: !!d.primaryIdentity }),
    recoveryCopy: async (sharing) => {
      const r = recoveryCopyFor(sharing, { stored: d.recoveryCopy, primaryIdentity: d.primaryIdentity });
      if (r?.store) d.recoveryCopy = r.store;
      return r?.copy ?? null;
    },
    onStorageValue: async (v) => void d.adopted.push(v),
  });
  return { created, location, storage, d, config };
}

const sharingOf = async (d: Dev) => (await openSyncKeys(d.record, { deviceKeys: d.deviceKeys, sharingKey: d.sharingKey, syncKeys: null })).sharing;

describe('review F-01: storage settings in the vault are adopted from any writer', () => {
  it('a device never switches to a write endpoint that a vault value (writable by a stolen device) names', async () => {
    const anna = person('anna');
    anna.d.store.putSave({ place: { osm: { type: 'node', id: 1 }, name: 'P', category: 'amenity=cafe', geometry: { type: 'Point', coordinates: [2.35, 48.85] } } });
    await anna.d.ctl.refresh();
    // A stolen, not yet declared device of Anna's (it holds the vault data key and the storage
    // credentials): it rewrites the vault with its own write endpoint for the same read address,
    // stamped far in the future so that it wins every merge, now and after the declaration.
    const vdk = (await sharingOf(anna.d)).vaultDataKey;
    const g = await anna.storage.get(VAULT_PATH);
    const r = openVault(g!.data, anna.d.record.owner, vdk);
    const values = (r.app?.['triangulair_values'] as { values: Record<string, unknown> }).values;
    const evil: StorageConfig = { ...anna.config, url: 'https://evil.example/proxy/', password: 'thief' } as StorageConfig;
    const planted = { ...r, app: { ...r.app, triangulair_values: { version: 2, values: { ...values, storage: { 'ed25519:x': { value: evil, at: Number.MAX_SAFE_INTEGER, sig: 'AAAA' } } } } } } as VaultRecords;
    await anna.storage.put(VAULT_PATH, sealVault(new ContactBook(planted).records, vdk));
    await anna.d.ctl.refresh();
    expect(anna.d.adopted.map((c) => (c as { url: string }).url)).not.toContain('https://evil.example/proxy/');

    // The same, validly signed by the stolen device (still certified) within the clock skew.
    const thiefKeys = generateDeviceKeys();
    const master = masterIdentity(anna.d.record, { deviceKeys: anna.d.deviceKeys, sharingKey: anna.d.sharingKey, primaryIdentity: anna.d.primaryIdentity }, { kind: 'primary' });
    const thief = { id: thiefKeys.id, secretKey: thiefKeys.sign.secretKey };
    const plant = async (value: StorageConfig) => {
      const cur = openVault((await anna.storage.get(VAULT_PATH))!.data, anna.d.record.owner, vdk);
      const book = new ContactBook(cur);
      book.putDeviceCert(issueDeviceCert(master, devicePublicKeys(thiefKeys)));
      book.setValue('storage', value, thief, Date.now() + 60_000);
      await anna.storage.put(VAULT_PATH, sealVault(book.records, vdk));
    };
    await plant(evil);
    await anna.d.ctl.refresh();
    expect(anna.d.adopted.map((c) => (c as { url: string }).url)).not.toContain('https://evil.example/proxy/');
    // New credentials for the same storage, from a certified device, are taken (a password changed elsewhere).
    await plant({ ...anna.config, password: 'changed' } as StorageConfig);
    await anna.d.ctl.refresh();
    expect(anna.d.adopted).toEqual([{ ...anna.config, password: 'changed' }]);
  });
});

describe('review F-03: link + code releases every secret before the comparison', () => {
  it('whoever holds the link and the 6 words gets no vault data key or storage credentials before the old device approves', async () => {
    const anna = person('anna');
    await anna.d.ctl.refresh();
    const sender = new LinkSender({
      storage: anna.storage,
      location: anna.location,
      sharing: () => sharingOf(anna.d),
      certify: async (pub, master) => issueDeviceCert(masterIdentity(anna.d.record, { deviceKeys: anna.d.deviceKeys, sharingKey: anna.d.sharingKey, primaryIdentity: anna.d.primaryIdentity }, master), pub),
      register: async () => {},
    });
    await sender.start();
    const s = sender.state;
    if (s.phase !== 'waiting') throw new Error(s.phase);
    // An interceptor of the mail and the message: no request written, nothing approved.
    const files = await anna.storage.list('transfer/');
    const blobPath = files.map((f) => (typeof f === 'string' ? f : (f as { path: string }).path)).find((p) => p.endsWith('.bin'))!;
    const blob = (await readOnly(anna.storage).get(blobPath))!.data;
    const plain = decryptTransfer(blob, s.code);
    // The blob only opens a channel: no key export, and its channel key does not open the vault.
    expect(() => decodeKeyExport(plain)).toThrow();
    const invite = decodeInvite(plain);
    const vault = (await anna.storage.get(VAULT_PATH))!.data;
    expect(() => openVault(vault, anna.d.record.owner, invite.key)).toThrow();
    // The interceptor answers with its own request: the number differs from the real new
    // device's, so the user refuses; nothing is certified or written, a key change is offered.
    const rogue = generateDeviceKeys();
    const pub = devicePublicKeys(rogue);
    sender.received(encodeRequestLink(invite.slot, sealRequest({ device: pub.device, box: pub.box, name: 'tablet' }, invite.key, invite.slot)));
    expect(sender.state.phase).toBe('request');
    await sender.approve({ kind: 'primary' }, '0000' === lastDigits(deviceFingerprint(rogue.id)) ? '0001' : '0000');
    expect(sender.state).toMatchObject({ phase: 'request', error: 'digits' });
    await sender.refuse();
    expect(sender.state).toMatchObject({ phase: 'refused', device: { device: rogue.id } });
    expect(await anna.storage.list('transfer/')).toEqual([]);
  });
});

describe('review F-04: QR "cancel" after approval', () => {
  it('cancelling the QR transfer after approval does not leave a certified, listed device behind', async () => {
    const anna = person('anna');
    await anna.d.ctl.refresh();
    const registered: string[] = [];
    const sender = new QrSender({
      storage: anna.storage,
      location: anna.location,
      sharing: () => sharingOf(anna.d),
      certify: async (pub, master) => issueDeviceCert(masterIdentity(anna.d.record, { deviceKeys: anna.d.deviceKeys, sharingKey: anna.d.sharingKey, primaryIdentity: anna.d.primaryIdentity }, master), pub),
      register: async (cert) => {
        registered.push(cert.device);
        await anna.d.ctl.addDevice(cert, 'tablet?');
      },
    });
    const receiver = new QrReceiver({ readAdapter, writeAdapter: () => anna.storage }, 'tablet');
    const offer = receiver.state.phase === 'showing' ? receiver.state.offer : '';
    sender.scanned(offer);
    await sender.approve({ kind: 'primary' }, lastDigits(receiver.state.phase === 'showing' ? receiver.state.fingerprint : ''));
    expect(sender.state.phase).toBe('showing');
    // The user changes their mind (wrong device, the code was pasted from a message…).
    await sender.cancel();
    expect(sender.state.phase).toBe('cancelled');
    // Nothing was listed: the device is registered only once it fetched its package, so no
    // publication seals the sharing key to it at keys/<device>.bin.
    await anna.d.ctl.refresh();
    const id = receiver.deviceKeys.id;
    expect(anna.d.ctl.devices().filter((x) => x.removed === undefined).map((x) => x.cert.device)).not.toContain(id);
    expect(await anna.storage.get(keyPath(id))).toBeNull();
  });
});

describe('review F-05: restore with the 12 words', () => {
  it('a restore refuses a phrase copy of the sharing key older than the certificate my index publishes (rolled back keys/<owner>.bin)', async () => {
    const anna = person('anna');
    await anna.d.ctl.refresh();
    const old = (await anna.storage.get(keyPath(anna.d.record.owner)))!.data;
    // A key change (remove a device / declaration): keys/<owner>.bin follows the new key.
    const rot = rotateStoredSharingKey(anna.d.record, { deviceKeys: anna.d.deviceKeys, sharingKey: anna.d.sharingKey, primaryIdentity: anna.d.primaryIdentity }, { newKey: true }, { kind: 'primary' });
    anna.d.sharingKey = rot.sealedForThisDevice;
    anna.d.recoveryCopy = encodeRecoveryCopy(rot.vaultCopy, rot.cert);
    await anna.d.ctl.declareLost(rot, { cancelInvitations: true });
    // The host (or a stolen device whose storage access was not changed yet) puts the old copy back.
    await anna.storage.put(keyPath(anna.d.record.owner), old);
    let rotation: number | null;
    try {
      rotation = (await restoreWithPhrase(anna.created.phrase, anna.location, { readAdapter, writeAdapter: () => anna.storage })).sharing.cert.rotation;
    } catch {
      rotation = null; // refused: fine
    }
    expect(rotation === null || rotation === rot.cert.rotation).toBe(true);
    await expect(restoreWithPhrase(anna.created.phrase, anna.location, { readAdapter, writeAdapter: () => anna.storage })).rejects.toMatchObject({ code: 'stale' });
    // The current copy restores (rotation 2).
    await anna.storage.put(keyPath(anna.d.record.owner), rot.vaultCopy);
    const j = await restoreWithPhrase(anna.created.phrase, anna.location, { readAdapter, writeAdapter: () => anna.storage });
    expect(j.sharing.cert.rotation).toBe(rot.cert.rotation);
    expect(j.storage).toEqual(anna.config);
  });

  it('an identity without a stored recovery copy (created before this version) still gets keys/<owner>.bin from its primary device', async () => {
    const anna = person('anna', { recoveryCopy: false });
    await anna.d.ctl.refresh();
    // Without it, "restore with the 12 words" answers "not found" (sessions.ts restoreWithPhrase).
    expect(await anna.storage.get(keyPath(anna.d.record.owner))).not.toBeNull();
    expect(anna.d.ctl.snapshot().recoveryCopyMissing).toBe(false);
    const j = await restoreWithPhrase(anna.created.phrase, anna.location, { readAdapter, writeAdapter: () => anna.storage });
    expect(j.sharing.cert.key).toBe((await sharingOf(anna.d)).cert.key);
  });

  it('a device that cannot make the copy (no master key) says so, and never uploads a copy of an older key', async () => {
    const anna = person('anna', { recoveryCopy: false });
    anna.d.primaryIdentity = null;
    await anna.d.ctl.refresh();
    expect(await anna.storage.get(keyPath(anna.d.record.owner))).toBeNull();
    expect(anna.d.ctl.snapshot().recoveryCopyMissing).toBe(true);
    // A copy made for another certificate (an older key) is not used.
    const other = rotateStoredSharingKey(anna.d.record, { deviceKeys: anna.d.deviceKeys, sharingKey: anna.d.sharingKey, primaryIdentity: anna.created.secrets.primaryIdentity }, { newKey: true }, { kind: 'primary' });
    anna.d.recoveryCopy = encodeRecoveryCopy(other.vaultCopy, other.cert);
    anna.d.store.putSave({ place: { osm: { type: 'node', id: 9 }, name: 'Q', category: 'amenity=cafe', geometry: { type: 'Point', coordinates: [2.35, 48.85] } } });
    await anna.d.ctl.refresh();
    expect(await anna.storage.get(keyPath(anna.d.record.owner))).toBeNull();
    // The 12 words once (IdentityApi.writeRecoveryCopy): sealed for the current key, uploaded.
    const id = masterIdentity(anna.d.record, { deviceKeys: anna.d.deviceKeys, sharingKey: anna.d.sharingKey, primaryIdentity: null }, { kind: 'phrase', phrase: anna.created.phrase });
    anna.d.recoveryCopy = sealRecoveryCopy(await sharingOf(anna.d), id).store;
    anna.d.store.putSave({ place: { osm: { type: 'node', id: 10 }, name: 'R', category: 'amenity=cafe', geometry: { type: 'Point', coordinates: [2.35, 48.85] } } });
    await anna.d.ctl.refresh();
    expect(anna.d.ctl.snapshot().recoveryCopyMissing).toBe(false);
    expect((await restoreWithPhrase(anna.created.phrase, anna.location, { readAdapter, writeAdapter: () => anna.storage })).sharing.cert.rotation).toBe(1);
  });

  it('a recovery kit naming a previous storage follows its signed redirect to the current one', async () => {
    const anna = person('anna');
    await anna.d.ctl.refresh();
    // The previous storage keeps my newest index (the redirect, certifying the new address) and
    // an old keys/<owner>.bin; the current storage has the current copy.
    const oldAddress = `https://anna-old-${++ids}.example/tl/`;
    const oldStorage = new MemoryAdapter();
    world.set(oldAddress, oldStorage);
    await oldStorage.put('index.json', (await anna.storage.get('index.json'))!.data);
    await oldStorage.put(keyPath(anna.d.record.owner), new Uint8Array([1, 2, 3]));
    const j = await restoreWithPhrase(anna.created.phrase, oldAddress, { readAdapter, writeAdapter: () => anna.storage });
    expect(j.sharing.cert.location).toBe(anna.location);
  });
});

describe('review F-07: lock after N days without sync', () => {
  it.fails('a clock set back before the last successful sync does not keep the device unlocked', () => {
    const day = 86_400_000;
    const settings = { days: 7, wipe: false, since: Date.UTC(2026, 0, 1) };
    const lastSuccess = Date.UTC(2026, 5, 1);
    // Thief sets the phone's date back 1 year: "now - lastSuccess" is negative, the rule says "none".
    expect(staleSyncAction(settings, lastSuccess, lastSuccess - 365 * day, true)).toBe('lock');
  });
});
