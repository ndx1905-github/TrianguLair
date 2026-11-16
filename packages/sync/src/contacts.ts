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
} from '@triangulair/crypto';

/** What a contact may read: everything I share with friends, nothing, or only the places of some of my lists. */
export type SharePolicy = boolean | { lists: string[] };

export interface ContactPolicy {
  /** "They see my places" (and what). */
  share: SharePolicy;
  /** "I see their places". */
  follow: boolean;
  removed?: boolean;
  /**
   * Lists whose definition (name, description, membership) this contact also receives, besides
   * those of a `share: { lists }` restriction (which always come with it): the "pick who" of a
   * list's share sheet, for a contact who sees everything I share with friends. Only used while
   * `share` is true (review M-01): a restricted contact sees exactly the lists of the restriction,
   * and `setPolicy` drops the picks whenever `share` changes, so a stale pick never comes back.
   */
  lists?: string[];
  /** Time of the last change (ms), for the merge. */
  at: number;
}

/**
 * The lists a contact sees the definition of: those of a "some lists" restriction, or, for a
 * contact who sees everything, the ones picked in a list's share sheet (never both: M-01).
 */
export function listsSeenBy(p: ContactPolicy): string[] {
  if (p.removed || p.share === false) return [];
  return [...new Set(p.share === true ? (p.lists ?? []) : p.share.lists)].sort();
}

const sameShare = (a: SharePolicy, b: SharePolicy): boolean =>
  typeof a === 'boolean' || typeof b === 'boolean' ? a === b : canonicalize([...new Set(a.lists)].sort() as never) === canonicalize([...new Set(b.lists)].sort() as never);

/**
 * A list followed by its link (spec "Following a list without following the person"), kept in the
 * vault so that all my devices follow it: the link fragment (it holds the list key of a link-only
 * list) and the time of the change. An unfollowed list keeps only `{ at, removed: true }` (never
 * its link, so the vault does not keep the list's key: review L-02) so that a merge never brings
 * it back, for FOLLOWED_REMOVED_KEEP_MS; then the entry is dropped.
 */
export interface FollowedListEntry {
  link?: string;
  at: number;
  removed?: boolean;
}

/** At most this many lists followed by link (review L-02, L-07). */
export const MAX_FOLLOWED_LISTS = 200;
/** An unfollowed list's entry stays this long (like the tombstones), then it is dropped. */
export const FOLLOWED_REMOVED_KEEP_MS = 180 * 24 * 3600 * 1000;

export class TooManyFollowedListsError extends Error {
  constructor() {
    super(`you already follow ${MAX_FOLLOWED_LISTS} lists`);
    this.name = 'TooManyFollowedListsError';
  }
}

