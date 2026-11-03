// SPDX-License-Identifier: MPL-2.0
/**
 * Owner migration: hands a database created under a placeholder owner id
 * (the app's `local-me` before identity creation) to the real identity.
 *
 * My own data lives in the Yjs document, which holds no owner id: the
 * SQLite rows of my saves, tags and lists are only its projection, keyed by
 * owner (`saves.id` = `<owner>|<place id>`). So the migration removes that
 * projection, renames my `people` row, and clears the projection marker; the
 * next `DataStore.open({ meId: to })` rebuilds the projection under the new
 * owner from the unchanged document. Friends' saves, the OSM cache, people
 * and tag mappings are kept as they are.
 *
 * Call it before `DataStore.open`, on a database that no store has open.
 */
import type { SqlDriver } from './driver/types.ts';

export interface ReassignOwnerResult {
  /** false when there was nothing to migrate (new database, or not owned by `from`). */
  migrated: boolean;
  /** Own saves whose projection was removed (rebuilt on the next open). */
  saves: number;
}

/** The id of the owner of this database (`people.is_me`), or null for a new database. */
export function databaseOwner(db: SqlDriver): string | null {
  const t = db.get<{ n: number }>(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'people'`);
  if (!t || t.n === 0) return null;
  return db.get<{ id: string }>(`SELECT id FROM people WHERE is_me = 1`)?.id ?? null;
}

/**
 * Moves the database from owner `from` to owner `to` (see the module comment).
 * Does nothing when the database is new or already belongs to `to`; throws when
 * it belongs to a third identity, or when `to` is already a person in it (a
 * friend cannot become me).
 */
export function reassignOwner(db: SqlDriver, from: string, to: string): ReassignOwnerResult {
  if (from === to) throw new Error('reassignOwner: from and to are the same id');
  const owner = databaseOwner(db);
  if (owner === null || owner === to) return { migrated: false, saves: 0 };
  if (owner !== from) throw new Error(`database belongs to ${owner}, not ${from}`);
  return db.transaction(() => {
    if (db.get(`SELECT 1 AS x FROM people WHERE id = ?`, [to])) throw new Error('reassignOwner: the new owner is already a person in this database');
    const mySaves = `SELECT id FROM saves WHERE owner_id = ?`;
    const myLists = `SELECT id FROM lists WHERE owner_id = ?`;
    const saves = db.get<{ n: number }>(`SELECT count(*) AS n FROM saves WHERE owner_id = ?`, [from])!.n;
    db.run(`DELETE FROM list_items WHERE list_id IN (${myLists}) OR save_id IN (${mySaves})`, [from, from]);
    db.run(`DELETE FROM access WHERE list_id IN (${myLists}) OR save_id IN (${mySaves})`, [from, from]);
    db.run(`DELETE FROM media WHERE save_id IN (${mySaves})`, [from]);
    db.run(`DELETE FROM save_tags WHERE save_id IN (${mySaves})`, [from]);
    db.run(`DELETE FROM saves WHERE owner_id = ?`, [from]);
    db.run(`DELETE FROM tags WHERE owner_id = ?`, [from]);
    db.run(`DELETE FROM lists WHERE owner_id = ?`, [from]);
    db.run(`UPDATE people SET id = ? WHERE id = ?`, [to, from]);
    // No projection marker: the next open re-projects the document under `to`.
    db.run(`DELETE FROM meta WHERE key = 'projected_heads'`);
    return { migrated: true, saves };
  });
}
