/**
 * The list's "Select" mode (beta feedback: delete or edit many places at once). Pure: which rows
 * "Select all" takes, and which of the selected places are mine (only those can be edited; the
 * edit itself is `DataStore.bulkEdit`, one change for all of them).
 */
import type { Match } from './filters';

export interface SelectableRow {
  id: string;
  /** Do I save this place (false: only my friends do)? */
  mine: boolean;
  match: Match;
}

/**
 * The places "Select all" takes: those the list shows, so the search and the zone (already out of
 * the rows) and the active filters (non-matching rows are only faded) are respected.
 */
export function shownIds(rows: readonly SelectableRow[], filterActive: boolean): string[] {
  return rows.filter((r) => r.match !== 'hidden' && (!filterActive || r.match === 'match')).map((r) => r.id);
}

export interface SelectionSplit {
  /** My saves among the selection: what an action edits. */
  mine: string[];
  /** Friends' places among the selection: skipped by every action. */
  friends: number;
}

/** Splits the selection, in the order of the rows. Selected ids no longer in the rows are dropped. */
export function splitSelection(selected: ReadonlySet<string>, rows: readonly SelectableRow[]): SelectionSplit {
  const mine: string[] = [];
  let friends = 0;
  for (const r of rows) {
    if (!selected.has(r.id)) continue;
    if (r.mine) mine.push(r.id);
    else friends++;
  }
  return { mine, friends };
}

/** Toggles one id; returns a new set. */
export function toggle(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** "Select all" when not everything shown is selected, else "Clear" (returns the new selection). */
export function toggleAll(selected: ReadonlySet<string>, shown: readonly string[]): Set<string> {
  const all = shown.length > 0 && shown.every((id) => selected.has(id));
  return all ? new Set() : new Set(shown);
}
