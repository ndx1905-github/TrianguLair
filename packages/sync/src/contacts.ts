// SPDX-License-Identifier: MPL-2.0
/**
 * Contacts and what each one can see, kept in the recovery vault so that all
 * my devices agree (spec "Recovery kit": friends' keys, last index seen,
 * groups and settings live in the vault).
 *
 * - The crypto records (`contacts`: sharing certificate, anchor, verified)
 *   are merged by `mergeVaults`.
 * - The two switches of each contact ("I see their places", "they see my
 *   places", spec "Asymmetric relationships") and the optional restriction
 *   to some lists live in the vault's free-form `app` part, under
 *   `triangulair_sync`, one entry per contact stamped with the time of the
 *   change and merged per contact (latest wins). `mergeVaults` keeps `app`
 *   from one side only, so `mergeBooks` merges this part itself. A removed
 *   contact keeps a `removed` entry so that a merge never brings it back.
 */
import {
  canonicalize,
  contactRecord,
  emptyVault,
  invitationFromRecord,
  mergeVaults,
  type IndexAnchor,
  type OwnerInvitation,
  type SharingCert,
  type SignedIndex,
  type VaultRecords,
} from '@triangulair/crypto';

/** What a contact may read: everything I share with friends, nothing, or only the places of some of my lists. */
export type SharePolicy = boolean | { lists: string[] };

export interface ContactPolicy {
  /** "They see my places" (and what). */
  share: SharePolicy;
  /** "I see their places". */
  follow: boolean;
  removed?: boolean;
  /** Time of the last change (ms), for the merge. */
  at: number;
}

export interface Contact {
  owner: string;
  sharingCert: SharingCert;
  anchor: IndexAnchor | undefined;
  verified: boolean;
  policy: ContactPolicy;
}

const APP_KEY = 'triangulair_sync';
const DEFAULT_POLICY: ContactPolicy = { share: false, follow: false, at: 0 };

type AppPart = { version: 1; contacts: Record<string, ContactPolicy> };

function appPart(r: VaultRecords): AppPart {
  const a = (r.app?.[APP_KEY] ?? null) as AppPart | null;
  return a && a.version === 1 && typeof a.contacts === 'object' ? a : { version: 1, contacts: {} };
}

function withApp(r: VaultRecords, part: AppPart): VaultRecords {
  return { ...r, app: { ...(r.app ?? {}), [APP_KEY]: part } };
}

function laterPolicy(a: ContactPolicy | undefined, b: ContactPolicy | undefined): ContactPolicy | undefined {
  if (!a) return b;
  if (!b) return a;
  if (a.at !== b.at) return a.at > b.at ? a : b;
  return canonicalize(a) >= canonicalize(b) ? a : b; // deterministic on both devices
}

/** Merges two copies of my vault records (crypto records by `mergeVaults`, contact policies per contact). */
export function mergeBooks(a: VaultRecords, b: VaultRecords): VaultRecords {
  const merged = mergeVaults(a, b);
  const pa = appPart(a).contacts;
  const pb = appPart(b).contacts;
  const contacts: Record<string, ContactPolicy> = {};
  for (const k of [...new Set([...Object.keys(pa), ...Object.keys(pb)])].sort()) contacts[k] = laterPolicy(pa[k], pb[k])!;
  return withApp(merged, { version: 1, contacts });
}

export function sameRecords(a: VaultRecords, b: VaultRecords): boolean {
  return canonicalize(a as never) === canonicalize(b as never);
}

/** Mutable view over my vault records (local copy). */
export class ContactBook {
  private r: VaultRecords;
  constructor(records: VaultRecords) {
    this.r = records;
  }
  static empty(owner: string): ContactBook {
    return new ContactBook(emptyVault(owner));
  }
  get records(): VaultRecords {
    return this.r;
  }
  set records(r: VaultRecords) {
    this.r = r;
  }

