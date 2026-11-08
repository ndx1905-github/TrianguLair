// SPDX-License-Identifier: MPL-2.0
/**
 * My devices and a few app values, kept in the recovery vault's free-form `app` part so that every
 * device of mine sees the same list (spec "Adding a device": "Each device appears in the settings
 * (name, date added), and can be removed"; "Recovery kit": storage write credentials, settings).
 *
 * - `triangulair_devices`: one entry per device, keyed by its device id, holding its full
 *   **master-signed** device certificate, a name, the date it was added, whether it keeps the
 *   master key (primary), and a removal date. Merged per device (latest change wins; a removal
 *   is sticky).
 * - `triangulair_values`: small named values (the storage settings with their credentials, the
 *   profile name), each stamped with the time of its change and merged per key (latest wins).
 *
 * Trust (spec "Recovery kit", N-2 of the fifth review): every device holds the vault data key, so a
 * stolen device can write anything here until it is declared lost. Nothing in this part is a
 * security decision on its own:
 * - an entry counts only if its certificate verifies for my owner id and names that device (a
 *   stolen device cannot make a master-signed certificate, so it cannot add a device);
 * - which devices are revoked is said by the master-signed sharing certificate
 *   (`revoked_devices`), never by `removed` (display only); keys are delivered to every listed
 *   device the certificate does not revoke, whatever `removed` says (a thief marking a device
 *   removed only delays nothing: the next delivery ignores the mark);
 * - names, dates and the primary mark are display only.
 */
import { canonicalize, verifyDeviceCert, type DeviceCert, type VaultRecords } from '@triangulair/crypto';

export const DEVICES_KEY = 'triangulair_devices';
export const VALUES_KEY = 'triangulair_values';
/** Longest device name kept (characters). */
export const MAX_DEVICE_NAME = 60;
/** At most this many device entries (removed ones included) are kept. */
export const MAX_DEVICES = 64;

export interface DeviceEntry {
  /** The full device certificate (master-signed). */
  cert: DeviceCert;
  name: string;
  /** When it was added (ms). */
  added: number;
  /** It keeps the master key (set by the device itself). Display only. */
  primary?: boolean;
  /** When it was removed or declared lost (ms). Display only: revocation is in the sharing certificate. */
  removed?: number;
  /** Time of the last change (ms), for the merge. */
  at: number;
}

type DevicesPart = { version: 1; devices: Record<string, DeviceEntry> };
type ValueEntry = { value: unknown; at: number };
type ValuesPart = { version: 1; values: Record<string, ValueEntry> };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isTime = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

export function cleanName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return [...name.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, MAX_DEVICE_NAME).join('');
}

/** A structurally valid entry (the certificate is checked separately, see `devicesOf`). */
function wellFormed(e: unknown): e is DeviceEntry {
  if (!isObj(e) || !isObj(e['cert']) || typeof e['name'] !== 'string' || !isTime(e['added']) || !isTime(e['at'])) return false;
  if (e['primary'] !== undefined && typeof e['primary'] !== 'boolean') return false;
  if (e['removed'] !== undefined && !isTime(e['removed'])) return false;
  return true;
}

function devicesPart(r: VaultRecords): DevicesPart {
  const p = r.app?.[DEVICES_KEY] as unknown;
  if (!isObj(p) || p['version'] !== 1 || !isObj(p['devices'])) return { version: 1, devices: {} };
  const devices: Record<string, DeviceEntry> = {};
  for (const [id, e] of Object.entries(p['devices'])) if (wellFormed(e)) devices[id] = e;
  return { version: 1, devices };
}

function valuesPart(r: VaultRecords): ValuesPart {
  const p = r.app?.[VALUES_KEY] as unknown;
  if (!isObj(p) || p['version'] !== 1 || !isObj(p['values'])) return { version: 1, values: {} };
  const values: Record<string, ValueEntry> = {};
  for (const [k, e] of Object.entries(p['values'])) if (isObj(e) && isTime(e['at']) && 'value' in e) values[k] = { value: e['value'], at: e['at'] };
  return { version: 1, values };
}

function withPart(r: VaultRecords, key: string, part: unknown): VaultRecords {
  // Deep copy: what goes into the vault must be plain JSON (canonical, no undefined).
  return { ...r, app: { ...(r.app ?? {}), [key]: JSON.parse(JSON.stringify(part)) } } as VaultRecords;
}

/** The entries whose certificate verifies for `owner` and names that device (stolen-device rule above). */
export function devicesOf(r: VaultRecords): DeviceEntry[] {
  const out: DeviceEntry[] = [];
  for (const [id, e] of Object.entries(devicesPart(r).devices)) {
    try {
      const cert = verifyDeviceCert(e.cert as never, { expectedOwner: r.owner, retiredOwners: r.retired_owners });
      if (cert.device !== id) continue;
      out.push({ ...e, cert });
    } catch {
      // not a device of mine: ignored (and dropped at the next write)
    }
  }
  return out.sort((a, b) => a.added - b.added || (a.cert.device < b.cert.device ? -1 : 1));
}

function later<T extends { at: number }>(a: T | undefined, b: T | undefined): T | undefined {
  if (!a) return b;
  if (!b) return a;
  if (a.at !== b.at) return a.at > b.at ? a : b;
  return canonicalize(a as never) >= canonicalize(b as never) ? a : b; // deterministic on both devices
}

