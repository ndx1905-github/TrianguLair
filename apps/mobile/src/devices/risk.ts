/**
 * Whether a device about to be declared lost (or removed) may keep my master key (devices review
 * F-06). A plain key change is useless against a thief who holds it: they can certify a device key
 * of their own and issue the next rotation. The identity change is needed then (spec "Loss and
 * theft": "Declare the primary device lost").
 *
 * Decided from what a thief cannot forge for another device: this device's own state (it holds the
 * master key, so the chosen one is not the single primary device), and the primary mark another
 * device signed for itself (devices.ts: the mark is taken from the device's own entry only). A
 * stolen device can hide its own mark, so when no other device says it is primary, the answer is
 * "unknown": the screen asks the user.
 */
import type { DeviceEntry } from '@triangulair/sync';

export type PrimaryRisk = 'primary' | 'unknown' | 'not-primary';

export function primaryRisk(target: string, devices: readonly DeviceEntry[], me: { id: string; primary: boolean }): PrimaryRisk {
  const t = devices.find((d) => d.cert.device === target);
  if (t?.primary) return 'primary';
  if (me.primary && target !== me.id) return 'not-primary';
  const other = devices.some((d) => d.cert.device !== target && d.removed === undefined && d.primary);
  return other ? 'not-primary' : 'unknown';
}
