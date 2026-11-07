// SPDX-License-Identifier: MPL-2.0
/**
 * Who can read each of my saves (spec "Sharing a place", "Encrypted sharing",
 * "Invitation link and return link"):
 *
 * - a private save never leaves my devices (it is only in my own document);
 * - a save shared with friends is readable by every contact whose "they see
 *   my places" switch is on, or, for a contact restricted to some lists, if
 *   the save is in one of those lists;
 * - and by every open invitation that is listed in my index and not yet
 *   accepted (the invitee sees what I share with friends right away; the
 *   access ends at acceptance or expiry, which changes the recipient set and
 *   therefore re-encrypts the packs with new keys);
 * - always by my own sharing key, so that my other devices can open, check
 *   and re-encrypt every pack.
 *
 * The recipient set is identified by a fingerprint (hash of the sorted
 * public keys); it is only ever written in my own manifest pack, never in a
 * pack that friends read (they must not learn who else reads it).
 */
import { MAX_WRAPS, invitationStatus, packHash, parseKey, type OwnerInvitation, type SharingCert } from '@triangulair/crypto';
import { formatKey } from '@triangulair/crypto';
import type { Contact } from './contacts.ts';
import { TooManyRecipientsError } from './errors.ts';
import type { OwnItem } from './features.ts';
import { utf8 } from './payload.ts';

export interface Audience {
  /** "x25519:…" keys, sorted, my own first is not guaranteed. */
  keys: string[];
  fp: string;
}

export function fingerprint(keys: readonly string[]): string {
  return packHash(utf8([...new Set(keys)].sort().join('\n')));
}

export function audienceOf(keys: Iterable<string>): Audience {
  const sorted = [...new Set(keys)].sort();
  if (sorted.length > MAX_WRAPS) throw new TooManyRecipientsError(sorted.length);
  return { keys: sorted, fp: fingerprint(sorted) };
}

export function recipientBytes(a: Audience): Uint8Array[] {
  return a.keys.map((k) => parseKey('x25519', k, 'recipient'));
}

export interface AudienceInput {
  myCert: SharingCert;
  contacts: readonly Contact[];
  invitations: readonly { invitation: OwnerInvitation; accepted?: string }[];
  /** list id → save ids of that list (only lists named by a restricted contact are needed). */
  listItems: (listId: string) => readonly string[];
  now?: Date;
}

/** Recipient set of each shared item (private items are absent). */
export function computeAudiences(items: readonly OwnItem[], input: AudienceInput): Map<string, Audience> {
  const all = new Set<string>([input.myCert.key]);
  const restricted: { key: string; saves: Set<string> }[] = [];
  for (const c of input.contacts) {
    const s = c.policy.share;
    if (c.policy.removed || s === false) continue;
    if (s === true) all.add(c.sharingCert.key);
    else restricted.push({ key: c.sharingCert.key, saves: new Set(s.lists.flatMap((l) => [...input.listItems(l)])) });
  }
  for (const { invitation, accepted } of input.invitations) {
    if (accepted !== undefined) continue;
    if (invitationStatus(invitation, input.myCert, input.now) !== 'listed') continue;
    all.add(formatKey('x25519', invitation.keyPair.publicKey));
  }
  const base = audienceOf(all);
  const cache = new Map<string, Audience>([[base.keys.join(','), base]]);
  const out = new Map<string, Audience>();
  for (const it of items) {
    if (it.sharing === 'private') continue;
    let a = base;
    const extra = restricted.filter((r) => r.saves.has(it.saveId)).map((r) => r.key);
    if (extra.length) {
      const keys = [...new Set([...base.keys, ...extra])].sort();
      const k = keys.join(',');
      a = cache.get(k) ?? audienceOf(keys);
      cache.set(k, a);
    }
    out.set(it.placeId, a);
  }
  return out;
}
