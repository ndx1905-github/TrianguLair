/**
 * The trash (gap #8, spec "Editing and deleting": "Trash for 30 days, synchronized across my devices and
 * restorable"). Everything lives in my document already (`deletedAt` on saves, tags and lists; `purgeTrash` in the
 * data package); this file lists it for the trash screen and runs its actions. Zones are saves of kind "zone".
 */
import { TRASH_RETENTION_MS, type DataStore, type Repository, type TrashItemRef } from '@triangulair/data';

export type TrashKind = 'place' | 'zone' | 'tag' | 'list';

export interface TrashItem {
  kind: TrashKind;
  /** What `purgeTrash(only)` needs: saves by place id. */
  ref: TrashItemRef;
  name: string;
  deletedAt: number;
  /** Whole days before the automatic purge (0: at the next launch). */
  daysLeft: number;
}

const DAY = 24 * 3600 * 1000;

export function daysLeft(deletedAt: number, now: number): number {
  return Math.max(0, Math.ceil((deletedAt + TRASH_RETENTION_MS - now) / DAY));
}

/** Everything in my trash, most recently deleted first. */
export function trashItems(repo: Repository, now: number): TrashItem[] {
  const items: TrashItem[] = [];
  for (const s of repo.trash()) {
    if (s.deletedAt == null) continue;
    const place = repo.getPlace(s.placeId);
    items.push({
      kind: place?.kind === 'zone' ? 'zone' : 'place',
      ref: { kind: 'save', id: s.placeId },
      name: place?.name ?? '',
      deletedAt: s.deletedAt,
      daysLeft: daysLeft(s.deletedAt, now),
    });
  }
  for (const t of repo.tags()) {
    if (t.deletedAt == null) continue;
    items.push({ kind: 'tag', ref: { kind: 'tag', id: t.id }, name: t.name, deletedAt: t.deletedAt, daysLeft: daysLeft(t.deletedAt, now) });
  }
  for (const l of repo.lists({ includeDeleted: true })) {
    if (l.deletedAt == null) continue;
    items.push({ kind: 'list', ref: { kind: 'list', id: l.id }, name: l.name, deletedAt: l.deletedAt, daysLeft: daysLeft(l.deletedAt, now) });
  }
  return items.sort((a, b) => b.deletedAt - a.deletedAt || a.name.localeCompare(b.name));
}

/** Puts an item back where it was (a place keeps its tags, comment and lists). */
export function restoreItem(store: DataStore, item: TrashItem): void {
  if (item.ref.kind === 'save') store.restoreSave(item.ref.id);
  else if (item.ref.kind === 'tag') store.restoreTag(item.ref.id);
  else store.restoreList(item.ref.id);
}

/** "Delete forever": removed now from my document, on all my devices at the next sync (a tombstone remains). */
export function deleteForever(store: DataStore, item: TrashItem): void {
  store.purgeTrash(item.ref);
}

/** "Empty the trash": every item, now. Returns how many were removed. */
export function emptyTrash(store: DataStore, items: readonly TrashItem[]): number {
  let n = 0;
  for (const it of items) n += store.purgeTrash(it.ref);
  return n;
}

/** On launch: items deleted more than 30 days ago leave for good. Never throws. */
export function purgeExpired(store: DataStore): number {
  try {
    return store.purgeTrash();
  } catch (e) {
    console.warn('Could not purge the trash', e);
    return 0;
  }
}
