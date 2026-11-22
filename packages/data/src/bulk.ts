// SPDX-License-Identifier: MPL-2.0
/**
 * Edits on many places at once (the list's "Select" mode): to the trash, back from it, a tag added
 * or removed, a status, a list. One call is one `DataStore.change`: one Yjs transaction, one chunk
 * in SQLite, one projection pass, so the sync publishes it once.
 *
 * Only my own saves are edited. A place I do not save (a friend's place in the selection), or a
 * save already in the trash (except for `restore`), is skipped and reported as such; a save that
 * already is as asked (the tag already there, the same status) is left untouched.
 */
import type { DocTx, DataDoc } from './crdt/doc.ts';
import { readDeletedAt, saveEntry, saveTagIds } from './crdt/doc.ts';
import type { SaveStatus } from './types.ts';

export type BulkEdit =
  | { kind: 'delete' }
  | { kind: 'restore' }
  | { kind: 'addTag'; tagId: string }
  | { kind: 'removeTag'; tagId: string }
  | { kind: 'status'; status: SaveStatus | null }
  | { kind: 'addToList'; listId: string };

export interface BulkResult {
  /** Place ids edited. */
  changed: string[];
  /** Mine, but already as asked. */
  unchanged: string[];
  /** Not my saves (a friend's place, or not saved at all), or in the trash. */
  skipped: string[];
}

/** Applies `edit` to my saves among `placeIds`, inside `tx` (see `DataStore.bulkEdit`). */
export function applyBulkEdit(tx: DocTx, doc: DataDoc, placeIds: readonly string[], edit: BulkEdit): BulkResult {
  const out: BulkResult = { changed: [], unchanged: [], skipped: [] };
  for (const placeId of new Set(placeIds)) {
    const e = saveEntry(doc, placeId);
    const inTrash = e !== null && readDeletedAt(e) !== null;
    if (!e || (inTrash && edit.kind !== 'restore') || (!inTrash && edit.kind === 'restore')) {
      out.skipped.push(placeId);
      continue;
    }
    let changed = true;
    switch (edit.kind) {
      case 'delete':
        tx.deleteSave(placeId);
        break;
      case 'restore':
        tx.restoreSave(placeId);
        break;
      case 'addTag':
        if (saveTagIds(e).includes(edit.tagId)) changed = false;
        else tx.addSaveTag(placeId, edit.tagId);
        break;
      case 'removeTag':
        if (!saveTagIds(e).includes(edit.tagId)) changed = false;
        else tx.removeSaveTag(placeId, edit.tagId);
        break;
      case 'status':
        if (((e.get('status') as SaveStatus | null | undefined) ?? null) === edit.status) changed = false;
        else tx.updateSave(placeId, { status: edit.status });
        break;
      case 'addToList':
        tx.addToList(edit.listId, placeId);
        break;
    }
    (changed ? out.changed : out.unchanged).push(placeId);
  }
  return out;
}
