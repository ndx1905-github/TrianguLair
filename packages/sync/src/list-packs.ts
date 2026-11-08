// SPDX-License-Identifier: MPL-2.0
/**
 * The lists packs my next publication should hold (lists.ts explains the three ways a list is
 * shared). Pure and deterministic: the same local state gives the same bodies, so `OwnSync`
 * keeps a listed pack whose recipient set and body are unchanged instead of re-sealing it.
 *
 * Visibility rules: a private save never enters a list (data package) and is skipped again here;
 * friends only learn the membership of places they can read anyway; a link-only list carries only
 * public comments (its link can be forwarded, like a public list), and keeps closed places (data
 * package README, open question 8: only public lists drop them).
 */
import { formatKey, packHash, type SharingCert } from '@triangulair/crypto';
import type { Repository } from '@triangulair/data';
import { audienceOf, type Audience } from './audience.ts';
import { listsSeenBy, type Contact } from './contacts.ts';
import { featureFor, type OwnItem } from './features.ts';
import {
  LIST_PACK_CAPACITY,
  LIST_TOMBSTONE_MS,
  MAX_LISTS_PER_PACK,
  listKeyPair,
  listSecretOf,
  listsCollection,
  type ListDef,
} from './lists.ts';

export interface DesiredListPack {
  audience: Audience;
  body: Uint8Array;
  /** Hash of the body (with the audience fingerprint: what makes a listed pack reusable). */
  h: string;
  role: 'friends' | 'link' | 'tombstone';
  /** Lists in it. */
  lists: string[];
  /** Tombstone: kept until then even after the list leaves my trash. */
  until?: number;
}

const iso = (ms: number) => new Date(ms).toISOString();

export function desiredListPacks(input: {
  repo: Repository;
  items: readonly OwnItem[];
  myCert: SharingCert;
  contacts: readonly Contact[];
  author?: string;
  now: Date;
}): DesiredListPack[] {
  const { repo, items, myCert } = input;
  const bySave = new Map(items.map((i) => [i.saveId, i]));
  const out: DesiredListPack[] = [];
  const live = repo.lists();
  const shared = (listId: string) =>
    repo
      .listItems(listId)
      .map((s) => bySave.get(s))
      .filter((i): i is OwnItem => !!i && i.sharing !== 'private')
      .sort((a, b) => (a.placeId < b.placeId ? -1 : a.placeId > b.placeId ? 1 : 0));
  const def = (l: (typeof live)[number], ids: string[]): ListDef => ({
    id: l.id,
    name: l.name,
    ...(l.description && { description: l.description }),
    updated: iso(l.updatedAt),
    items: ids,
  });

  // 1. Friends with access: one pack per set of viewers.
  const viewers = new Map<string, string[]>(); // list id → viewer keys
  for (const c of input.contacts) for (const id of listsSeenBy(c.policy)) {
    let v = viewers.get(id);
    if (!v) viewers.set(id, (v = []));
    v.push(c.sharingCert.key);
  }
  const groups = new Map<string, { audience: Audience; defs: ListDef[] }>();
  for (const l of live) {
    const v = viewers.get(l.id);
    if (!v?.length) continue;
    const audience = audienceOf([myCert.key, ...v]);
    let g = groups.get(audience.fp);
    if (!g) groups.set(audience.fp, (g = { audience, defs: [] }));
    g.defs.push(def(l, shared(l.id).map((i) => i.placeId)));
  }
  for (const g of groups.values()) {
    for (let i = 0; i < g.defs.length; i += MAX_LISTS_PER_PACK) {
      const defs = g.defs.slice(i, i + MAX_LISTS_PER_PACK);
      const body = listsCollection(defs, []);
      out.push({ audience: g.audience, body, h: packHash(body), role: 'friends', lists: defs.map((d) => d.id) });
    }
  }

  // 2. Link-only lists with a link: the definition and the places, to the list key.
  for (const l of live) {
    if (l.visibility !== 'link') continue;
    const secret = listSecretOf(l.linkKey);
    if (!secret) continue;
    const audience = audienceOf([myCert.key, formatKey('x25519', listKeyPair(secret).publicKey)]);
    const its = shared(l.id);
    for (let i = 0; i === 0 || i < its.length; i += LIST_PACK_CAPACITY) {
      const part = its.slice(i, i + LIST_PACK_CAPACITY);
      const body = listsCollection([def(l, part.map((x) => x.placeId))], part.map((x) => featureFor(x, 'public')), input.author ? { author: input.author } : {});
      out.push({ audience, body, h: packHash(body), role: 'link', lists: [l.id] });
    }
  }

  // 3. Deleted link-only lists (still in my trash): a tombstone to their last key.
  const now = input.now.getTime();
  for (const l of repo.lists({ includeDeleted: true })) {
    if (l.deletedAt === null || l.visibility !== 'link') continue;
    const secret = listSecretOf(l.linkKey);
    if (!secret) continue;
    const until = l.deletedAt + LIST_TOMBSTONE_MS;
    if (until <= now) continue;
    const audience = audienceOf([myCert.key, formatKey('x25519', listKeyPair(secret).publicKey)]);
    const body = listsCollection([{ id: l.id, deleted: true, updated: iso(l.deletedAt), until: iso(until) }], []);
    out.push({ audience, body, h: packHash(body), role: 'tombstone', lists: [l.id], until });
  }
  return out;
}