  policy(owner: string): ContactPolicy {
    return appPart(this.r).contacts[owner] ?? DEFAULT_POLICY;
  }

  /** Live contacts (not removed). */
  contacts(): Contact[] {
    const pol = appPart(this.r).contacts;
    return this.r.contacts
      .filter((c) => !pol[c.owner]?.removed)
      .map((c) => ({ owner: c.owner, sharingCert: c.sharing_cert, anchor: c.anchor, verified: c.verified, policy: pol[c.owner] ?? DEFAULT_POLICY }));
  }

  contact(owner: string): Contact | undefined {
    return this.contacts().find((c) => c.owner === owner);
  }

  /** People I follow (their storage is read). */
  following(): Contact[] {
    return this.contacts().filter((c) => c.policy.follow);
  }

  /**
   * Adds (or refreshes) a contact from their verified index (read at their
   * certified address, e.g. after accepting a return link or an invitation),
   * with the switches given.
   */
  addContact(index: SignedIndex, policy: { share?: SharePolicy; follow?: boolean; verified?: boolean }, now = Date.now()): void {
    const rec = contactRecord(index, policy.verified ?? false);
    const others = this.r.contacts.filter((c) => c.owner !== rec.owner);
    const prev = this.r.contacts.find((c) => c.owner === rec.owner);
    const merged = prev ? mergeVaults({ ...this.r, contacts: [prev] }, { ...this.r, contacts: [rec] }).contacts : [rec];
    this.r = { ...this.r, contacts: [...others, ...merged].sort((a, b) => (a.owner < b.owner ? -1 : 1)) };
    const cur = this.policy(rec.owner);
    this.setPolicy(rec.owner, { share: policy.share ?? (cur.removed ? false : cur.share), follow: policy.follow ?? (cur.removed ? false : cur.follow), removed: false }, now);
  }

  /** Records a newer verified index of a contact (anchor and sharing certificate move forward only). */
  noteIndex(index: SignedIndex): void {
    const rec = contactRecord(index);
    const prev = this.r.contacts.find((c) => c.owner === rec.owner);
    if (!prev) return;
    const merged = mergeVaults({ ...this.r, contacts: [prev] }, { ...this.r, contacts: [{ ...rec, verified: prev.verified }] }).contacts[0]!;
    this.r = { ...this.r, contacts: this.r.contacts.map((c) => (c.owner === rec.owner ? merged : c)) };
  }

  setPolicy(owner: string, patch: Partial<Omit<ContactPolicy, 'at'>>, now = Date.now()): void {
    const part = appPart(this.r);
    const cur = part.contacts[owner] ?? DEFAULT_POLICY;
    const next: ContactPolicy = { share: patch.share ?? cur.share, follow: patch.follow ?? cur.follow, at: Math.max(now, cur.at + 1) };
    if (patch.removed ?? cur.removed) next.removed = true;
    this.r = withApp(this.r, { version: 1, contacts: { ...part.contacts, [owner]: next } });
  }

  /** Removes a contact: they no longer see my places and I stop reading theirs (spec "Remove a friend"). */
  remove(owner: string, now = Date.now()): void {
    this.setPolicy(owner, { share: false, follow: false, removed: true }, now);
  }

  /** The owner's invitations from the vault (records that do not verify are skipped). */
  invitations(): { invitation: OwnerInvitation; accepted?: string }[] {
    const out: { invitation: OwnerInvitation; accepted?: string }[] = [];
    for (const rec of this.r.invitations) {
      try {
        const x = invitationFromRecord(rec, this.r.owner);
        out.push(x.accepted !== undefined ? { invitation: x.invitation, accepted: x.accepted } : { invitation: x.invitation });
      } catch {
        // invalid record: signIndex would skip it as "invalid"; T-208 drops it from the vault
      }
    }
    return out;
  }

  retiredOwners(): string[] {
    return [...this.r.retired_owners];
  }
}
