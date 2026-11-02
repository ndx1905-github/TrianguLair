import { describe, expect, it } from 'vitest';
import {
  decodePrimaryIdentity,
  fromB64Url,
  identityFromPhrase,
  openSharingKey,
  ready,
  verifyDeviceCert,
  verifySharingCert,
} from '@triangulair/crypto';

import { translate } from '../i18n/core';
import { en } from '../i18n/en';
import { fr } from '../i18n/fr';
import { checkStoredIdentity, createIdentity, parseDeviceKeys, parseIdentityRecord, primaryFromPhrase } from './create';
import {
  checkWords,
  clipboardFields,
  keyFingerprint,
  kitEntry,
  passwordManagerText,
  phraseWords,
  pickCheckIndexes,
  printableKitHtml,
  type KitInput,
} from './kit';
import { defaultLockSettings, hashCode, isValidCode, lockoutMs, parseLockSettings, shouldLockOnReturn, verifyCode } from './lock';
import { PROTECT_AFTER_MS, PROTECT_SNOOZE_MS, protectState } from './protect';

const tEn = (k: string, p?: Record<string, string | number>) => translate('en', en, en, k, p);
const tFr = (k: string, p?: Record<string, string | number>) => translate('fr', fr, en, k, p);

// A fixed, valid BIP39 phrase (test only).
const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

await ready();

describe('identity creation', () => {
  it('creates a full identity from a new 12-word phrase', () => {
    const c = createIdentity({ primary: true, now: 1_000 });
    expect(phraseWords(c.phrase)).toHaveLength(12);
    const fromPhrase = identityFromPhrase(c.phrase);
    expect(c.record.owner).toBe(fromPhrase.owner);
    expect(c.record).toMatchObject({ version: 1, createdAt: 1_000, primary: true, kitSavedAt: null });

    // The device certificate is master-signed and names this device's keys.
    const device = parseDeviceKeys(c.secrets.deviceKeys);
    expect(device.id).toBe(c.record.deviceId);
    const cert = verifyDeviceCert(c.record.deviceCert, { expectedOwner: c.record.owner });
    expect(cert.device).toBe(device.id);

    // The sealed sharing key opens with the device keys only, with a random vault data key.
    const sharing = openSharingKey(fromB64Url(c.secrets.sharingKey), device, { expectedOwner: c.record.owner });
    const sc = verifySharingCert(sharing.cert, { expectedOwner: c.record.owner });
    expect(sc.cert.rotation).toBe(0);
    expect(sc.cert.location).toBeUndefined(); // local-only: no read address
    expect(sharing.vaultDataKey).toHaveLength(32);

    // The vault copy opens with the phrase.
    const viaPhrase = openSharingKey(c.vaultCopy, fromPhrase);
    expect(viaPhrase.cert).toEqual(sharing.cert);

    // Primary device: the master key comes back from the stored blob.
    expect(decodePrimaryIdentity(fromB64Url(c.secrets.primaryIdentity!)).owner).toBe(c.record.owner);
    expect(checkStoredIdentity(c.record, c.secrets).device.id).toBe(device.id);
  });

  it('keeps no master key on an ordinary device, and no phrase in what is stored', () => {
    const c = createIdentity({ primary: false, phrase: PHRASE });
    expect(c.secrets.primaryIdentity).toBeNull();
    const stored = JSON.stringify([c.record, c.secrets]);
    for (const w of new Set(phraseWords(PHRASE))) expect(stored).not.toContain(` ${w} `);
    expect(stored).not.toContain(PHRASE);
    expect(() => checkStoredIdentity(c.record, c.secrets)).not.toThrow();
  });

  it('gives different device and sharing keys for the same phrase (random, not derived)', () => {
    const a = createIdentity({ primary: false, phrase: PHRASE });
    const b = createIdentity({ primary: false, phrase: PHRASE });
    expect(a.record.owner).toBe(b.record.owner);
    expect(a.record.deviceId).not.toBe(b.record.deviceId);
    expect(a.secrets.sharingKey).not.toBe(b.secrets.sharingKey);
  });

  it('refuses mixed-up secrets', () => {
    const a = createIdentity({ primary: true });
    const b = createIdentity({ primary: true });
    expect(() => checkStoredIdentity(a.record, { ...a.secrets, deviceKeys: b.secrets.deviceKeys })).toThrow();
    expect(() => checkStoredIdentity(a.record, { ...a.secrets, sharingKey: b.secrets.sharingKey })).toThrow();
    expect(() => checkStoredIdentity(a.record, { ...a.secrets, primaryIdentity: b.secrets.primaryIdentity })).toThrow(/another owner/);
  });

  it('turns the primary device back on only with the right phrase', () => {
    const c = createIdentity({ primary: false, phrase: PHRASE });
    expect(decodePrimaryIdentity(fromB64Url(primaryFromPhrase(` ${PHRASE.toUpperCase()} `, c.record.owner))).owner).toBe(c.record.owner);
    const other = createIdentity({ primary: false });
    expect(() => primaryFromPhrase(other.phrase, c.record.owner)).toThrow('phrase-mismatch');
  });

  it('parses stored records defensively', () => {
    const c = createIdentity({ primary: true });
    expect(parseIdentityRecord(JSON.stringify(c.record))).toEqual(c.record);
    expect(parseIdentityRecord(null)).toBeNull();
    expect(parseIdentityRecord('{')).toBeNull();
    expect(parseIdentityRecord(JSON.stringify({ ...c.record, version: 2 }))).toBeNull();
    expect(parseIdentityRecord(JSON.stringify({ ...c.record, owner: 'local-me' }))).toBeNull();
  });
});

