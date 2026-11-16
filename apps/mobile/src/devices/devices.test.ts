/**
 * T-206 / T-207, app side: the transfer channel (links, QR codes, sealed request and approval), the
 * state machines on both devices against an in-memory storage, the restore with the 12 words, the
 * identity glue (joined device, identity move), the credential guide, the changes journal and the
 * "lock if no sync for N days" rule.
 */
import { describe, expect, it } from 'vitest';
import initSqlJs from 'sql.js';
import {
  decodePrimaryIdentity,
  fromB64Url,
  identityFromPhrase,
  issueDeviceCert,
  ready,
  sealSharingKey,
  sealVault,
  verifyDeviceCert,
  verifyIdentityMove,
  type SharingKey,
} from '@triangulair/crypto';
import { DataStore } from '@triangulair/data';
import { MemoryAdapter, ReadOnly, type StorageAdapter } from '@triangulair/storage';
import { ContactBook, VAULT_PATH, keyPath } from '@triangulair/sync';

import { SqlJsDriver } from '../data/sqljsDriver';
import { checkStoredIdentity, createIdentity, parseDeviceKeys, type CreatedIdentity } from '../identity/create';
import { parseStaleSync, staleDaysLeft, staleSyncAction } from '../identity/lock';
import { masterIdentity, rotateStoredSharingKey } from '../storage/certify';
import type { StorageConfig } from '../storage/config';
import { LOCAL_ONLY } from '../storage/state';
import {
  decodeInvite,
  deviceFingerprint,
  encodeDeviceLink,
  encodeInvite,
  encodeOffer,
  encodeReply,
  encodeRequestLink,
  ephemeralKeys,
  newChannelKey,
  newSlot,
  openRequest,
  parseDeviceLink,
  parseOffer,
  parseReply,
  parseRequestLink,
  sealRequest,
  slotFiles,
  TRANSFER_WINDOW_MS,
} from './channel';
import { credentialGuide, guideFor } from './guide';
import { joinedIdentity, moveIdentity } from './identity';
import { addEntry, changesSince, diffSaves, ownSaves, revertChange, JOURNAL_MAX } from './journal';
import { LinkReceiver, LinkSender, QrReceiver, QrSender, RestoreFailed, VALUE_PROFILE, VALUE_STORAGE, lastDigits, maskedFingerprint, restoreWithPhrase, type OldDeviceDeps } from './sessions';

await ready();
const SQL = await initSqlJs();

const LOCATION = 'https://anna.example/tl/';

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

const config: StorageConfig = { kind: 'webdav', flavor: 'generic', url: 'https://dav.example/anna/', username: 'anna', password: 'pw', readUrl: LOCATION, conditionalWrites: true };

interface Anna {
  created: CreatedIdentity;
  sharing: SharingKey;
  storage: MemoryAdapter;
  registered: { device: string; name: string }[];
  deps(extra?: Partial<OldDeviceDeps>): OldDeviceDeps;
}

async function anna(opts: { vault?: boolean } = {}): Promise<Anna> {
  const created = createIdentity({ primary: true });
  const rot = rotateStoredSharingKey(created.record, created.secrets, { location: LOCATION }, { kind: 'primary' });
  const secrets = { ...created.secrets, sharingKey: rot.sealedForThisDevice };
  const storage = new MemoryAdapter();
  if (opts.vault !== false) {
    const book = ContactBook.empty(created.record.owner);
    // Values in the vault are signed (devices review F-01): here by my master key.
    const master = masterIdentity(created.record, secrets, { kind: 'primary' });
    const signer = { id: created.record.owner, secretKey: master.master.secretKey };
    book.setValue(VALUE_STORAGE, config, signer);
    book.setValue(VALUE_PROFILE, { name: 'Anna' }, signer);
    await storage.put(VAULT_PATH, sealVault(book.records, rot.sharing.vaultDataKey));
  }
  const registered: Anna['registered'] = [];
  const a: Anna = {
    created: { ...created, secrets },
    sharing: rot.sharing,
    storage,
    registered,
    deps: (extra = {}) => ({
      storage,
      location: LOCATION,
      sharing: async () => rot.sharing,
      certify: async (pub, master) => {
        const id = masterIdentity(created.record, secrets, master);
        return issueDeviceCert(id, pub);
      },
      register: async (cert, name) => void registered.push({ device: cert.device, name }),
      ...extra,
    }),
  };
  return a;
}

