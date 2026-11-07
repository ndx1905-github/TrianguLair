/**
 * What the app keeps about storages, as one secret-store entry (`storage`, spec "Loss and
 * theft": storage credentials in the system's secure vault). Pure parse/serialize, tested.
 */
import { parseConfig, type StorageConfig } from './config';

export const STORAGE_STATE_VERSION = 1;

/** An earlier storage that still holds the signed redirect (and must have its credentials revoked after a theft). */
export interface PreviousStorage {
  config: StorageConfig;
  movedAt: number;
  /** Until when the redirect is kept (then the folder may be emptied). */
  keepUntil: number;
}

export interface StorageState {
  version: number;
  /** null: local only. */
  current: StorageConfig | null;
  /** When `current` was connected or last tested successfully. */
  connectedAt: number | null;
  lastTestAt: number | null;
  previous: PreviousStorage[];
  /**
   * A move whose certificate may already be issued but not recorded here yet (crash between the
   * two writes): on start, if the sharing certificate certifies `to.readUrl`, the move is finished.
   */
  pendingMove: { to: StorageConfig; startedAt: number } | null;
  /**
   * The sharing certificate changed (connect or move) and the index has not been published with
   * it yet: the sync engine publishes it at `current` and every `previous` redirect, then clears this.
   */
  republishPending: boolean;
}

export const LOCAL_ONLY: StorageState = { version: STORAGE_STATE_VERSION, current: null, connectedAt: null, lastTestAt: null, previous: [], pendingMove: null, republishPending: false };

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Defensive parse; anything broken gives local only (the credentials are then asked again). */
export function parseStorageState(s: string | null): StorageState {
  if (!s) return LOCAL_ONLY;
  try {
    const o = JSON.parse(s) as Record<string, unknown>;
    if (o['version'] !== STORAGE_STATE_VERSION) return LOCAL_ONLY;
    const previous: PreviousStorage[] = [];
    for (const p of Array.isArray(o['previous']) ? (o['previous'] as Record<string, unknown>[]) : []) {
      try {
        previous.push({ config: parseConfig(p['config']), movedAt: num(p['movedAt']) ?? 0, keepUntil: num(p['keepUntil']) ?? 0 });
      } catch {
        // skip a broken entry
      }
    }
    let pendingMove: StorageState['pendingMove'] = null;
    const pm = o['pendingMove'] as Record<string, unknown> | null | undefined;
    if (pm && typeof pm === 'object') {
      try {
        pendingMove = { to: parseConfig(pm['to']), startedAt: num(pm['startedAt']) ?? 0 };
      } catch {
        pendingMove = null;
      }
    }
    return {
      version: STORAGE_STATE_VERSION,
      current: o['current'] ? parseConfig(o['current']) : null,
      connectedAt: num(o['connectedAt']),
      lastTestAt: num(o['lastTestAt']),
      previous,
      pendingMove,
      republishPending: o['republishPending'] === true,
    };
  } catch {
    return LOCAL_ONLY;
  }
}

export function serializeStorageState(s: StorageState): string {
  return JSON.stringify(s);
}

/** State after a move to `to` is certified: the old storage becomes a redirect. */
export function afterMove(s: StorageState, to: StorageConfig, now: number, keepMs: number): StorageState {
  const previous = s.current ? [{ config: s.current, movedAt: now, keepUntil: now + keepMs }, ...s.previous] : s.previous;
  return {
    ...s,
    current: to,
    connectedAt: now,
    lastTestAt: now,
    // A storage we come back to is no longer a mere redirect.
    previous: previous.filter((p) => p.config.readUrl !== to.readUrl),
    pendingMove: null,
    republishPending: true,
  };
}

/** Finishes a move interrupted after the certificate was stored (see `pendingMove`). */
export function recoverPendingMove(s: StorageState, certifiedLocation: string | undefined, now: number, keepMs: number): StorageState {
  if (!s.pendingMove) return s;
  if (certifiedLocation === s.pendingMove.to.readUrl) return afterMove(s, s.pendingMove.to, now, keepMs);
  // The certificate was not issued: the move did not happen; the current storage is still valid.
  return { ...s, pendingMove: null };
}