describe('recovery kit', () => {
  const owner = identityFromPhrase(PHRASE).owner;
  const kit: KitInput = { phrase: PHRASE, owner, readAddress: null, protocol: null, name: ' Alex ', date: new Date(Date.UTC(2026, 10, 2)) };

  it('fingerprints the owner key in 8 groups of 4', () => {
    expect(keyFingerprint(owner)).toMatch(/^([0-9A-F]{4} ){7}[0-9A-F]{4}$/);
  });

  it('formats the password manager entry (local only)', () => {
    const e = kitEntry(kit, tEn);
    expect(e.title).toBe('TrianguLair – Alex');
    expect(e.password).toBe(PHRASE);
    expect(e.url).toBe('');
    expect(e.notes.split('\n')).toEqual([
      `Key fingerprint: ${keyFingerprint(owner)}`,
      'Protocol: local only, no storage yet',
      tEn('kit.localOnlyNote'),
      tEn('kit.entryHelp'),
    ]);
    const text = passwordManagerText(e, tEn);
    expect(text.split('\n').slice(0, 4)).toEqual(['Title: TrianguLair – Alex', `Password: ${PHRASE}`, 'URL: —', 'Notes: ']);
    expect(clipboardFields(e, tEn).map((f) => f.key)).toEqual(['phrase', 'notes']);
  });

  it('puts the storage address in the URL field once there is one', () => {
    const e = kitEntry({ ...kit, readAddress: 'https://cloud.example.org/s/abc', protocol: 'Nextcloud', name: '' }, tFr);
    expect(e.title).toBe('Kit de récupération TrianguLair');
    expect(e.url).toBe('https://cloud.example.org/s/abc');
    expect(e.notes).toContain('Protocole : Nextcloud');
    expect(e.notes).not.toContain(tFr('kit.localOnlyNote'));
    expect(clipboardFields(e, tFr).map((f) => f.key)).toEqual(['phrase', 'address', 'notes']);
  });

  it('makes a printable page with the numbered words, escaped', () => {
    const html = printableKitHtml({ ...kit, name: '<b>Léa</b>' }, tEn, 'en');
    const words = [...html.matchAll(/<li><span class="n">(\d+)<\/span><span class="w">([a-z]+)<\/span><\/li>/g)];
    expect(words.map((m) => m[2]).join(' ')).toBe(PHRASE);
    expect(words.map((m) => m[1])).toEqual(Array.from({ length: 12 }, (_, i) => String(i + 1)));
    expect(html).toContain('&lt;b&gt;Léa&lt;/b&gt;');
    expect(html).not.toContain('<b>Léa');
    expect(html).toContain('November 2, 2026');
    expect(html).toContain(tEn('kit.localOnlyNote'));
    expect(html).not.toMatch(/https?:\/\//); // no external resource
  });

  it('asks 3 distinct words and checks them leniently', () => {
    let n = 0;
    const seq = [0.99, 0, 0.5];
    const idx = pickCheckIndexes(() => seq[n++]!);
    expect(idx).toHaveLength(3);
    expect(new Set(idx).size).toBe(3);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    for (let i = 0; i < 50; i++) expect(new Set(pickCheckIndexes()).size).toBe(3);
    const words = phraseWords(PHRASE);
    expect(checkWords(PHRASE, [0, 5, 11], [' LEGAL ', words[5]!, 'yellow'])).toEqual([true, true, true]);
    expect(checkWords(PHRASE, [0, 5, 11], ['legal', '', 'winner'])).toEqual([true, false, false]);
  });
});

describe('app lock rules', () => {
  it('is on by default only without a screen lock', () => {
    expect(defaultLockSettings('none')).toMatchObject({ enabled: true, method: 'code' });
    expect(defaultLockSettings('passcode')).toMatchObject({ enabled: false, method: 'device' });
    expect(defaultLockSettings('biometric')).toMatchObject({ enabled: false, method: 'device' });
    expect(defaultLockSettings('unknown')).toMatchObject({ enabled: false, method: 'code' });
    expect(defaultLockSettings('none').delayMs).toBe(5 * 60_000);
  });

  it('locks on return after the delay', () => {
    const s = { enabled: true, method: 'code' as const, delayMs: 60_000 };
    expect(shouldLockOnReturn(s, 0, 59_999)).toBe(false);
    expect(shouldLockOnReturn(s, 0, 60_000)).toBe(true);
    expect(shouldLockOnReturn({ ...s, enabled: false }, 0, 1e9)).toBe(false);
    expect(shouldLockOnReturn(s, null, 1e9)).toBe(false);
  });

  it('validates, hashes and checks codes, with a growing wait', async () => {
    expect(isValidCode('1234')).toBe(true);
    expect(isValidCode('123')).toBe(false);
    expect(isValidCode('12a4')).toBe(false);
    const h = await hashCode('2468');
    expect(h).not.toContain('2468');
    expect(await verifyCode('2468', h)).toBe(true);
    expect(await verifyCode('2469', h)).toBe(false);
    expect(await verifyCode('2468', null)).toBe(false);
    expect(await hashCode('2468')).not.toBe(h); // salted
    expect([4, 5, 6, 20].map(lockoutMs)).toEqual([0, 30_000, 60_000, 15 * 60_000]);
    expect(parseLockSettings('{"enabled":true,"method":"x","delayMs":0}')).toBeNull();
    expect(parseLockSettings('{"enabled":true,"method":"code","delayMs":-5}')).toEqual({ enabled: true, method: 'code', delayMs: 0 });
  });
});

describe('"Protect your places" card', () => {
  const base = { kitSaved: false, myPlaces: 0, createdAt: 0, now: 1000, snoozedAt: null };
  it('waits for something to lose, then shows until the kit is saved', () => {
    expect(protectState(base)).toBe('none');
    expect(protectState({ ...base, myPlaces: 10 })).toBe('card');
    expect(protectState({ ...base, now: PROTECT_AFTER_MS })).toBe('card');
    expect(protectState({ ...base, myPlaces: 50, kitSaved: true })).toBe('none');
  });
  it('becomes a discreet reminder after "Later", then comes back', () => {
    const due = { ...base, myPlaces: 12, now: 10 * 86_400_000 };
    expect(protectState({ ...due, snoozedAt: due.now - 1 })).toBe('reminder');
    expect(protectState({ ...due, snoozedAt: due.now - PROTECT_SNOOZE_MS })).toBe('card');
  });
});
