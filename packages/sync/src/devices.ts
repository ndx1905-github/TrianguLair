// SPDX-License-Identifier: MPL-2.0
/**
 * My devices and a few app values, kept in the recovery vault's free-form `app` part so that every
 * device of mine sees the same list (spec "Adding a device": "Each device appears in the settings
 * (name, date added), and can be removed"; "Recovery kit": storage write credentials, settings).
 *
 * Trust (spec "Recovery kit"; review of PR #86, F-01 and F-02): every device holds the vault data
 * key, so a stolen device can write anything here until it is declared lost, and what it wrote is
 * carried over when the vault is saved with the new key. So:
 *
 * - `triangulair_devices` (version 2): per device id, its **master-signed device certificate**
 *   (`cert`), a removal date (`removed`, display only) and display entries (`info`: name, date
 *   added, primary mark), one slot per signer.
 *   - Which devices exist comes from the certificates only: an entry counts only if its
 *     certificate verifies for my owner id and names that device; certificates are merged as a
 *     union, and a certificate that does not verify never replaces one that does (a thief cannot
 *     add a device, nor hide one).
 *   - Which devices are removed comes from the current master-signed sharing certificate
 *     (`revoked_devices`) only: `removed` is set for a revoked device, never because of a mark in
 *     the vault (a thief cannot drop itself from "Declare a device lost").
 *   - Keys are delivered to every certified device the sharing certificate does not revoke.
 *   - Display entries are signed by the device that wrote them (its own slot: a thief cannot
 *     overwrite another device's slot), and only a certified device that the current certificate
 *     does not revoke (or my master key) counts as a signer. The primary mark is taken from the
 *     device's own slot only, and is display only (F-06 never decides on it).
 * - `triangulair_values` (version 2): small named values (the storage settings with their
 *   credentials, the profile name), one signed slot per signer; the visible value is the newest
 *   slot of a valid signer (master key, or a certified device not revoked).
 *
 * Times: an entry stamped more than `MAX_SKEW_MS` in the future is refused (when merging and when
 * reading), so a planted far-future time never wins; a new entry is stamped after every valid one
 * seen (a later change by the user always wins), with no overflow.
 *
 * A declaration of loss (`dropSigners` + `resetValues`, called by `SyncEngine.rotateKey`) removes
 * every slot the revoked devices signed and resets the values to the declaring device's.
 */
import { canonicalize, verifyDeviceCert, type DeviceCert, type VaultRecords } from '@triangulair/crypto';
import { signEntry, verifyEntry, type EntrySigner } from './sign.ts';

export const DEVICES_KEY = 'triangulair_devices';
export const VALUES_KEY = 'triangulair_values';
/** Longest device name kept (characters). */
export const MAX_DEVICE_NAME = 60;
/** At most this many devices (certificates) are kept. */
export const MAX_DEVICES = 64;
/** At most this many signed slots per device entry or per value. */
export const MAX_SLOTS = 8;
/** How far in the future an entry's time may be (another device's clock ahead). */
export const MAX_SKEW_MS = 10 * 60 * 1000;

export type { EntrySigner } from './sign.ts';

/** A device of mine as shown in Settings › Devices. */
export interface DeviceEntry {
  /** The full device certificate (master-signed, verified). */
  cert: DeviceCert;
  /** Display name ('' when no valid signer named it yet). */
  name: string;
  /** When it was added (ms; 0 when unknown). */
  added: number;
  /** It keeps the master key, as said by the device itself. Display only. */
  primary?: boolean;
  /** Revoked by the current sharing certificate: when (ms, 0 when unknown). */
  removed?: number;
  /** Time of the visible display entry (ms). */
  at: number;
}

/** What decides who counts: the current sharing certificate's revocations, and the clock. */
export interface TrustContext {
  revoked?: Iterable<string>;
  now?: number;
}

interface InfoSlot {
  name: string;
  added: number;
  primary?: boolean;
  at: number;
  sig: string;
}
interface DeviceRecord {
  cert: DeviceCert;
  info: Record<string, InfoSlot>;
  removed?: number;
}
interface ValueSlot {
  value: unknown;
  at: number;
  sig: string;
}
type DevicesPart = Record<string, DeviceRecord>;
type ValuesPart = Record<string, Record<string, ValueSlot>>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isTime = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

