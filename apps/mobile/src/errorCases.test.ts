/**
 * The spec's "Error cases" table, "What the user sees" column, one test per row (T-213): the note
 * or message the app shows for each situation, in English and French, from the same pure functions
 * the screens use. The behavior column is tested in packages/sync/test/error-cases.test.ts; both
 * are mapped row by row in docs/error-cases.md.
 */
import { describe, expect, it } from 'vitest';
import { ExpiredError, SignatureError, UnsupportedVersionError } from '@triangulair/crypto';
import { AuthError, NetworkError, PreconditionFailed, ProtocolError, NotFound } from '@triangulair/storage';
import { classifyError, type SpaceUsed, type SyncProblem, type SyncStatus } from '@triangulair/sync';

import { BaseMapFallback, baseMapFor, baseMapNoteKey, resetBaseMapSession } from './components/map/baseMap';
import { answerSet } from './contacts/model';
import { isRetryable, linkProblemOf } from './contacts/problems';
import { translate, type Params } from './i18n/core';
import { en } from './i18n/en';
import { fr } from './i18n/fr';
import { storedIdentityKind } from './identity/create';
import { goneKey } from './lists/sharing';
import { osmFailureKey } from './osm/errors';
import { friendNoteText, noteText } from './sync/noteText';
import { FRIEND_STALE_MS, formatBytes, friendNote, invitationsLogLine, noteHref, ownNote, quotaTips, spaceRows } from './sync/problems';

const DAY = 86_400_000;
const T = { en: (k: string, p?: Params) => translate('en', en, en, k, p), fr: (k: string, p?: Params) => translate('fr', fr, en, k, p) };
const NOW = new Date(2026, 10, 17, 18, 0).getTime();
const base: SyncStatus = { state: 'idle', foreground: true, online: true, pending: 0, lastSuccess: NOW - 60_000, failingSince: null, problem: null, banner: false };
const own = (e: unknown, online = true): SyncProblem => classifyError(e, 'own', online);
const friend = (e: unknown): SyncProblem => classifyError(e, 'friend');
const ownText = (s: SyncStatus, lang: 'en' | 'fr' = 'en') => {
  const n = ownNote(s, true);
  return n && noteText(n, s, T[lang], lang, NOW);
};
const friendText = (p: SyncProblem | null, last: number | null, lang: 'en' | 'fr' = 'en', keptAt: number | null = null) =>
  friendNoteText(friendNote(p, last, NOW, keptAt), 'Léa', T[lang]);

