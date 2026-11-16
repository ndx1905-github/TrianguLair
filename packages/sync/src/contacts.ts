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
  verifySharingCert,
  contactRecord,
  emptyVault,
  invitationFromRecord,
  invitationRecord,
  mergeVaults,
  type IndexAnchor,
  type OwnerInvitation,
  type SharingCert,
  type SignedIndex,
  type VaultRecords,
  type DeviceCert,
} from '@triangulair/crypto';
import {
  devicesOf,
  dropSigners,
  markDevicesRemoved,
  mergeDeviceParts,
  putDeviceCert,
  putDeviceInfo,
  resetValues,
  setValue,
  valueOf,
  type DeviceEntry,
  type EntrySigner,
  type TrustContext,
} from './devices.ts';

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

/**
 * `own`: the last index of mine that a device of mine accepted or published
 * (rotation, seq, hash), so that a device restored from the recovery kit,
 * which has no local anchor yet, does not trust whatever index the storage
 * serves first (T-204 review R-01). Written lazily (when the rotation changes,
 * or every OWN_ANCHOR_STEP publications) so it does not cost a vault write
 * per publication; it is a floor, never ahead of the truth.
 */
type AppPart = { version: 1; contacts: Record<string, ContactPolicy>; own?: IndexAnchor };

/** The vault's own anchor is rewritten after this many publications (or at a rotation). */
export const OWN_ANCHOR_STEP = 16;

const HASH_RE = /^b2b256:[A-Za-z0-9_-]{43}$/;

function appPart(r: VaultRecords): AppPart {
  const a = (r.app?.[APP_KEY] ?? null) as AppPart | null;
  return a && a.version === 1 && typeof a.contacts === 'object' ? a : { version: 1, contacts: {} };
}

/** A well-formed anchor of `owner`'s index (its certificate is master-signed), or undefined. */
function checkedOwnAnchor(a: unknown, owner: string): IndexAnchor | undefined {
  const x = a as IndexAnchor | undefined;
  if (!x || typeof x !== 'object' || x.type !== 'index-anchor' || x.owner !== owner) return undefined;
  if (!Number.isSafeInteger(x.seq) || x.seq < 0 || !Number.isSafeInteger(x.version) || typeof x.hash !== 'string' || !HASH_RE.test(x.hash)) return undefined;
  try {
    verifySharingCert(x.sharing_cert as never, { expectedOwner: owner });
  } catch {
    return undefined;
  }
  return x;
}