export function cleanName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return [...name.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, MAX_DEVICE_NAME).join('');
}

// ------------------------------------------------------------------ parsing

function infoSlot(e: unknown): InfoSlot | null {
  if (!isObj(e) || typeof e['name'] !== 'string' || !isTime(e['added']) || !isTime(e['at']) || typeof e['sig'] !== 'string') return null;
  if (e['primary'] !== undefined && typeof e['primary'] !== 'boolean') return null;
  return { name: e['name'], added: e['added'], ...(e['primary'] === true && { primary: true }), at: e['at'], sig: e['sig'] };
}

function devicesPart(r: VaultRecords): DevicesPart {
  const p = r.app?.[DEVICES_KEY] as unknown;
  if (!isObj(p) || !isObj(p['devices'])) return {};
  const out: DevicesPart = {};
  for (const [id, e] of Object.entries(p['devices'])) {
    if (!isObj(e) || !isObj(e['cert'])) continue;
    const info: Record<string, InfoSlot> = {};
    // Version 1 entries (unsigned name and marks) keep their certificate only.
    if (p['version'] === 2 && isObj(e['info'])) {
      for (const [by, s] of Object.entries(e['info'])) {
        const slot = infoSlot(s);
        if (slot) info[by] = slot;
      }
    }
    out[id] = { cert: e['cert'] as unknown as DeviceCert, info, ...(p['version'] === 2 && isTime(e['removed']) && { removed: e['removed'] }) };
  }
  return out;
}

function valuesPart(r: VaultRecords): ValuesPart {
  const p = r.app?.[VALUES_KEY] as unknown;
  // Version 1 values (unsigned, "latest time wins") are dropped: they could come from a thief.
  if (!isObj(p) || p['version'] !== 2 || !isObj(p['values'])) return {};
  const out: ValuesPart = {};
  for (const [k, slots] of Object.entries(p['values'])) {
    if (!isObj(slots)) continue;
    const s: Record<string, ValueSlot> = {};
    for (const [by, e] of Object.entries(slots)) {
      if (isObj(e) && isTime(e['at']) && typeof e['sig'] === 'string' && 'value' in e) s[by] = { value: e['value'], at: e['at'], sig: e['sig'] };
    }
    out[k] = s;
  }
  return out;
}

function withPart(r: VaultRecords, key: string, part: unknown): VaultRecords {
  // Deep copy: what goes into the vault must be plain JSON (canonical, no undefined).
  return { ...r, app: { ...(r.app ?? {}), [key]: JSON.parse(JSON.stringify(part)) } } as VaultRecords;
}

const writeDevices = (r: VaultRecords, d: DevicesPart) => withPart(r, DEVICES_KEY, { version: 2, devices: sortKeys(d) });
const writeValues = (r: VaultRecords, v: ValuesPart) => withPart(r, VALUES_KEY, { version: 2, values: sortKeys(v) });

function sortKeys<T>(o: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]!]));
}

// ------------------------------------------------------------------ checks

/** The certificate if it verifies for my owner id and names device `id`. */
function checkedCert(r: VaultRecords, id: string, cert: unknown): DeviceCert | null {
  try {
    const c = verifyDeviceCert(cert as never, { expectedOwner: r.owner, retiredOwners: r.retired_owners });
    return c.device === id ? c : null;
  } catch {
    return null;
  }
}

/** Device ids whose certificate verifies (whatever the revocations). */
function certifiedIds(r: VaultRecords, d: DevicesPart): Set<string> {
  const ids = new Set<string>();
  for (const [id, e] of Object.entries(d)) if (checkedCert(r, id, e.cert)) ids.add(id);
  return ids;
}

interface Trust {
  owner: string;
  certified: Set<string>;
  revoked: Set<string>;
  maxAt: number;
}

function trustOf(r: VaultRecords, d: DevicesPart, ctx: TrustContext = {}): Trust {
  return { owner: r.owner, certified: certifiedIds(r, d), revoked: new Set(ctx.revoked ?? []), maxAt: (ctx.now ?? Date.now()) + MAX_SKEW_MS };
}

/** A valid signer: my master key, or a certified device that the current certificate does not revoke. */
function validSigner(t: Trust, by: string): boolean {
  return by === t.owner || (t.certified.has(by) && !t.revoked.has(by));
}