const newDeviceDeps = (a: Anna, now?: () => number) => ({
  readAdapter: (loc: string) => {
    if (loc !== LOCATION) throw new Error('no server');
    return readOnly(a.storage);
  },
  writeAdapter: () => a.storage,
  ...(now && { now }),
});

const files = async (a: Anna) => (await a.storage.list('transfer/')).map((e) => e.path);

describe('channel (app-level wrappers)', () => {
  it('device link and request link: round trip, found in a message, refused when damaged or of the other kind', () => {
    const slot = newSlot();
    const link = encodeDeviceLink({ slot, location: LOCATION });
    expect(link.startsWith('https://triangulair.app/d#')).toBe(true);
    expect(parseDeviceLink(`My link: ${link} (code by SMS)`)).toEqual({ slot, location: LOCATION });
    expect(() => parseDeviceLink('https://triangulair.app/d#AAAA')).toThrow('bad-link');
    expect(() => parseDeviceLink('hello')).toThrow('bad-link');
    expect(() => encodeDeviceLink({ slot, location: 'http://anna.example/' })).toThrow();
    const req = encodeRequestLink(slot, new Uint8Array(64).fill(7));
    expect(parseRequestLink(`here: ${req}`)).toEqual({ slot, sealed: new Uint8Array(64).fill(7) });
    expect(() => parseDeviceLink(req)).toThrow('bad-link');
    expect(() => parseRequestLink(link)).toThrow('bad-link');
  });

  it('QR codes: offer and reply round trip, prefixes checked', () => {
    const eph = ephemeralKeys();
    const created = createIdentity({ primary: false });
    const keys = parseDeviceKeys(created.secrets.deviceKeys);
    const offer = encodeOffer({ device: keys.id, box: created.record.deviceCert.box, ephemeral: eph.publicKey, name: 'Anna’s tablet‮' });
    const o = parseOffer(offer);
    expect(o.device).toBe(keys.id);
    expect(o.name).toBe('Anna’s tablet');
    expect(() => parseOffer(offer.replace('TLDA1:', 'TLDB1:'))).toThrow('bad-code');
    const slot = newSlot();
    const r = parseReply(encodeReply({ slot, ephemeral: eph.publicKey, location: LOCATION }));
    expect(r.slot).toBe(slot);
    expect(r.location).toBe(LOCATION);
    // Short enough for a QR code read from a screen.
    expect(offer.length).toBeLessThan(200);
  });

  it('invitation holds no key of mine; request sealed under the channel key and the slot; fingerprint is 3 groups of 4 digits', async () => {
    const a = await anna({ vault: false });
    const slot = newSlot();
    const key = newChannelKey();
    const invite = decodeInvite(encodeInvite({ owner: a.created.record.owner, location: LOCATION, slot, key }));
    expect(invite).toEqual({ owner: a.created.record.owner, location: LOCATION, slot, key });
    expect(Object.keys(JSON.parse(new TextDecoder().decode(encodeInvite(invite)))).sort()).toEqual(['key', 'location', 'owner', 'slot', 'type', 'v']);
    const sealed = sealRequest({ device: a.created.record.deviceId, box: a.created.record.deviceCert.box, name: 'Tablet' }, key, slot);
    expect(openRequest(sealed, key, slot).name).toBe('Tablet');
    expect(() => openRequest(sealed, key, newSlot())).toThrow();
    expect(() => openRequest(sealed, newChannelKey(), slot)).toThrow();
    expect(new TextDecoder().decode(sealed)).not.toContain('Tablet');
    const fp = deviceFingerprint(a.created.record.deviceId);
    expect(fp).toMatch(/^\d{4} \d{4} \d{4}$/);
    expect(lastDigits(fp)).toBe(fp.slice(-4));
    expect(maskedFingerprint(fp)).toBe(`${fp.slice(0, 9)} ····`);
  });
});

/** The new device opens the link with the code; its request link comes back; the old device approves. */
async function linkRound(a: Anna, sender: LinkSender, name = 'Anna’s tablet') {
  const s = sender.state;
  if (s.phase !== 'waiting') throw new Error(s.phase);
  const receiver = new LinkReceiver(newDeviceDeps(a), name);
  await receiver.open(s.link, s.code);
  const w = receiver.state;
  if (w.phase !== 'waiting') throw new Error(JSON.stringify(w));
  return { s, receiver, w };
}

