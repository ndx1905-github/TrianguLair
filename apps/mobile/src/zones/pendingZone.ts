/**
 * Hand-off of a zone drawn for a list: the list editor opens the zone editor
 * with `purpose=list`; the editor leaves the drawn area here and goes back;
 * the editor picks it up when it regains focus. In memory only.
 */
import type { FilterZone } from '@triangulair/data';

let pending: FilterZone | null = null;

export function setPendingListZone(z: FilterZone): void {
  pending = z;
}

export function takePendingListZone(): FilterZone | null {
  const z = pending;
  pending = null;
  return z;
}