const infoBody = (owner: string, device: string, by: string, s: Omit<InfoSlot, 'sig'>) => ({
  owner,
  device,
  by,
  name: s.name,
  added: s.added,
  primary: s.primary === true,
  at: s.at,
});
const valueBody = (owner: string, key: string, by: string, s: Omit<ValueSlot, 'sig'>) => ({ owner, key, by, value: s.value, at: s.at });

function infoOk(t: Trust, device: string, by: string, s: InfoSlot): boolean {
  return s.at <= t.maxAt && validSigner(t, by) && verifyEntry('vault-device-info', infoBody(t.owner, device, by, s), by, s.sig);
}

function valueOk(t: Trust, key: string, by: string, s: ValueSlot): boolean {
  return s.at <= t.maxAt && validSigner(t, by) && verifyEntry('vault-value', valueBody(t.owner, key, by, s), by, s.sig);
}

function newer<T extends { at: number }>(a: T | undefined, b: T | undefined): T | undefined {
  if (!a) return b;
  if (!b) return a;
  if (a.at !== b.at) return a.at > b.at ? a : b;
  return canonicalize(a as never) >= canonicalize(b as never) ? a : b; // deterministic on both devices
}

/** Keeps the MAX_SLOTS newest slots. */
function trimSlots<T extends { at: number }>(slots: Record<string, T>): Record<string, T> {
  const ids = Object.keys(slots);
  if (ids.length <= MAX_SLOTS) return slots;
  const keep = ids.sort((x, y) => slots[y]!.at - slots[x]!.at || (x < y ? -1 : 1)).slice(0, MAX_SLOTS);
  return Object.fromEntries(keep.map((k) => [k, slots[k]!]));
}

/** Time for a new entry: after every valid one seen, never past MAX_SAFE_INTEGER. */
function stamp(now: number, seen: number[]): number {
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(now, ...seen.map((x) => x + 1)));
}

// ------------------------------------------------------------------ reading

/**
 * My devices: every device whose certificate verifies for my owner id (sorted by date added), with
 * `removed` when the current sharing certificate revokes it (`ctx.revoked`).
 */
export function devicesOf(r: VaultRecords, ctx: TrustContext = {}): DeviceEntry[] {
  const d = devicesPart(r);
  const t = trustOf(r, d, ctx);
  const out: DeviceEntry[] = [];
  for (const [id, e] of Object.entries(d)) {
    const cert = checkedCert(r, id, e.cert);
    if (!cert) continue;
    let shown: InfoSlot | undefined;
    for (const [by, s] of Object.entries(e.info)) if (infoOk(t, id, by, s)) shown = newer(shown, s);
    const self = e.info[id];
    const revoked = t.revoked.has(id);
    out.push({
      cert,
      name: shown?.name ?? '',
      added: shown?.added ?? 0,
      ...(!revoked && self?.primary && infoOk(t, id, id, self) && { primary: true }),
      ...(revoked && { removed: e.removed ?? 0 }),
      at: shown?.at ?? 0,
    });
  }
  return out.sort((a, b) => (a.added || Infinity) - (b.added || Infinity) || (a.cert.device < b.cert.device ? -1 : 1));
}

/** The visible value: the newest slot of a valid signer. */
export function valueOf<T>(r: VaultRecords, key: string, ctx: TrustContext = {}): { value: T; at: number; by: string } | undefined {
  const slots = valuesPart(r)[key];
  if (!slots) return undefined;
  const t = trustOf(r, devicesPart(r), ctx);
  let best: (ValueSlot & { by: string }) | undefined;
  for (const [by, s] of Object.entries(slots)) if (valueOk(t, key, by, s)) best = newer(best, { ...s, by });
  return best ? { value: best.value as T, at: best.at, by: best.by } : undefined;
}

// ------------------------------------------------------------------ merging

/**
 * Merges the devices and values parts of two copies (called by `mergeBooks` on top of
 * `mergeVaults`). Certificates: union of those that verify. Slots: per signer, the newer of the
 * valid ones (a slot that does not verify, or from the future, is dropped).
 */