/** The later of two anchors of mine: higher rotation first, then higher seq. */
export function laterAnchor(a: IndexAnchor | undefined, b: IndexAnchor | undefined): IndexAnchor | undefined {
  if (!a) return b;
  if (!b) return a;
  if (b.sharing_cert.rotation !== a.sharing_cert.rotation) return b.sharing_cert.rotation > a.sharing_cert.rotation ? b : a;
  return b.seq >= a.seq ? b : a;
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

/**
 * Merges two copies of my vault records (crypto records by `mergeVaults`, contact policies per
 * contact, my devices and app values by `mergeDeviceParts`; `ctx`: the current certificate's
 * revocations and the clock, see devices.ts).
 */
export function mergeBooks(a: VaultRecords, b: VaultRecords, ctx: TrustContext = {}): VaultRecords {
  const merged = mergeVaults(a, b);
  const pa = appPart(a).contacts;
  const pb = appPart(b).contacts;
  const contacts: Record<string, ContactPolicy> = {};
  for (const k of [...new Set([...Object.keys(pa), ...Object.keys(pb)])].sort()) contacts[k] = laterPolicy(pa[k], pb[k])!;
  const own = laterAnchor(checkedOwnAnchor(appPart(a).own, a.owner), checkedOwnAnchor(appPart(b).own, a.owner));
  return mergeDeviceParts(withApp(merged, { version: 1, contacts, ...(own && { own }) }), a, b, ctx);
}

/**
 * Whether `local` holds nothing that `remote` (the vault on the storage)
 * lacks. My own anchor only counts when it moved to another rotation or by
 * OWN_ANCHOR_STEP publications (see AppPart).
 */
export function sameRecords(local: VaultRecords, remote: VaultRecords): boolean {
  const lo = appPart(local).own;
  const ro = appPart(remote).own;
  let l = local;
  if (lo && ro && lo.sharing_cert.rotation === ro.sharing_cert.rotation && lo.seq - ro.seq < OWN_ANCHOR_STEP && lo.seq >= ro.seq) {
    l = withApp(local, { ...appPart(local), own: ro });
  }
  return canonicalize(l as never) === canonicalize(remote as never);
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

  /**
   * Records an invitation created on this device (`createInvitation`) in the
   * vault, so that every index lists it until expiry and its key reads what I
   * share with friends until it is accepted. Publish before sending the link.
   */
  addInvitation(invitation: OwnerInvitation): void {
    const rec = invitationRecord(invitation);
    this.r = { ...this.r, invitations: [...this.r.invitations.filter((i) => i.id !== rec.id), rec].sort((a, b) => (a.id < b.id ? -1 : 1)) };
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

  /**
   * A friend moved to a new identity (spec "Loss and theft", theft of the primary device): `index`
   * is the new identity's index, verified with `expectedOwner = to` and `from` retired. `from` is
   * retired for good (everything it signs later is refused), the contact continues under `to` with
   * the same switches, and is no longer verified (the safety code must be compared again).
   */
  followMove(from: string, index: SignedIndex, now = Date.now()): void {
    if (index.owner === from) throw new Error('followMove: same identity');
    const old = this.policy(from);
    this.r = { ...this.r, retired_owners: [...new Set([...this.r.retired_owners, from])].sort() };
    this.addContact(index, { share: old.removed ? false : old.share, follow: old.removed ? false : old.follow, verified: false }, now);
    this.remove(from, now);
  }

  // ------------------------------------------------------------------ my devices (devices.ts)

  /** My devices whose certificate verifies; `removed` for those `ctx.revoked` lists (devices.ts). */
  devices(ctx: TrustContext = {}): DeviceEntry[] {
    return devicesOf(this.r, ctx);
  }

  /** Lists a master-signed device certificate (throws when it is not mine). */
  putDeviceCert(cert: DeviceCert): void {
    this.r = putDeviceCert(this.r, cert);
  }

  /** `signer`'s display entry for a listed device (name, date added, primary mark for itself). */
  putDeviceInfo(id: string, patch: { name?: string; added?: number; primary?: boolean }, signer: EntrySigner, now = Date.now(), ctx: TrustContext = {}): void {
    this.r = putDeviceInfo(this.r, id, patch, signer, now, ctx);
  }

  /** Display only: when these (revoked) devices were removed. */
  markDevicesRemoved(ids: readonly string[], now = Date.now()): void {
    this.r = markDevicesRemoved(this.r, ids, now);
  }

  value<T>(key: string, ctx: TrustContext = {}): { value: T; at: number; by: string } | undefined {
    return valueOf<T>(this.r, key, ctx);
  }

  setValue(key: string, value: unknown, signer: EntrySigner, now = Date.now(), ctx: TrustContext = {}): void {
    this.r = setValue(this.r, key, value, signer, now, ctx);
  }

  /** Declaration of loss: forget what the revoked devices signed, values reset to the declaring device's. */
  dropSigners(ids: Iterable<string>): void {
    this.r = dropSigners(this.r, ids);
  }

  resetValues(values: Record<string, unknown>, signer: EntrySigner, now = Date.now()): void {
    this.r = resetValues(this.r, values, signer, now);
  }

  /** My own anchor recorded in the vault (checked; undefined when absent or malformed). */
  ownAnchor(): IndexAnchor | undefined {
    return checkedOwnAnchor(appPart(this.r).own, this.r.owner);
  }

  /** Records my latest own anchor (it only moves forward). */
  noteOwnAnchor(a: IndexAnchor): void {
    const part = appPart(this.r);
    const own = laterAnchor(checkedOwnAnchor(part.own, this.r.owner), a)!;
    this.r = withApp(this.r, { ...part, own: JSON.parse(JSON.stringify(own)) as IndexAnchor });
  }
}
