/**
 * Full scenario between simulated users (T-208 acceptance criterion, T-209 revocation), through
 * the ContactsService and the real sync engine: sql.js databases (the web driver), in-memory
 * storages reached by "HTTPS" through a shared map, real crypto. No React.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import initSqlJs from 'sql.js';
import {
  devicePublicKeys,
  generateDeviceKeys,
  generateRecoveryPhrase,
  generateVaultDataKey,
  generateX25519KeyPair,
  identityFromPhrase,
  issueDeviceCert,
  issueSharingCert,
  ready,
  toB64Url,
  type DeviceSigner,
  type Identity,
  type SharingKey,
} from '@triangulair/crypto';
import { DataStore } from '@triangulair/data';
import { MemoryAdapter, type StorageAdapter } from '@triangulair/storage';
import { MemoryStateStore, SyncEngine } from '@triangulair/sync';

import { SqlJsDriver } from '../data/sqljsDriver';
import { findLink, MAX_INVITE_LINK_CHARS } from './links';
import { memoryKV, memorySecrets } from './local';
import { engineSyncPort } from './port';
import { linkProblemOf } from './problems';
import { createContactsService, type ContactsService } from './service';

const SQL = await initSqlJs();
const DAY = 24 * 60 * 60 * 1000;

class World {
  readonly storages = new Map<string, StorageAdapter>();
  readAdapter = (location: string): StorageAdapter => {
    const s = this.storages.get(location);
    if (!s) throw new Error(`no storage at ${location}`);
    return s;
  };
}

interface User {
  name: string;
  identity: Identity;
  owner: string;
  signer: DeviceSigner;
  sharing: SharingKey;
  store: DataStore;
  engine: SyncEngine;
  svc: ContactsService;
  clock: { now: number };
}

let actor = 0;
async function user(w: World, name: string, opts: { storage?: boolean; clock?: { now: number }; friendKeys?: boolean } = {}): Promise<User> {
  const identity = identityFromPhrase(generateRecoveryPhrase());
  const keys = generateDeviceKeys();
  const signer: DeviceSigner = { keys, cert: issueDeviceCert(identity, devicePublicKeys(keys)) };
  const withStorage = opts.storage ?? true;
  const location = `https://${name}.example/tl/`;
  const kp = generateX25519KeyPair();
  const sharing: SharingKey = {
    keyPair: kp,
    cert: issueSharingCert(identity, kp.publicKey, { rotation: withStorage ? 1 : 0, ...(withStorage && { location }) }),
    vaultDataKey: generateVaultDataKey(),
  };
  const storage = withStorage ? new MemoryAdapter() : undefined;
  if (storage) w.storages.set(location, storage);
  const driver = new SqlJsDriver(new SQL.Database());
  const store = DataStore.open({ driver, meId: identity.owner, actor: (++actor).toString(16).padStart(32, '0') });
  const state = new MemoryStateStore();
  const clock = opts.clock ?? { now: Date.parse('2026-10-23T16:30:00Z') };
  // As the SyncProvider does: every pass reads a friend with the invitation keys of links I answered.
  let svc: ContactsService | null = null;
  const friendKeys = opts.friendKeys === false ? undefined : (owner: string) => svc?.invitationKeysFor(owner) ?? [];
  const engine = new SyncEngine({ store, state, sharing, device: signer, ...(storage && { storage }), readAdapter: w.readAdapter, fullCheckMs: 0, now: () => new Date(clock.now), ...(friendKeys && { friendKeys }) });
  const port = engineSyncPort({ engine, state, sharing: () => sharing.cert, device: () => signer, readAdapter: w.readAdapter });
  svc = await createContactsService({ port, local: memoryKV(), secrets: memorySecrets(), now: () => clock.now });
  return { name, identity, owner: identity.owner, signer, sharing, store, engine, svc: svc!, clock };
}

function point(id: number, name: string) {
  return { osm: { type: 'node' as const, id }, name, category: 'amenity=restaurant', geometry: { type: 'Point' as const, coordinates: [2.35 + id * 1e-4, 48.85] as [number, number] } };
}

function friendPlaces(u: User, owner: string): string[] {
  return u.store.repo.db.all<{ place_id: string }>(`SELECT place_id FROM saves WHERE owner_id = ? ORDER BY place_id`, [owner]).map((r) => r.place_id);
}

async function problemOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return linkProblemOf(e);
  }
  return 'none';
}

beforeAll(async () => {
  await ready();
});

describe('invitation by link and return link', () => {
  it('regular passes keep reading with the invitation key until the answer is accepted', async () => {
    const w = new World();
    const alice = await user(w, 'alice');
    const bob = await user(w, 'bob');
    const carol = await user(w, 'carol', { friendKeys: false });
    alice.store.putSave({ place: point(1, 'Shared') });
    await alice.engine.sync();
    for (const who of [bob, carol]) {
      const inv = await alice.svc.createInvitation({ name: who.name });
      const opened = await who.svc.openInvitation(inv.link);
      await who.svc.answerInvitation(opened.token, { name: 'Alice', shareBack: false });
      expect(friendPlaces(who, alice.owner)).toEqual(['osm:node/1']);
    }
    // Alice saves another place; regular passes (launch, foreground, edit) on both sides.
    alice.store.putSave({ place: point(3, 'Another') });
    await alice.engine.sync();
    await bob.engine.sync();
    await bob.engine.sync();
    expect(friendPlaces(bob, alice.owner)).toEqual(['osm:node/1', 'osm:node/3']);
    // Without the hook (what the app did before the wiring), the pass erases what the invitation showed.
    await carol.engine.sync();
    expect(friendPlaces(carol, alice.owner)).toEqual([]);
  });

  it('invite, see the places right away, answer, accept with re-encryption, then remove', async () => {
    const w = new World();
    const alice = await user(w, 'alice');
    const bob = await user(w, 'bob');
    alice.store.putSave({ place: point(1, 'Shared') });
    alice.store.putSave({ place: point(2, 'Private'), sharing: 'private' });
    await alice.engine.sync();

    // Inviting publishes the index that lists the invitation first; the link is short.
    const inv = await alice.svc.createInvitation({ name: 'Bob' });
    expect(inv.link.length).toBeLessThanOrEqual(MAX_INVITE_LINK_CHARS);
    expect(findLink(`Alice invites you: ${inv.link}`)!.link).toBe(inv.link);
    expect(alice.svc.invitations()).toMatchObject([{ id: inv.id, name: 'Bob', phase: 'waiting' }]);

    // Bob checks it against Alice's index, sees the same safety code, answers.
    const opened = await bob.svc.openInvitation(`Alice invites you: ${inv.link}`);
    expect(opened.owner).toBe(alice.owner);
    expect(opened.safety).toEqual(alice.svc.safetyCode(bob.owner));
    expect(opened.safety).toHaveLength(12);
    const { link: returnLink } = await bob.svc.answerInvitation(opened.token, { name: 'Alice', shareBack: true });
    expect(returnLink.startsWith('https://triangulair.app/r#')).toBe(true);
    // Her shared place is visible right away (invitation key); the private one never.
    expect(friendPlaces(bob, alice.owner)).toEqual(['osm:node/1']);
    expect(bob.svc.contacts()).toMatchObject([{ owner: alice.owner, name: 'Alice', follow: true, share: { kind: 'all' }, verified: false, checkable: true }]);
    expect(bob.svc.invitationKeysFor(alice.owner)).toHaveLength(1);

    // Alice receives the answer: one answer, no warning.
    const got = await alice.svc.receiveAnswer(`here: ${returnLink}`);
    expect(got).toEqual({ invitationId: inv.id, responder: bob.owner });
    // The same answer twice is still one responder.
    await alice.svc.receiveAnswer(returnLink);
    const detail = alice.svc.answers(inv.id)!;
    expect(detail.warnings).toEqual([]);
    expect(detail.rows).toHaveLength(1);
    expect(detail.names[bob.owner]).toBe('Bob');
    expect(detail.safety[bob.owner]).toEqual(opened.safety);
    expect(alice.svc.invitations()[0]!.phase).toBe('answered');

    // Accept: the invitation key stops reading anything new (packs re-sealed with new pack keys).
    const invKey = bob.svc.invitationKeysFor(alice.owner)[0]!;
    await alice.svc.acceptAnswer(inv.id, bob.owner, { name: 'Bob', share: { kind: 'all' }, follow: true });
    expect(alice.svc.invitations()[0]!.phase).toBe('accepted');
    expect(alice.svc.contacts()).toMatchObject([{ owner: bob.owner, name: 'Bob', follow: true, share: { kind: 'all' } }]);
    const linkHolder = await user(w, 'mallory');
    const r = await linkHolder.engine.reader.read({ owner: alice.owner, location: 'https://alice.example/tl/', extraKeys: [invKey] });
    expect(r.status).not.toBe('error');
    expect(friendPlaces(linkHolder, alice.owner)).toEqual([]);
    // Bob reads her with his own key now.
    await bob.engine.sync();
    expect(friendPlaces(bob, alice.owner)).toEqual(['osm:node/1']);
    // And Alice sees Bob's (he shares back).
    bob.store.putSave({ place: point(7, 'Bob spot') });
    await bob.engine.sync();
    await alice.engine.sync();
    expect(friendPlaces(alice, bob.owner)).toEqual(['osm:node/7']);

    // "They see my places" off, then removal: Bob loses her places at his next sync.
    await alice.svc.setShare(bob.owner, { kind: 'none' });
    await bob.engine.sync();
    expect(friendPlaces(bob, alice.owner)).toEqual([]);
    await alice.svc.setShare(bob.owner, { kind: 'all' });
    await bob.engine.sync();
    expect(friendPlaces(bob, alice.owner)).toEqual(['osm:node/1']);
    await alice.svc.removeContact(bob.owner);
    expect(alice.svc.contacts()).toEqual([]);
    await bob.engine.sync();
    expect(friendPlaces(bob, alice.owner)).toEqual([]);
    expect(friendPlaces(alice, bob.owner)).toEqual([]);
  });

  it('an answer without a storage is accepted as "cannot be checked"; verified is local', async () => {
    const w = new World();
    const alice = await user(w, 'alice');
    const carol = await user(w, 'carol', { storage: false });
    alice.store.putSave({ place: point(1, 'Shared') });
    await alice.engine.sync();
    const inv = await alice.svc.createInvitation();
    const opened = await carol.svc.openInvitation(inv.link);
    const { link } = await carol.svc.answerInvitation(opened.token, { name: 'Alice', shareBack: true });
    expect(carol.svc.contacts()[0]).toMatchObject({ share: { kind: 'none' }, follow: true }); // no storage: nothing to share back
    await alice.svc.receiveAnswer(link);
    expect(alice.svc.answers(inv.id)!.rows[0]!.warnings).toEqual(['uncheckable']);
    await alice.svc.acceptAnswer(inv.id, carol.owner, { name: 'Carol', share: { kind: 'all' }, follow: true });
    expect(alice.svc.contact(carol.owner)).toMatchObject({ checkable: false, follow: false, verified: false, share: { kind: 'all' } });
    await carol.engine.sync();
    expect(friendPlaces(carol, alice.owner)).toEqual(['osm:node/1']);
    // The safety code compared by QR: the mark is mine only.
    expect(alice.svc.matchSafetyQr(carol.owner, carol.svc.safetyQr(alice.owner))).toBe(true);
    expect(alice.svc.matchSafetyQr(carol.owner, 'tlsafe1:AAAA')).toBe(false);
    alice.svc.setVerified(carol.owner, true);
    expect(alice.svc.contact(carol.owner)!.verified).toBe(true);
    expect(carol.svc.contact(alice.owner)!.verified).toBe(false);
  });

  it('several answers, a late one after acceptance, one opened after expiry', async () => {
    const w = new World();
    const clock = { now: Date.parse('2026-10-23T16:30:00Z') };
    const alice = await user(w, 'alice', { clock });
    const bob = await user(w, 'bob', { clock });
    const eve = await user(w, 'eve', { clock });
    await alice.engine.sync();
    const inv = await alice.svc.createInvitation({ name: 'Bob' });
    const answer = async (u: User) => (await u.svc.answerInvitation((await u.svc.openInvitation(inv.link)).token, { name: 'A', shareBack: false })).link;
    const fromBob = await answer(bob);
    const fromEve = await answer(eve);
    await alice.svc.receiveAnswer(fromBob);
    await alice.svc.receiveAnswer(fromEve);
    expect(alice.svc.invitations()[0]!.phase).toBe('several');
    const d = alice.svc.answers(inv.id)!;
    expect(d.warnings).toEqual(['several']);
    expect(d.rows.every((r) => r.confirm)).toBe(true);
    await alice.svc.acceptAnswer(inv.id, bob.owner, { name: 'Bob', share: { kind: 'all' }, follow: false });
    expect(alice.svc.invitations()[0]!.phase).toBe('accepted-late');
    expect(alice.svc.answers(inv.id)!.warnings).toEqual(['late-after-accept']);

    // Another invitation, answered on day 6, opened by Alice on day 8: flagged.
    const inv2 = await alice.svc.createInvitation();
    clock.now += 6 * DAY;
    const opened = await bob.svc.openInvitation(inv2.link);
    const late = (await bob.svc.answerInvitation(opened.token, { name: 'A', shareBack: false })).link;
    clock.now += 2 * DAY;
    await alice.svc.receiveAnswer(late);
    const d2 = alice.svc.answers(inv2.id)!;
    expect(d2.rows[0]).toMatchObject({ openedAfterExpiry: true, confirm: true });
    expect(d2.warnings).toEqual(['after-expiry']);
    // The link itself no longer opens.
    expect(await problemOf(eve.svc.openInvitation(inv2.link))).toBe('expired');
    // After the grace period, answers are no longer opened.
    clock.now += 7 * DAY;
    expect(await problemOf(alice.svc.receiveAnswer(late))).toBe('expired');
    expect(alice.svc.invitations().find((i) => i.id === inv2.id)!.phase).toBe('over');
  });

  it('refuses forged, withdrawn, foreign and own links; a key change cancels open invitations', async () => {
    const w = new World();
    const alice = await user(w, 'alice');
    const bob = await user(w, 'bob');
    await alice.engine.sync();
    const inv = await alice.svc.createInvitation();
    expect(await problemOf(alice.svc.openInvitation(inv.link))).toBe('own-link');
    expect(await problemOf(bob.svc.openInvitation('hello'))).toBe('malformed');
    // Another expiry (one bit changed in the fragment): another token, not listed.
    const f = findLink(inv.link)!.fragment;
    const bytes = Uint8Array.from(atob(f.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (f.length % 4)) % 4)), (c) => c.charCodeAt(0));
    bytes[57] = bytes[57]! ^ 1;
    expect(await problemOf(bob.svc.openInvitation(`https://triangulair.app/i#${toB64Url(bytes)}`))).toBe('no-longer-works');
    // An answer to someone else's invitation.
    const carol = await user(w, 'carol');
    await carol.engine.sync();
    const other = await carol.svc.createInvitation();
    const toCarol = (await bob.svc.answerInvitation((await bob.svc.openInvitation(other.link)).token, { name: 'C', shareBack: false })).link;
    expect(await problemOf(alice.svc.receiveAnswer(toCarol))).toBe('not-mine');
    expect(await problemOf(alice.svc.receiveAnswer(inv.link))).toBe('wrong-kind');

    // Withdrawn: the link stops working.
    await alice.svc.cancelInvitation(inv.id);
    expect(alice.svc.invitations()).toEqual([]);
    expect(await problemOf(bob.svc.openInvitation(inv.link))).toBe('no-longer-works');

    // A new sharing certificate (storage move, key change) cancels the open ones.
    const inv3 = await alice.svc.createInvitation();
    const kp = generateX25519KeyPair();
    const next: SharingKey = { keyPair: kp, cert: issueSharingCert(alice.identity, kp.publicKey, { rotation: 2, location: 'https://alice.example/tl/' }), vaultDataKey: alice.sharing.vaultDataKey };
    await alice.engine.own!.rotate(next);
    alice.sharing.cert = next.cert;
    alice.sharing.keyPair = next.keyPair;
    await alice.engine.sync();
    expect(alice.svc.invitations().find((i) => i.id === inv3.id)!.phase).toBe('cancelled');
    expect(await problemOf(bob.svc.openInvitation(inv3.link))).toBe('no-longer-works');
  });

  it('a contact\'s key change becomes a notice', async () => {
    const w = new World();
    const alice = await user(w, 'alice');
    const bob = await user(w, 'bob');
    await alice.engine.sync();
    const inv = await alice.svc.createInvitation();
    await bob.svc.answerInvitation((await bob.svc.openInvitation(inv.link)).token, { name: 'Alice', shareBack: false });
    bob.svc.refresh();
    expect(bob.svc.notices()).toEqual([]);
    const kp = generateX25519KeyPair();
    const next: SharingKey = { keyPair: kp, cert: issueSharingCert(alice.identity, kp.publicKey, { rotation: 2, location: 'https://alice.example/tl/' }), vaultDataKey: alice.sharing.vaultDataKey };
    await alice.engine.own!.rotate(next);
    alice.sharing.cert = next.cert;
    await alice.engine.sync();
    await bob.engine.sync();
    bob.svc.refresh();
    expect(bob.svc.notices()).toMatchObject([{ owner: alice.owner, kind: 'key-changed' }]);
    bob.svc.dismissNotice(alice.owner);
    expect(bob.svc.notices()).toEqual([]);
  });
});