export function mergeDeviceParts(into: VaultRecords, a: VaultRecords, b: VaultRecords, ctx: TrustContext = {}): VaultRecords {
  let out = into;
  const hasD = a.app?.[DEVICES_KEY] !== undefined || b.app?.[DEVICES_KEY] !== undefined;
  const hasV = a.app?.[VALUES_KEY] !== undefined || b.app?.[VALUES_KEY] !== undefined;
  const da = devicesPart(a);
  const db = devicesPart(b);
  const devices: DevicesPart = {};
  for (const id of new Set([...Object.keys(da), ...Object.keys(db)])) {
    const ca = da[id] && checkedCert(into, id, da[id].cert);
    const cb = db[id] && checkedCert(into, id, db[id].cert);
    if (!ca && !cb) continue;
    const cert = ca && cb ? (canonicalize(ca as never) <= canonicalize(cb as never) ? ca : cb) : (ca ?? cb)!;
    const marks = [da[id]?.removed, db[id]?.removed].filter((x): x is number => x !== undefined);
    devices[id] = { cert, info: {}, ...(marks.length && { removed: Math.min(...marks) }) };
  }
  const t = trustOf(into, devices, ctx);
  for (const [id, rec] of Object.entries(devices)) {
    const info: Record<string, InfoSlot> = {};
    for (const by of new Set([...Object.keys(da[id]?.info ?? {}), ...Object.keys(db[id]?.info ?? {})])) {
      const pick = (s: InfoSlot | undefined) => (s && infoOk(t, id, by, s) ? s : undefined);
      const s = newer(pick(da[id]?.info[by]), pick(db[id]?.info[by]));
      if (s) info[by] = s;
    }
    rec.info = trimSlots(info);
  }
  if (hasD) out = writeDevices(out, trimDevices(devices, t.revoked));
  if (hasV) {
    const va = valuesPart(a);
    const vb = valuesPart(b);
    const values: ValuesPart = {};
    for (const k of new Set([...Object.keys(va), ...Object.keys(vb)])) {
      const slots: Record<string, ValueSlot> = {};
      for (const by of new Set([...Object.keys(va[k] ?? {}), ...Object.keys(vb[k] ?? {})])) {
        const pick = (s: ValueSlot | undefined) => (s && valueOk(t, k, by, s) ? s : undefined);
        const s = newer(pick(va[k]?.[by]), pick(vb[k]?.[by]));
        if (s) slots[by] = s;
      }
      if (Object.keys(slots).length) values[k] = trimSlots(slots);
    }
    out = writeValues(out, values);
  }
  return out;
}

/** Keeps at most MAX_DEVICES certificates: devices not revoked first. */
function trimDevices(devices: DevicesPart, revoked: Set<string>): DevicesPart {
  const ids = Object.keys(devices);
  if (ids.length <= MAX_DEVICES) return devices;
  const keep = ids.sort((x, y) => Number(revoked.has(x)) - Number(revoked.has(y)) || (x < y ? -1 : 1)).slice(0, MAX_DEVICES);
  return Object.fromEntries(keep.map((id) => [id, devices[id]!]));
}

// ------------------------------------------------------------------ writing

/** Adds a master-signed device certificate (it must verify for this owner). */
export function putDeviceCert(r: VaultRecords, cert: DeviceCert): VaultRecords {
  const checked = verifyDeviceCert(cert as never, { expectedOwner: r.owner, retiredOwners: r.retired_owners });
  const d = devicesPart(r);
  if (d[checked.device] && checkedCert(r, checked.device, d[checked.device]!.cert)) return r;
  return writeDevices(r, { ...d, [checked.device]: { ...d[checked.device], info: d[checked.device]?.info ?? {}, cert: checked } });
}

/**
 * Writes `signer`'s display entry for a device of mine (rename, date added; the primary mark only
 * in the device's own entry). Fields not given keep their visible value. Unknown device: no change.
 */