describe('link + code', () => {
  it('old device invites, new device answers with a request link, old approves after the digits, keys only then, single use', async () => {
    const a = await anna();
    const sender = new LinkSender(a.deps());
    await sender.start();
    const s = sender.state;
    if (s.phase !== 'waiting') throw new Error(s.phase);
    expect(s.code.split(' ')).toHaveLength(6);
    const slot = parseDeviceLink(s.link).slot;
    expect(await files(a)).toEqual([slotFiles(slot).blob]);

    const receiver = new LinkReceiver(newDeviceDeps(a), 'Anna’s tablet');
    // Wrong code: try again.
    await receiver.open(s.link, 'abandon ability able about above absent');
    expect(receiver.state).toEqual({ phase: 'enter', error: 'wrong-code' });
    await receiver.open(s.link, s.code.toUpperCase().split(' ').map((w) => w.slice(0, 4)).join('-'));
    const w = receiver.state;
    if (w.phase !== 'waiting') throw new Error(JSON.stringify(w));
    // Nothing written by the new device (it has no storage access yet), nothing to poll for.
    expect(await files(a)).toEqual([slotFiles(slot).blob]);
    await receiver.poll();
    expect(receiver.state.phase).toBe('waiting');

    // The old device gets the request link; another transfer's (or garbage) is refused.
    sender.received(encodeRequestLink(newSlot(), new Uint8Array(80)));
    expect(sender.state).toMatchObject({ phase: 'waiting', error: 'bad-link' });
    sender.received(`Here it is: ${w.requestLink}`);
    const q = sender.state;
    if (q.phase !== 'request') throw new Error(q.phase);
    expect(q.device.name).toBe('Anna’s tablet');
    expect(q.device.fingerprint).toBe(w.fingerprint);

    // Wrong digits: nothing is certified.
    const wrong = String((Number(lastDigits(w.fingerprint)) + 1) % 10000).padStart(4, '0');
    await sender.approve({ kind: 'primary' }, wrong);
    expect(sender.state).toMatchObject({ phase: 'request', error: 'digits' });
    await sender.approve({ kind: 'phrase', phrase: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about' }, lastDigits(w.fingerprint));
    expect(sender.state).toMatchObject({ phase: 'request', error: 'phrase-mismatch' });
    await sender.approve({ kind: 'primary' }, lastDigits(w.fingerprint));
    expect(sender.state).toMatchObject({ phase: 'sent', name: 'Anna’s tablet' });
    // Not listed until the new device has picked its approval up.
    expect(a.registered).toEqual([]);
    expect(await files(a)).toEqual([slotFiles(slot).approval]);

    await receiver.poll();
    const done = receiver.state;
    if (done.phase !== 'approved') throw new Error(done.phase);
    const j = done.joined;
    expect(j.owner).toBe(a.created.record.owner);
    expect(verifyDeviceCert(j.deviceCert, { expectedOwner: j.owner }).device).toBe(receiver.deviceKeys.id);
    expect(j.storage).toEqual(config);
    expect(j.profileName).toBe('Anna');
    expect(j.sharing.cert.rotation).toBe(1);
    expect(await files(a)).toEqual([]);
    await sender.poll();
    expect(sender.state).toMatchObject({ phase: 'done', name: 'Anna’s tablet' });
    expect(a.registered).toEqual([{ device: receiver.deviceKeys.id, name: 'Anna’s tablet' }]);

    // What the new device stores is a consistent identity.
    const { record, secrets } = joinedIdentity(j, 1000);
    expect(checkStoredIdentity(record, secrets).sharing.cert.key).toBe(a.sharing.cert.key);
    expect(record.primary).toBe(false);

    // The link works only once.
    const again = new LinkReceiver(newDeviceDeps(a), 'Thief');
    await again.open(s.link, s.code);
    expect(again.state).toEqual({ phase: 'enter', error: 'gone' });
  });

  it('a refused request (or one approved for another key) gives nothing; the approval opens only for its device', async () => {
    const a = await anna();
    const sender = new LinkSender(a.deps());
    await sender.start();
    const { receiver, w } = await linkRound(a, sender, 'Not mine');
    sender.received(w.requestLink);
    const q = sender.state;
    if (q.phase !== 'request') throw new Error(q.phase);
    await sender.refuse();
    expect(sender.state).toEqual({ phase: 'refused', device: q.device });
    expect(await files(a)).toEqual([]);
    expect(a.registered).toEqual([]);
    await receiver.poll();
    expect(receiver.state.phase).toBe('waiting');
  });

  it('expires after 15 minutes on both sides; cancelling deletes the files', async () => {
    let now = Date.parse('2026-11-08T10:00:00Z');
    const a = await anna();
    const sender = new LinkSender(a.deps({ now: () => now }));
    await sender.start();
    const s = sender.state;
    if (s.phase !== 'waiting') throw new Error(s.phase);
    now += TRANSFER_WINDOW_MS + 1000;
    const late = new LinkReceiver(newDeviceDeps(a, () => now), 'Late');
    await late.open(s.link, s.code);
    expect(late.state).toEqual({ phase: 'enter', error: 'expired' });
    await sender.poll();
    expect(sender.state.phase).toBe('expired');
    expect(await files(a)).toEqual([]);

    const other = new LinkSender(a.deps());
    await other.start();
    expect(await files(a)).toHaveLength(1);
    await other.cancel();
    expect(other.state.phase).toBe('cancelled');
    expect(await files(a)).toEqual([]);
  });

  it('the new device can restore with the 12 words instead, from the address the invitation named', async () => {
    const a = await anna();
    await a.storage.put(keyPath(a.created.record.owner), sealSharingKey(a.sharing, identityFromPhrase(a.created.phrase)));
    const sender = new LinkSender(a.deps());
    await sender.start();
    const { receiver } = await linkRound(a, sender, 'Laptop');
    await receiver.certifyWithPhrase('abandon '.repeat(11) + 'about');
    expect(receiver.state).toMatchObject({ phase: 'waiting', error: 'phrase-mismatch' });
    await receiver.certifyWithPhrase(a.created.phrase, { primary: true });
    const r = receiver.state;
    if (r.phase !== 'approved') throw new Error(JSON.stringify(r));
    expect(r.joined.deviceKeys.id).toBe(receiver.deviceKeys.id);
    expect(decodePrimaryIdentity(fromB64Url(r.joined.primaryIdentity!)).owner).toBe(a.created.record.owner);
    expect(r.joined.vaultCopy).not.toBeNull();
    expect(await files(a)).toEqual([]);
  });

  it('a vault without storage settings: the device joins, its storage access is asked again', async () => {
    const a = await anna({ vault: false });
    const sender = new LinkSender(a.deps());
    await sender.start();
    const { receiver, w } = await linkRound(a, sender, 'Tablet');
    sender.received(w.requestLink);
    await sender.approve({ kind: 'primary' }, lastDigits(w.fingerprint));
    await receiver.poll();
    expect(receiver.state).toMatchObject({ phase: 'approved', joined: { storage: null } });
  });
});

describe('QR code (side by side)', () => {
  it('new device shows its code, old device checks the digits, approves and answers; listed once the package is fetched', async () => {
    const a = await anna();
    const receiver = new QrReceiver(newDeviceDeps(a), 'Anna’s tablet');
    const shown = receiver.state;
    if (shown.phase !== 'showing') throw new Error(shown.phase);
    const sender = new QrSender(a.deps());
    expect(() => sender.scanned('nonsense')).toThrow('bad-code');
    sender.scanned(shown.offer);
    const c = sender.state;
    if (c.phase !== 'confirm') throw new Error(c.phase);
    expect(c.device.fingerprint).toBe(shown.fingerprint);
    await sender.approve({ kind: 'primary' }, '');
    expect(sender.state).toMatchObject({ phase: 'confirm', error: 'digits' });
    await sender.approve({ kind: 'primary' }, lastDigits(shown.fingerprint));
    const sh = sender.state;
    if (sh.phase !== 'showing') throw new Error(sh.phase);
    expect(a.registered).toEqual([]);
    expect((await files(a)).length).toBe(1);
    // A reply from another transfer does not open it.
    await receiver.scanned(encodeReply({ slot: newSlot(), ephemeral: ephemeralKeys().publicKey, location: LOCATION }));
    expect(receiver.state).toMatchObject({ phase: 'showing', error: 'gone' });
    await receiver.scanned(sh.reply);
    const r = receiver.state;
    if (r.phase !== 'approved') throw new Error(JSON.stringify(r));
    expect(r.joined.sharing.cert.key).toBe(a.sharing.cert.key);
    expect(r.joined.storage).toEqual(config);
    expect(await files(a)).toEqual([]);
    await sender.poll();
    expect(sender.state.phase).toBe('done');
    expect(a.registered.map((x) => x.name)).toEqual(['Anna’s tablet']);
  });

  it('"Not my device" leads to the key change offer, nothing certified', async () => {
    const a = await anna();
    const receiver = new QrReceiver(newDeviceDeps(a), 'Someone');
    const shown = receiver.state;
    if (shown.phase !== 'showing') throw new Error(shown.phase);
    const sender = new QrSender(a.deps());
    sender.scanned(shown.offer);
    sender.refuse();
    expect(sender.state).toMatchObject({ phase: 'refused', device: { device: receiver.deviceKeys.id } });
    expect(await files(a)).toEqual([]);
  });
});

describe('restore with the 12 words', () => {
  it('reads the phrase copy of the sharing key and the vault at the read address', async () => {
    const a = await anna();
    const id = identityFromPhrase(a.created.phrase);
    await a.storage.put(keyPath(a.created.record.owner), sealSharingKey(a.sharing, id));
    await expect(restoreWithPhrase('abandon '.repeat(11) + 'about', LOCATION, newDeviceDeps(a))).rejects.toMatchObject({ code: 'not-found' });
    await expect(restoreWithPhrase('not words', LOCATION, newDeviceDeps(a))).rejects.toBeInstanceOf(RestoreFailed);
    await expect(restoreWithPhrase(a.created.phrase, 'https://elsewhere.example/', newDeviceDeps(a))).rejects.toMatchObject({ code: 'address' });
    const j = await restoreWithPhrase(`  ${a.created.phrase.toUpperCase()} `, LOCATION, newDeviceDeps(a), { primary: true });
    expect(j.owner).toBe(a.created.record.owner);
    expect(j.storage).toEqual(config);
    expect(j.primaryIdentity).not.toBeNull();
    const { record, secrets } = joinedIdentity(j, 5);
    expect(record.primary).toBe(true);
    expect(() => checkStoredIdentity(record, secrets)).not.toThrow();
  });
});

describe('identity move (theft of the primary device)', () => {
  it('needs the old words, signs the move both ways, keeps the read address, makes this device primary', async () => {
    const a = await anna();
    const keys = parseDeviceKeys(a.created.secrets.deviceKeys);
    expect(() => moveIdentity('abandon '.repeat(11) + 'about', a.created.record, keys, a.sharing, 0)).toThrow('phrase-mismatch');
    const m = moveIdentity(a.created.phrase, a.created.record, keys, a.sharing, Date.parse('2026-11-08T10:00:00Z'));
    expect(verifyIdentityMove(m.move, { expectedFrom: a.created.record.owner }).to).toBe(m.record.owner);
    expect(m.record.owner).not.toBe(a.created.record.owner);
    expect(m.phrase).not.toBe(a.created.phrase);
    expect(m.sharing.cert.location).toBe(LOCATION);
    expect(m.record.move).toEqual(m.move);
    expect(checkStoredIdentity(m.record, m.secrets).device.id).toBe(keys.id);
    expect(identityFromPhrase(m.phrase).owner).toBe(m.record.owner);
  });
});

describe('credential guide', () => {
  it('current storage first, then every previous one still holding a redirect', () => {
    const now = 1_000_000;
    const nc: StorageConfig = { ...config, flavor: 'nextcloud', nextcloud: { server: 'https://cloud.example', user: 'anna', shareLink: '' } };
    const s3: StorageConfig = { kind: 's3', endpoint: 'https://s3.eu-west-3.amazonaws.com', bucket: 'b', region: 'eu-west-3', accessKeyId: 'k', secretAccessKey: 's', prefix: 'tl/', pathStyle: true, readUrl: 'https://b.s3.example/tl/', conditionalWrites: true };
    const items = credentialGuide({ ...LOCAL_ONLY, current: nc, previous: [{ config: s3, movedAt: 0, keepUntil: now + 1 }, { config, movedAt: 0, keepUntil: now - 1 }] }, now);
    expect(items.map((i) => [i.role, i.protocol])).toEqual([['current', 'nextcloud'], ['previous', 's3']]);
    expect(items[0]!.links[0]!.url).toBe('https://cloud.example/index.php/settings/user/security');
    expect(items[0]!.canUpdateHere).toBe(true);
    expect(items[1]!.links[0]!.url).toContain('console.aws.amazon.com');
    expect(items[1]!.canUpdateHere).toBe(false);
    expect(guideFor({ kind: 'https', readUrl: LOCATION }, 'current').canUpdateHere).toBe(false);
    expect(guideFor({ ...s3, endpoint: 'https://s3.fr-par.scw.cloud' }, 'current').links).toEqual([]);
  });
});

describe('changes since a date (journal) and revert', () => {
  function store() {
    const driver = new SqlJsDriver(new SQL.Database());
    let n = 0;
    return DataStore.open({ driver, meId: 'ed25519:' + 'A'.repeat(43), actor: '0'.repeat(31) + '1', newId: () => `id${++n}` });
  }
  const place = (id: number, name: string) => ({ osm: { type: 'node' as const, id }, name, category: 'amenity=cafe', geometry: { type: 'Point' as const, coordinates: [2.35, 48.85] } });

  it('records what another device changed and puts it back from the local copy', () => {
    const s = store();
    s.putSave({ place: place(1, 'Café A'), comment: 'nice' });
    s.putSave({ place: place(2, 'Café B') });
    const before = ownSaves(s);
    // What the lost device did (imported from my storage).
    s.updateSave('osm:node/1', { comment: 'spam', status: 'favorite' });
    s.deleteSave('osm:node/2');
    s.putSave({ place: place(3, 'Planted') });
    const changes = diffSaves(before, ownSaves(s));
    expect(changes.map((c) => c.placeId)).toEqual(['osm:node/1', 'osm:node/2', 'osm:node/3']);
    const journal = addEntry([], { at: 2000, device: 'ed25519:lost', changes }, 2000);
    const lines = changesSince(journal, 1000, ['ed25519:lost']);
    expect(lines.map((l) => [l.kind, l.fields])).toEqual([['edited', ['comment', 'status']], ['removed', []], ['added', []]]);
    expect(changesSince(journal, 3000)).toEqual([]);
    expect(changesSince(journal, 0, ['ed25519:other'])).toEqual([]);
    for (const l of lines) revertChange(s, l.change);
    const after = ownSaves(s);
    expect(after.get('osm:node/1')).toMatchObject({ comment: 'nice', status: null, deleted: false });
    expect(after.get('osm:node/2')!.deleted).toBe(false);
    expect(after.get('osm:node/3')!.deleted).toBe(true);
  });

  it('keeps 120 days and a bounded number of changes; only the latest change of a place is revertible', () => {
    const c = (id: string) => ({ placeId: id, before: null, after: null });
    let j = addEntry([], { at: 0, device: null, changes: [c('old')] }, 0);
    j = addEntry(j, { at: 200 * 86_400_000, device: null, changes: [c('new')] }, 200 * 86_400_000);
    expect(j.map((e) => e.changes[0]!.placeId)).toEqual(['new']);
    const many = addEntry([], { at: 1, device: null, changes: Array.from({ length: JOURNAL_MAX + 50 }, (_, i) => c(`p${i}`)) }, 1);
    expect(many[0]!.changes).toHaveLength(JOURNAL_MAX);
    const twice = [
      { at: 10, device: 'd', changes: [{ placeId: 'x', before: null, after: { name: '', comment: 'b', commentVisibility: 'friends', status: null, priceLevel: null, sharing: 'friends', mainTagId: null, tagIds: [], deleted: false } }] },
      { at: 5, device: 'd', changes: [{ placeId: 'x', before: null, after: { name: '', comment: 'a', commentVisibility: 'friends', status: null, priceLevel: null, sharing: 'friends', mainTagId: null, tagIds: [], deleted: false } }] },
    ];
    expect(changesSince(twice, 0).map((l) => l.revertible)).toEqual([true, false]);
  });
});

describe('lock if no sync for N days', () => {
  const DAY = 86_400_000;
  it('locks or wipes after N days without a successful sync, counting from the option or the last sync', () => {
    const s = { days: 7, wipe: false, since: 0 };
    expect(staleSyncAction(null, null, 100 * DAY, true)).toBe('none');
    expect(staleSyncAction(s, null, 100 * DAY, false)).toBe('none'); // local only: nothing to wait for
    expect(staleSyncAction(s, 95 * DAY, 100 * DAY, true)).toBe('none');
    expect(staleSyncAction(s, 90 * DAY, 100 * DAY, true)).toBe('lock');
    expect(staleSyncAction({ ...s, wipe: true }, 90 * DAY, 100 * DAY, true)).toBe('wipe');
    expect(staleSyncAction({ ...s, since: 99 * DAY }, 10 * DAY, 100 * DAY, true)).toBe('none');
    expect(staleDaysLeft(s, 95 * DAY, 100 * DAY)).toBe(2);
    expect(parseStaleSync(JSON.stringify(s))).toEqual(s);
    expect(parseStaleSync('{"days":0,"since":1}')).toBeNull();
    expect(parseStaleSync('nope')).toBeNull();
  });
});
