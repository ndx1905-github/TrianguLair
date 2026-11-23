/**
 * Runs closed-place checks against OSM (T-113) and writes the results to the
 * place cache. Only ever called while the app is in use (on open, on return
 * to the foreground, when a card opens): there is no background task.
 */
import type { DataStore, PlaceRecord, Repository } from '@triangulair/data';
import type { CheckResult, OsmClient } from '@triangulair/osm';
import { SqliteStateStore } from '@triangulair/sync';

import { getSetting, setSetting } from '../data/deviceSettings';
import {
  checkInputOf,
  dueCandidates,
  MAX_BATCHES_PER_RUN,
  parseResolutions,
  patchFromResolution,
  patchFromResult,
  readSignals,
  RESOLUTIONS_KEY,
  RUN_BATCH,
  type ResolutionMap,
} from './glue';
import { ClosureEventLog, type Detection } from './events';

export function loadResolutions(): ResolutionMap {
  return parseResolutions(getSetting(RESOLUTIONS_KEY));
}

export function saveResolution(placeId: string, decision: 'closed' | 'still_open', now = new Date()): void {
  const all = loadResolutions();
  all[placeId] = { decision, decidedAt: now.toISOString() };
  setSetting(RESOLUTIONS_KEY, JSON.stringify(all));
}

/** What's new entries of my places that may no longer exist (local database, this device only). */
export function closureLogOf(store: DataStore): ClosureEventLog {
  return new ClosureEventLog(new SqliteStateStore(store.repo.db));
}

/** Records the places newly flagged "maybe closed" in What's new (never fails a check). */
export function recordDetections(store: DataStore, found: readonly Detection[], how: 'check' | 'import', now = Date.now()): void {
  if (found.length === 0) return;
  try {
    const log = closureLogOf(store);
    if (how === 'import') log.recordImport(found, loadResolutions(), now);
    else log.recordChecks(found, loadResolutions(), now);
  } catch (e) {
    console.warn('Could not record the closed-place news', e);
  }
}

/** My saved places from OpenStreetMap (manual points are never checked). */
export function myOsmPlaces(repo: Repository): PlaceRecord[] {
  const out: PlaceRecord[] = [];
  for (const hit of repo.queryPlaces({ source: 'mine', limit: 100_000 })) {
    if (!hit.osmType || hit.kind === 'zone') continue;
    const p = repo.getPlace(hit.id);
    if (p) out.push(p);
  }
  return out;
}

/** Checks the given places (one Overpass batch) and stores the results. */
export async function checkPlaces(
  places: readonly PlaceRecord[],
  osm: OsmClient,
  mutate: <T>(fn: (store: DataStore) => T) => T,
  signal?: AbortSignal,
): Promise<CheckResult[]> {
  const resolutions = loadResolutions();
  const inputs = places.map((p) => checkInputOf(p, resolutions[p.id])).filter((x) => x !== null);
  if (inputs.length === 0) return [];
  const results = await osm.closure.check(inputs, signal ? { signal } : {});
  if (signal?.aborted) return [];
  const byRef = new Map(places.map((p) => [`${p.osmType}/${p.osmId}`, p]));
  mutate((store) => {
    const found: Detection[] = [];
    store.repo.transaction(() => {
      for (const r of results) {
        const p = byRef.get(`${r.ref.type}/${r.ref.id}`);
        if (!p) continue;
        store.repo.updatePlaceOsmData(p.id, patchFromResult(r));
        if (r.assessment.status === 'maybe_closed') found.push({ placeId: p.id, name: p.name, signals: r.assessment.signals });
      }
    });
    // "May no longer exist according to OpenStreetMap" in What's new, dated now.
    recordDetections(store, found, 'check', Date.parse(results[0]?.checkedAt ?? '') || Date.now());
  });
  return results;
}

/** One run when the app opens: due places, never-checked first, a few small batches. */
export async function runDueChecks(
  repo: Repository,
  osm: OsmClient,
  mutate: <T>(fn: (store: DataStore) => T) => T,
  signal: AbortSignal,
  now = new Date(),
): Promise<number> {
  const places = myOsmPlaces(repo);
  const byId = new Map(places.map((p) => [p.id, p]));
  const due = dueCandidates(places, now, RUN_BATCH * MAX_BATCHES_PER_RUN);
  let checked = 0;
  for (let i = 0; i < due.length && !signal.aborted; i += RUN_BATCH) {
    const batch = due.slice(i, i + RUN_BATCH).map((c) => byId.get(c.placeId)!);
    const res = await checkPlaces(batch, osm, mutate, signal);
    checked += res.length;
  }
  return checked;
}

/** "Confirm closed" / "Still open" on the card. */
export function resolveClosure(
  place: PlaceRecord,
  decision: 'closed' | 'still_open',
  mutate: <T>(fn: (store: DataStore) => T) => T,
  now = new Date(),
): void {
  saveResolution(place.id, decision, now);
  mutate((store) => store.repo.updatePlaceOsmData(place.id, patchFromResolution(decision, readSignals(place))));
}