export function putDeviceInfo(
  r: VaultRecords,
  id: string,
  patch: { name?: string; added?: number; primary?: boolean },
  signer: EntrySigner,
  now: number,
  ctx: TrustContext = {},
): VaultRecords {
  const d = devicesPart(r);
  const rec = d[id];
  if (!rec || !checkedCert(r, id, rec.cert)) return r;
  const t = trustOf(r, d, { ...ctx, now });
  const valid = Object.entries(rec.info).filter(([by, s]) => infoOk(t, id, by, s));
  const shown = valid.reduce<InfoSlot | undefined>((m, [, s]) => newer(m, s), undefined);
  const own = rec.info[signer.id];
  const self = signer.id === id;
  const body: Omit<InfoSlot, 'sig'> = {
    name: cleanName(patch.name ?? shown?.name ?? ''),
    added: patch.added ?? shown?.added ?? now,
    ...(self && (patch.primary ?? own?.primary) && { primary: true }),
    at: stamp(now, valid.map(([, s]) => s.at)),
  };
  const slot: InfoSlot = { ...body, sig: signEntry('vault-device-info', infoBody(r.owner, id, signer.id, body), signer) };
  return writeDevices(r, { ...d, [id]: { ...rec, info: trimSlots({ ...rec.info, [signer.id]: slot }) } });
}

/** Records when devices were removed (display only: shown only for devices the certificate revokes). */
export function markDevicesRemoved(r: VaultRecords, ids: readonly string[], now: number): VaultRecords {
  const d = devicesPart(r);
  let changed = false;
  for (const id of ids) {
    const rec = d[id];
    if (!rec || rec.removed !== undefined) continue;
    d[id] = { ...rec, removed: now };
    changed = true;
  }
  return changed ? writeDevices(r, d) : r;
}

/**
 * Sets `signer`'s value for `key` (JSON: no floats, no undefined), stamped after every valid value
 * seen, so it becomes the visible one. No change when it is already the visible value.
 */
export function setValue(r: VaultRecords, key: string, value: unknown, signer: EntrySigner, now: number, ctx: TrustContext = {}): VaultRecords {
  const cur = valueOf(r, key, { ...ctx, now });
  if (cur && canonicalize(cur.value as never) === canonicalize(value as never)) return r;
  const v = valuesPart(r);
  const t = trustOf(r, devicesPart(r), { ...ctx, now });
  const seen = Object.entries(v[key] ?? {})
    .filter(([by, s]) => valueOk(t, key, by, s))
    .map(([, s]) => s.at);
  const body = { value: JSON.parse(JSON.stringify(value)) as unknown, at: stamp(now, seen) };
  const slot: ValueSlot = { ...body, sig: signEntry('vault-value', valueBody(r.owner, key, signer.id, body), signer) };
  return writeValues(r, { ...v, [key]: trimSlots({ ...(v[key] ?? {}), [signer.id]: slot }) });
}

/** Removes every slot (display entries and values) signed by these devices (declared lost). */
export function dropSigners(r: VaultRecords, ids: Iterable<string>): VaultRecords {
  const gone = new Set(ids);
  if (!gone.size) return r;
  let out = r;
  if (r.app?.[DEVICES_KEY] !== undefined) {
    const d = devicesPart(r);
    for (const rec of Object.values(d)) rec.info = Object.fromEntries(Object.entries(rec.info).filter(([by]) => !gone.has(by)));
    out = writeDevices(out, d);
  }
  if (r.app?.[VALUES_KEY] !== undefined) {
    const v = valuesPart(r);
    for (const k of Object.keys(v)) v[k] = Object.fromEntries(Object.entries(v[k]!).filter(([by]) => !gone.has(by)));
    out = writeValues(out, v);
  }
  return out;
}

/**
 * A declaration of loss: every value becomes the declaring device's (`values`, or its own slot
 * when a key is not given), signed by it and stamped `now`; other slots are dropped.
 */
export function resetValues(r: VaultRecords, values: Record<string, unknown>, signer: EntrySigner, now: number): VaultRecords {
  const v = valuesPart(r);
  const next: ValuesPart = {};
  const keys = new Set([...Object.keys(values), ...Object.keys(v).filter((k) => v[k]?.[signer.id])]);
  for (const k of keys) {
    const value = k in values ? values[k] : v[k]![signer.id]!.value;
    if (value === undefined) continue;
    const body = { value: JSON.parse(JSON.stringify(value)) as unknown, at: Math.min(Number.MAX_SAFE_INTEGER, now) };
    next[k] = { [signer.id]: { ...body, sig: signEntry('vault-value', valueBody(r.owner, k, signer.id, body), signer) } };
  }
  return writeValues(r, next);
}