function mergeDevice(a: DeviceEntry | undefined, b: DeviceEntry | undefined): DeviceEntry {
  const w = { ...later(a, b)! };
  const removed = [a?.removed, b?.removed].filter((x): x is number => x !== undefined);
  if (removed.length) w.removed = Math.min(...removed);
  w.added = Math.min(...[a?.added, b?.added].filter((x): x is number => x !== undefined));
  return w;
}

/** Merges the devices and values parts of two copies (called by `mergeBooks` on top of `mergeVaults`). */
export function mergeDeviceParts(into: VaultRecords, a: VaultRecords, b: VaultRecords): VaultRecords {
  let out = into;
  const hasD = a.app?.[DEVICES_KEY] !== undefined || b.app?.[DEVICES_KEY] !== undefined;
  const hasV = a.app?.[VALUES_KEY] !== undefined || b.app?.[VALUES_KEY] !== undefined;
  if (hasD) {
    const da = devicesPart(a).devices;
    const db = devicesPart(b).devices;
    const devices: Record<string, DeviceEntry> = {};
    for (const id of [...new Set([...Object.keys(da), ...Object.keys(db)])].sort()) devices[id] = mergeDevice(da[id], db[id]);
    out = withPart(out, DEVICES_KEY, { version: 1, devices: trim(devices) });
  }
  if (hasV) {
    const va = valuesPart(a).values;
    const vb = valuesPart(b).values;
    const values: Record<string, ValueEntry> = {};
    for (const k of [...new Set([...Object.keys(va), ...Object.keys(vb)])].sort()) values[k] = later(va[k], vb[k])!;
    out = withPart(out, VALUES_KEY, { version: 1, values });
  }
  return out;
}

/** Keeps at most MAX_DEVICES entries: live ones first, then the most recently removed. */
function trim(devices: Record<string, DeviceEntry>): Record<string, DeviceEntry> {
  const ids = Object.keys(devices);
  if (ids.length <= MAX_DEVICES) return devices;
  const keep = ids
    .sort((x, y) => {
      const a = devices[x]!;
      const b = devices[y]!;
      if ((a.removed === undefined) !== (b.removed === undefined)) return a.removed === undefined ? -1 : 1;
      return (b.removed ?? b.at) - (a.removed ?? a.at);
    })
    .slice(0, MAX_DEVICES);
  return Object.fromEntries(keep.sort().map((id) => [id, devices[id]!]));
}

/** Adds or refreshes a device (its certificate must verify for this owner). */
export function putDevice(r: VaultRecords, cert: DeviceCert, info: { name: string; added?: number; primary?: boolean }, now: number): VaultRecords {
  const checked = verifyDeviceCert(cert as never, { expectedOwner: r.owner, retiredOwners: r.retired_owners });
  const part = devicesPart(r);
  const cur = part.devices[checked.device];
  const next: DeviceEntry = {
    cert: checked,
    name: cleanName(info.name),
    added: cur?.added ?? info.added ?? now,
    at: Math.max(now, (cur?.at ?? 0) + 1),
    ...(info.primary !== undefined ? (info.primary ? { primary: true } : {}) : cur?.primary ? { primary: true } : {}),
    ...(cur?.removed !== undefined && { removed: cur.removed }),
  };
  return withPart(r, DEVICES_KEY, { version: 1, devices: trim({ ...part.devices, [checked.device]: next }) });
}

/** Renames a device or changes its primary mark. Unknown device: no change. */
export function updateDevice(r: VaultRecords, id: string, patch: { name?: string; primary?: boolean }, now: number): VaultRecords {
  const part = devicesPart(r);
  const cur = part.devices[id];
  if (!cur) return r;
  const next: DeviceEntry = { ...cur, at: Math.max(now, cur.at + 1) };
  if (patch.name !== undefined) next.name = cleanName(patch.name);
  if (patch.primary !== undefined) {
    if (patch.primary) next.primary = true;
    else delete next.primary;
  }
  return withPart(r, DEVICES_KEY, { version: 1, devices: { ...part.devices, [id]: next } });
}

/** Marks devices removed (they were revoked in the sharing certificate). */
export function markDevicesRemoved(r: VaultRecords, ids: readonly string[], now: number): VaultRecords {
  const part = devicesPart(r);
  const devices = { ...part.devices };
  let changed = false;
  for (const id of ids) {
    const cur = devices[id];
    if (!cur || cur.removed !== undefined) continue;
    devices[id] = { ...cur, removed: now, at: Math.max(now, cur.at + 1) };
    delete devices[id]!.primary;
    changed = true;
  }
  return changed ? withPart(r, DEVICES_KEY, { version: 1, devices }) : r;
}

export function valueOf<T>(r: VaultRecords, key: string): { value: T; at: number } | undefined {
  const e = valuesPart(r).values[key];
  return e ? { value: e.value as T, at: e.at } : undefined;
}

/** Sets a value (JSON: no floats, no undefined), stamped `now`; `null` keeps a tombstone. */
export function setValue(r: VaultRecords, key: string, value: unknown, now: number): VaultRecords {
  const part = valuesPart(r);
  const cur = part.values[key];
  if (cur && canonicalize(cur.value as never) === canonicalize(value as never)) return r;
  return withPart(r, VALUES_KEY, { version: 1, values: { ...part.values, [key]: { value, at: Math.max(now, (cur?.at ?? 0) + 1) } } });
}
