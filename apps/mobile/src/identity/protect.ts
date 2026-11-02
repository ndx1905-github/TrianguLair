/**
 * "Later, at the right moment" (spec): the "Protect your places" card comes
 * when there is something to lose (about ten places, or a few days after the
 * first launch) and stays as a discreet reminder until the kit is saved.
 * Pure, unit-tested.
 */
export const PROTECT_AFTER_PLACES = 10;
export const PROTECT_AFTER_MS = 3 * 24 * 3600_000;
/** After "Later", the card comes back after this long; meanwhile only the reminder dot shows. */
export const PROTECT_SNOOZE_MS = 7 * 24 * 3600_000;

export type ProtectState = 'none' | 'card' | 'reminder';

export function protectState(i: {
  kitSaved: boolean;
  myPlaces: number;
  createdAt: number;
  now: number;
  snoozedAt: number | null;
}): ProtectState {
  if (i.kitSaved) return 'none';
  const due = i.myPlaces >= PROTECT_AFTER_PLACES || i.now - i.createdAt >= PROTECT_AFTER_MS;
  if (!due) return 'none';
  if (i.snoozedAt !== null && i.now - i.snoozedAt < PROTECT_SNOOZE_MS) return 'reminder';
  return 'card';
}