/** The stored form of an entry: a removed one never keeps its link. */
function cleanEntry(e: FollowedListEntry): FollowedListEntry {
  return e.removed ? { at: e.at, removed: true } : e;
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
type AppPart = { version: 1; contacts: Record<string, ContactPolicy>; own?: IndexAnchor; lists?: Record<string, FollowedListEntry> };

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

function laterEntry<T extends { at: number }>(a: T | undefined, b: T | undefined): T | undefined {
  if (!a) return b;
  if (!b) return a;
  if (a.at !== b.at) return a.at > b.at ? a : b;
  return canonicalize(a as never) >= canonicalize(b as never) ? a : b;
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
  const own = laterAnchor(checkedOwnAnchor(appPart(a).own, a.owner), checkedOwnAnchor(appPart(b).own, a.owner));
  const la = appPart(a).lists ?? {};
  const lb = appPart(b).lists ?? {};
  const lists: Record<string, FollowedListEntry> = {};
  for (const k of [...new Set([...Object.keys(la), ...Object.keys(lb)])].sort()) lists[k] = cleanEntry(laterEntry(la[k], lb[k])!);
  return withApp(merged, { version: 1, contacts, ...(own && { own }), ...(Object.keys(lists).length && { lists }) });
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
    // The picks only mean something for a contact who sees everything, and only for the scope they
    // were made in: a change of scope drops them (M-01).
    const kept = patch.share === undefined || sameShare(patch.share, cur.share) ? cur.lists : undefined;
    const lists = [...new Set(patch.lists ?? kept ?? [])].sort();
    if (lists.length && !next.removed && next.share === true) next.lists = lists;
    this.r = withApp(this.r, { ...part, contacts: { ...part.contacts, [owner]: next } });
  }

  /** Owners of the live contacts who receive the definition of `listId`. */
  listViewers(listId: string): string[] {
    return this.contacts().filter((c) => listsSeenBy(c.policy).includes(listId)).map((c) => c.owner);
  }

  /**
   * Gives or takes a contact's access to one list ("pick who" in the list's share sheet):
   * a contact who sees nothing gets `share: { lists: [id] }` (the list's places and definition); a
   * contact restricted to some lists gets it added or removed (none left = nothing); a contact who
   * sees everything keeps that and receives or stops receiving the list's definition.
   */
  setListAccess(owner: string, listId: string, on: boolean, now = Date.now()): void {
    const p = this.policy(owner);
    if (p.removed) return;
    if (p.share === true) {
      const lists = new Set(p.lists ?? []);
      if (on) lists.add(listId);
      else lists.delete(listId);
      this.setPolicy(owner, { lists: [...lists] }, now);
      return;
    }
    const cur = new Set(p.share === false ? [] : p.share.lists);
    if (on) cur.add(listId);
    else cur.delete(listId);
    this.setPolicy(owner, { share: cur.size ? { lists: [...cur].sort() } : false }, now);
  }

  // ---------------------------------------------------------------- followed lists

  /** Lists I follow by link (not unfollowed), by followed-list id, oldest first (at most MAX_FOLLOWED_LISTS). */
  followedLists(): { id: string; link: string; at: number }[] {
    const l = appPart(this.r).lists ?? {};
    return Object.entries(l)
      .flatMap(([id, e]) => (!e.removed && typeof e.link === 'string' ? [{ id, link: e.link, at: e.at }] : []))
      .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))
      .slice(0, MAX_FOLLOWED_LISTS);
  }

  /** Follows a list (throws TooManyFollowedListsError beyond MAX_FOLLOWED_LISTS). */
  followList(id: string, link: string, now = Date.now()): void {
    const part = appPart(this.r);
    const cur = part.lists?.[id];
    const live = this.followedLists();
    if (!live.some((e) => e.id === id) && live.length >= MAX_FOLLOWED_LISTS) throw new TooManyFollowedListsError();
    const lists = { ...this.prunedLists(now), [id]: { link, at: Math.max(now, (cur?.at ?? 0) + 1) } };
    this.r = withApp(this.r, { ...part, lists });
  }

  /** Unfollows a list: only `{ at, removed }` is kept (no link, no list key). */
  unfollowList(id: string, now = Date.now()): void {
    const part = appPart(this.r);
    const cur = part.lists?.[id];
    if (!cur) return;
    const lists = { ...this.prunedLists(now), [id]: { at: Math.max(now, cur.at + 1), removed: true } };
    this.r = withApp(this.r, { ...part, lists });
  }

  /**
   * Drops the entries of lists unfollowed more than FOLLOWED_REMOVED_KEEP_MS ago, and the link of
   * any removed entry (vaults written by older code kept it). Returns whether anything changed.
   */
  pruneFollowedLists(now = Date.now()): boolean {
    const part = appPart(this.r);
    if (!part.lists) return false;
    const lists = this.prunedLists(now);
    if (canonicalize(lists as never) === canonicalize(part.lists as never)) return false;
    const { lists: _old, ...rest } = part;
    this.r = withApp(this.r, Object.keys(lists).length ? { ...rest, lists } : rest);
    return true;
  }

  private prunedLists(now: number): Record<string, FollowedListEntry> {
    const out: Record<string, FollowedListEntry> = {};
    for (const [id, e] of Object.entries(appPart(this.r).lists ?? {})) {
      if (e.removed && e.at < now - FOLLOWED_REMOVED_KEEP_MS) continue;
      out[id] = cleanEntry(e);
    }
    return out;
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