describe('spec "Error cases": what the user sees, one test per row', () => {
  it('No network: "Offline · 3 changes pending"', () => {
    const s: SyncStatus = { ...base, online: false, state: 'offline', pending: 3, problem: own(new NetworkError('x'), false) };
    expect(ownText(s)).toBe('Offline · 3 changes pending');
    expect(ownText(s, 'fr')).toBe('Hors ligne · 3 modifications en attente');
    expect(ownText({ ...s, pending: 1 })).toBe('Offline · 1 change pending');
  });

  it('My storage unreachable: nothing at first; after 24 h, "Your storage hasn\'t responded since yesterday"', () => {
    const p = own(new NetworkError('down'));
    expect(ownText({ ...base, problem: p, failingSince: NOW - 3_600_000 })).toBeNull();
    const s = { ...base, problem: p, failingSince: NOW - 25 * 3_600_000, banner: true };
    expect(ownText(s)).toBe('Your storage hasn’t responded since yesterday');
    expect(ownText(s, 'fr')).toBe('Votre stockage ne répond plus depuis hier');
  });

  it('Credentials rejected: "Reconnect your storage", straight to the connection form', () => {
    const s: SyncStatus = { ...base, state: 'blocked', problem: own(new AuthError('401')) };
    const n = ownNote(s, true)!;
    expect(ownText(s)).toBe('Reconnect your storage');
    expect(ownText(s, 'fr')).toBe('Reconnectez votre stockage');
    expect(n).toMatchObject({ action: 'storage', tone: 'error' });
    expect(noteHref(n)).toBe('/storage/setup?mode=edit');
    expect(T.en('sync.state.blocked')).toMatch(/changes wait/);
  });

  it('Quota full: space used by content type, with suggestions (version history, photo quality)', () => {
    const s: SyncStatus = { ...base, problem: own(new ProtocolError('507', { status: 507 })) };
    expect(ownText(s)).toBe('Your storage is full');
    const space: SpaceUsed = { places: 41_000, document: 1_250_000, lists: 0, public: 0, photos: 0, keys: 3_200, other: 9_500, total: 1_303_700, files: 12 };
    expect(spaceRows(space).map((r) => r.kind)).toEqual(['places', 'document', 'keys', 'other']);
    expect(formatBytes(space.total, 'en')).toBe('1.3 MB');
    expect(formatBytes(space.total, 'fr')).toBe('1,3 Mo');
    expect(formatBytes(820, 'en')).toBe('820 B');
    expect(quotaTips(space)).toEqual(['sync.space.tipHistory', 'sync.space.tipOther']);
    expect(quotaTips({ ...space, photos: 5_000_000 })).toContain('sync.space.tipPhotos');
    expect(quotaTips(null)).toEqual(['sync.space.tipHistory']);
    expect(T.en('sync.space.tipHistory')).toMatch(/version history/);
    expect(T.fr('sync.space.tipPhotos', { size: '5 Mo' })).toBe('Baissez la qualité des photos : elles occupent 5 Mo.');
    expect(T.en('sync.space.row', { what: T.en('sync.space.document'), size: '1.3 MB' })).toBe('Your places for your devices: 1.3 MB');
  });

  it('Interrupted write: nothing', () => {
    // The next pass completes the publication; a pack listed but not there yet is retried silently.
    expect(ownText({ ...base, problem: own(new NotFound('packs/x.bin')), failingSince: NOW - 60_000 })).toBeNull();
    expect(ownText({ ...base, problem: own(new NetworkError('reset')), failingSince: NOW - 60_000 })).toBeNull();
  });

  it('Two of my devices write at the same time: nothing', () => {
    expect(ownText({ ...base, problem: own(new PreconditionFailed('index.json')) })).toBeNull();
  });

  it('A friend\'s storage unreachable: "Updated 12 days ago"; after 3 months, keep or remove their content', () => {
    const down = friend(new NetworkError('x'));
    expect(friendText(down, NOW - 12 * DAY)).toBe('Updated 12 days ago');
    expect(friendText(down, NOW - 12 * DAY, 'fr')).toBe('Mis à jour il y a 12 jours');
    const stale = friendNote(down, NOW - FRIEND_STALE_MS, NOW);
    expect(stale).toMatchObject({ id: 'stale', action: 'keep-or-remove', tone: 'warning' });
    expect(friendText(down, NOW - 95 * DAY)).toBe('Updated 3 months ago. Léa’s storage no longer answers: keep their places or remove them?');
    expect(friendText(down, NOW - 95 * DAY, 'fr')).toBe('Mis à jour il y a 3 mois. Le stockage de Léa ne répond plus : garder ses lieux ou les retirer ?');
    // "Keep": the offer comes back only 3 months later.
    expect(friendNote(down, NOW - 95 * DAY, NOW, NOW - 10 * DAY).id).toBe('updated-ago');
    expect(friendNote(down, NOW - 200 * DAY, NOW, NOW - 91 * DAY).id).toBe('stale');
    // Never for a friend read recently, nor for a problem that is not about reaching them.
    expect(friendNote(null, NOW - 95 * DAY, NOW).id).toBe('ok');
    expect(friendNote(friend(new SignatureError('x')), NOW - 95 * DAY, NOW).id).toBe('tampered');
    expect([T.en('sync.friend.keep'), T.en('sync.friend.remove')]).toEqual(['Keep their places', 'Remove their places']);
  });

  it('A friend changes storage: "Léa moved their content", no action', () => {
    expect(T.en('wn.moved', { name: 'Léa' })).toBe('Léa moved their content');
    expect(T.fr('wn.moved', { name: 'Léa' })).toMatch(/^Léa a déplacé/);
    // While the redirect is followed, the person's line stays a plain "Updated …".
    expect(friendNote({ ...friend(new NetworkError('x')), kind: 'moved' }, NOW - DAY, NOW).id).toBe('updated-ago');
  });

  it('Tampered content (invalid signature): "Léa\'s content could not be verified", with no technical detail', () => {
    const p = friend(new SignatureError('index: bad signature'));
    expect(p.kind).toBe('tampered');
    expect(friendText(p, NOW - DAY)).toBe('Léa’s content could not be verified');
    expect(friendText(p, NOW - DAY, 'fr')).toBe('Le contenu de Léa n’a pas pu être vérifié');
    expect(friendText(p, NOW)).not.toMatch(/signature|index/i);
  });

  it('Unsupported format version: "Update the app to see Léa\'s places"', () => {
    const p = friend(new UnsupportedVersionError('index' as never, 99 as never, [4] as never));
    expect(friendText(p, NOW - DAY)).toBe('Update the app to see Léa’s places');
    expect(friendText(p, NOW - DAY, 'fr')).toBe('Mettez l’app à jour pour voir les lieux de Léa');
  });

  it('Invalid invitation or list link: "This link no longer works" / "This list no longer exists", ask for a new link', () => {
    for (const e of [new SignatureError('not listed', 'NOT_LISTED'), new ExpiredError('expired')]) {
      const p = linkProblemOf(e);
      expect(isRetryable(p)).toBe(false); // so the screen adds "Ask for a new link"
      expect(T.en(`contacts.problem.${p}`)).toMatch(/^This link no longer works/);
    }
    expect(linkProblemOf(new SignatureError('forged', 'SIGNATURE'))).toBe('not-genuine');
    expect(T.en('contacts.problem.askNew')).toBe('Ask for a new link.');
    expect(T.en(goneKey('deleted'))).toBe('This list no longer exists.');
    expect(T.en(goneKey('link-dead'))).toBe('This link no longer works.');
    expect(T.fr(goneKey('link-dead'))).toBe('Ce lien ne fonctionne plus.');
    expect(T.en('sharing.gone.askNew')).toMatch(/new link/);
  });

  it('Answer opened after the invitation expired: never accepted automatically, "Léa answered after the invitation expired. Accept?"', () => {
    const v = answerSet([{ owner: 'ed25519:lea', created: NOW - DAY, openedAfterExpiry: true, location: 'https://lea.example/tl/' }], undefined);
    expect(v.rows[0]).toMatchObject({ accepted: false, confirm: true, warnings: ['after-expiry'] });
    expect(v.warnings).toEqual(['after-expiry']);
    expect(T.en('contacts.warning.after-expiry', { name: 'Léa' })).toBe('Léa answered after the invitation expired. Accept? Compare the safety code first.');
    expect(T.fr('contacts.warning.after-expiry', { name: 'Léa' })).toMatch(/^Léa a répondu après l’expiration/);
  });

  it('I change storage, or my sharing key changes: "Your pending invitations were cancelled; send new ones"', () => {
    expect(T.en('lost.cancelled')).toBe('Your pending invitations were cancelled; send new ones:');
    expect(T.fr('lost.cancelled')).toMatch(/invitations en attente ont été annulées/);
    expect(T.en('storage.move.cancelledList')).toMatch(/cancelled; send them a new link/);
  });

  it('An invitation record in the vault is invalid: nothing on screen, a line in the local log (no ids)', () => {
    const line = invitationsLogLine({ invalid: ['inv-secret-id'], revoked: [], expired: ['x', 'y'] }, NOW);
    expect(line).toMatch(/own invitations removed: 1 invalid, 0 by a device declared lost, 2 expired$/);
    expect(line).not.toMatch(/inv-secret-id/);
  });

  it('An invitation record cannot be listed yet: nothing', () => {
    // Nothing is dropped, so the pass reports nothing and no note is shown (sync test: kept, listed later).
    expect(ownText({ ...base })).toBeNull();
  });

  it('Map tiles unavailable: no message as long as the cache is sufficient, then the fallback address, "Map possibly less detailed"', () => {
    // The cache is MapLibre's own: only a load error it could not answer reaches the fallback.
    resetBaseMapSession();
    const fb = new BaseMapFallback(baseMapFor(false, { primary: 'https://tiles.openfreemap.org/styles/positron', fallbacks: ['https://mirror.example/styles/positron'] }));
    expect(baseMapNoteKey(fb.status())).toBeNull();
    expect(fb.error({})).toBe(true);
    expect(fb.current()).toBe('https://mirror.example/styles/positron');
    expect(T.en(baseMapNoteKey(fb.status())!)).toBe('Map possibly less detailed');
    expect(T.fr(baseMapNoteKey(fb.status())!)).toBe('Carte peut-être moins détaillée');
    // No address answers: a plain background, the places still shown.
    fb.styleError();
    expect(T.en(baseMapNoteKey(fb.status())!)).toBe('Map background unavailable for now: your places are still shown');
    expect(T.fr(baseMapNoteKey(fb.status())!)).toBe('Fond de carte indisponible pour le moment : vos lieux restent affichés');
    resetBaseMapSession();
  });

  it('OSM search or data unavailable: "Search unavailable, place the place on the map"', () => {
    expect(T.en(osmFailureKey('unavailable', 'search'))).toBe('Search unavailable: place the place on the map (long press, or drop a point at the center).');
    expect(T.fr(osmFailureKey('offline', 'search'))).toMatch(/^Recherche indisponible : placez le lieu sur la carte/);
    expect(osmFailureKey('busy', 'search')).toBe('osm.busy');
    // The nearby list falls back to the places saved on this device.
    expect(T.en(osmFailureKey('offline', 'nearby'))).toMatch(/Showing the places saved on this device/);
  });

  it('App not opened for a long time: nothing', () => {
    // At the next opening the pass runs; until it answers, the last success is shown, no warning.
    expect(ownText({ ...base, lastSuccess: NOW - 120 * DAY })).toBeNull();
  });

  it('Key missing from the phone\'s vault (system restore): blocked before any write, the recovery kit is asked', () => {
    const record = { owner: 'ed25519:me' } as never;
    expect(storedIdentityKind(null, { deviceKeys: null, sharingKey: null })).toBe('none');
    expect(storedIdentityKind(record, { deviceKeys: null, sharingKey: 'x' })).toBe('keys-missing');
    expect(storedIdentityKind(record, { deviceKeys: 'x', sharingKey: null })).toBe('keys-missing');
    expect(storedIdentityKind(record, { deviceKeys: 'x', sharingKey: 'y' })).toBe('present');
    expect(T.en('welcome.keysMissing.restore')).toBe('Restore with my recovery kit');
    expect(T.fr('welcome.keysMissing.help')).toMatch(/kit de secours/);
    // A device holding an older key than the published one: the same request, writes stopped.
    const n = ownNote({ ...base, state: 'blocked', problem: { ...own(new AuthError('x')), kind: 'needs-key' } }, true)!;
    expect(T.en(n.key)).toBe('Enter your recovery kit to keep syncing');
  });
});
