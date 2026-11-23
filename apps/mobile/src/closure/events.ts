/**
 * "May no longer exist according to OpenStreetMap" in What's new: the places the closed-place
 * check (T-113: the monthly run while the app is open, or a card opened) or an import newly flags
 * "maybe closed", dated when detected. Kept on this device only, in the local database (the sync
 * state table, next to the friends' What's new log): nothing goes into my shared document, and a
 * remote wipe erases it with the rest.
 *
 * A place gets one entry per flag: it is flagged again (a new entry) only after I answered
 * "Still open" on its card. The log keeps its newest entries only, like the friends' one.
 *
 * Pure apart from the small key-value store it is given; unit-tested.
 */
import type { ClosureSignal, UserResolution } from '@triangulair/osm';

import type { WhatsNewEntry } from '../sync/whatsNew';

export const CLOSURE_LOG_KEY = 'app:whatsnew:closures';
export const CLOSURE_FLAGGED_KEY = 'app:whatsnew:closures:flagged';
export const MAX_CLOSURE_ENTRIES = 200;
/** Places remembered as flagged (oldest forgotten first). */
const MAX_FLAGGED = 5000;
/** Places listed in a grouped (import) entry. */
const MAX_IDS = 500;
/** Owner of my own entries: not a person, so never a friend chip. */
export const OWN_ENTRY_OWNER = '';

export interface Kv {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
}

/** A place a check or an import found "maybe closed". */
export interface Detection {
  placeId: string;
  name: string;
  signals: readonly ClosureSignal[];
}

type Flagged = Record<string, number>;

const RANK = { high: 3, medium: 2, low: 1 } as const;

/** The signal shown as the reason: the most reliable, then the oldest evidence. */
export function mainSignal(signals: readonly ClosureSignal[]): ClosureSignal | undefined {
  return [...signals].sort((a, b) => (RANK[b.reliability] ?? 0) - (RANK[a.reliability] ?? 0) || (a.since ?? a.observedAt).localeCompare(b.since ?? b.observedAt))[0];
}

/** A new entry unless the place is already flagged and I have not said "Still open" since. */
export function isNewFlag(flaggedAt: number | undefined, resolution: UserResolution | undefined): boolean {
  if (flaggedAt === undefined) return true;
  if (resolution?.decision !== 'still_open') return false;
  const decided = Date.parse(resolution.decidedAt);
  return Number.isFinite(decided) && decided > flaggedAt;
}

const listeners = new Set<() => void>();
/** Called after new entries were recorded (What's new and its badge redraw). */
export function onClosureEvents(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export class ClosureEventLog {
  constructor(private readonly kv: Kv) {}

  entries(): WhatsNewEntry[] {
    const v = this.kv.get<WhatsNewEntry[]>(CLOSURE_LOG_KEY);
    return Array.isArray(v) ? v.filter((e) => !!e && typeof e === 'object' && typeof e.at === 'number' && (e.kind === 'closure' || e.kind === 'closureImport')) : [];
  }

  flagged(): Flagged {
    const v = this.kv.get<Flagged>(CLOSURE_FLAGGED_KEY);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  }

  /** The new flags among `found` (see `isNewFlag`), remembered as flagged at `now`. */
  private takeNew(found: readonly Detection[], resolutions: Readonly<Record<string, UserResolution>>, now: number): Detection[] {
    const flagged = this.flagged();
    const fresh: Detection[] = [];
    const seen = new Set<string>();
    for (const d of found) {
      if (d.signals.length === 0 || seen.has(d.placeId)) continue;
      seen.add(d.placeId);
      if (!isNewFlag(flagged[d.placeId], resolutions[d.placeId])) continue;
      fresh.push(d);
      flagged[d.placeId] = now;
    }
    if (fresh.length > 0) {
      const kept = Object.entries(flagged).sort((a, b) => b[1] - a[1]).slice(0, MAX_FLAGGED);
      this.kv.set(CLOSURE_FLAGGED_KEY, Object.fromEntries(kept));
    }
    return fresh;
  }

  private add(fresh: WhatsNewEntry[]): void {
    if (fresh.length === 0) return;
    this.kv.set(CLOSURE_LOG_KEY, [...fresh, ...this.entries()].slice(0, MAX_CLOSURE_ENTRIES));
    for (const l of listeners) l();
  }

  /** A check (monthly run or card opened): one entry per newly flagged place. */
  recordChecks(found: readonly Detection[], resolutions: Readonly<Record<string, UserResolution>>, now: number): WhatsNewEntry[] {
    const fresh = this.takeNew(found, resolutions, now).map((d, i) => entryOf(d, now, i));
    this.add([...fresh].reverse());
    return fresh;
  }

  /** An import: one grouped entry ("N imported places…"), or a single place's own entry. */
  recordImport(found: readonly Detection[], resolutions: Readonly<Record<string, UserResolution>>, now: number): WhatsNewEntry | null {
    const fresh = this.takeNew(found, resolutions, now);
    if (fresh.length === 0) return null;
    const entry: WhatsNewEntry =
      fresh.length === 1
        ? entryOf(fresh[0]!, now, 0)
        : {
            id: `${now.toString(36)}-0-closureImport`,
            owner: OWN_ENTRY_OWNER,
            kind: 'closureImport',
            at: now,
            count: fresh.length,
            placeIds: fresh.slice(0, MAX_IDS).map((d) => d.placeId),
          };
    this.add([entry]);
    return entry;
  }
}

function entryOf(d: Detection, now: number, i: number): WhatsNewEntry {
  const signal = mainSignal(d.signals);
  return {
    id: `${now.toString(36)}-${i.toString(36)}-closure`,
    owner: OWN_ENTRY_OWNER,
    kind: 'closure',
    at: now,
    placeId: d.placeId,
    name: d.name,
    ...(signal && { signal }),
  };
}
