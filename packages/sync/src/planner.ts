// SPDX-License-Identifier: MPL-2.0
/**
 * Incremental pack planning (pure). Items with identical recipient sets are
 * grouped (spec "Encrypted sharing": items that have exactly the same
 * recipients share a pack key); each group is cut into packs of at most
 * `capacity` items, ordered geographically (Z-order) on a full build. Later
 * publications rewrite only the packs whose content changed; new items go to
 * the group's least-filled pack; small packs are merged once a group has
 * several of them (spec "The app occasionally merges small update packs").
 */

export interface ExistingPack {
  /** Logical id (inside the encryption). */
  id: string;
  /** Recipient-set fingerprint the pack was sealed for (`null`: unknown, rewrite). */
  fp: string | null;
  /** Item id → item hash, as sealed. */
  items: Record<string, string>;
  file: string;
}

export interface DesiredItem {
  id: string;
  /** Recipient-set fingerprint. */
  fp: string;
  hash: string;
  sortKey: number;
}

export interface PackWrite {
  id: string;
  fp: string;
  itemIds: string[];
  /** The file this write replaces (absent for a new pack). */
  replaces?: string;
}

export interface PackPlan {
  /** Packs kept as they are. */
  keep: ExistingPack[];
  /** Packs to (re)seal. */
  write: PackWrite[];
  /** Existing files no longer listed (replaced or dropped). */
  drop: string[];
}

export interface PlanOptions {
  /** Max items per pack (default 200). */
  capacity?: number;
  /** A pack below `capacity * minFill` is "small" (default 0.25). Two small packs in a group are merged. */
  minFill?: number;
  /**
   * When a publication would replace exactly one existing pack, also rewrite
   * one unchanged pack, so that comparing two successive indexes does not
   * tell which single file was edited (spec: "which the app blurs by grouping
   * replacements"). Default true.
   */
  blur?: boolean;
  /** Random source for new logical ids and the blur choice. */
  newId: () => string;
  random?: () => number;
}

interface Slot {
  id: string;
  fp: string;
  items: string[];
  existing: ExistingPack | null;
  dirty: boolean;
}

export function planPacks(existing: readonly ExistingPack[], desired: ReadonlyMap<string, DesiredItem>, opts: PlanOptions): PackPlan {
  const capacity = Math.max(1, opts.capacity ?? 200);
  const small = Math.max(1, Math.floor(capacity * (opts.minFill ?? 0.25)));
  const random = opts.random ?? Math.random;
  const assigned = new Set<string>();
  const slots: Slot[] = [];
  const drop: string[] = [];

  // 1. Existing packs keep the items that still belong to them unchanged.
  for (const p of existing) {
    if (p.fp === null) {
      drop.push(p.file);
      continue;
    }
    const ids = Object.keys(p.items);
    const kept = ids.filter((id) => {
      const d = desired.get(id);
      if (!d || d.fp !== p.fp || d.hash !== p.items[id] || assigned.has(id)) return false;
      assigned.add(id);
      return true;
    });
    if (kept.length === 0) {
      drop.push(p.file);
      continue;
    }
    slots.push({ id: p.id, fp: p.fp, items: kept, existing: p, dirty: kept.length !== ids.length });
  }

  // 2. Unassigned items (new, changed, or moved to another recipient set), by group.
  const byFp = new Map<string, DesiredItem[]>();
  for (const d of desired.values()) {
    if (assigned.has(d.id)) continue;
    let l = byFp.get(d.fp);
    if (!l) byFp.set(d.fp, (l = []));
    l.push(d);
  }
  for (const [fp, items] of byFp) {
    items.sort((a, b) => a.sortKey - b.sortKey || (a.id < b.id ? -1 : 1));
    const group = slots.filter((s) => s.fp === fp);
    let i = 0;
    // Fill dirty packs first (they are rewritten anyway), then the least filled.
    const order = [...group].sort((a, b) => Number(b.dirty) - Number(a.dirty) || a.items.length - b.items.length);
    for (const s of order) {
      while (i < items.length && s.items.length < capacity && (s.dirty || s.items.length < capacity)) {
        s.items.push(items[i++]!.id);
        s.dirty = true;
      }
      if (i >= items.length) break;
    }
    while (i < items.length) {
      const chunk = items.slice(i, i + capacity).map((d) => d.id);
      i += chunk.length;
      slots.push({ id: opts.newId(), fp, items: chunk, existing: null, dirty: true });
    }
  }

  // 3. Merge small packs within each group.
  const fps = new Set(slots.map((s) => s.fp));
  for (const fp of fps) {
    const smalls = slots.filter((s) => s.fp === fp && s.items.length < small);
    if (smalls.length < 2) continue;
    const pool = smalls.flatMap((s) => s.items);
    const keepers = smalls.slice(0, Math.ceil(pool.length / capacity));
    for (const s of smalls) {
      s.items = [];
      s.dirty = true;
    }
    pool.forEach((id, k) => keepers[Math.floor(k / capacity)]!.items.push(id));
  }
  const live = slots.filter((s) => {
    if (s.items.length > 0) return true;
    if (s.existing) drop.push(s.existing.file);
    return false;
  });

  // 4. Blur a single replacement.
  const replaced = live.filter((s) => s.dirty && s.existing).length + drop.length;
  if ((opts.blur ?? true) && replaced === 1) {
    const clean = live.filter((s) => !s.dirty);
    if (clean.length > 0) clean[Math.floor(random() * clean.length)]!.dirty = true;
  }

  const keep: ExistingPack[] = [];
  const write: PackWrite[] = [];
  for (const s of live) {
    if (!s.dirty && s.existing) keep.push(s.existing);
    else {
      const w: PackWrite = { id: s.id, fp: s.fp, itemIds: [...s.items].sort() };
      if (s.existing) {
        w.replaces = s.existing.file;
        drop.push(s.existing.file);
      }
      write.push(w);
    }
  }
  return { keep, write, drop: [...new Set(drop)] };
}
