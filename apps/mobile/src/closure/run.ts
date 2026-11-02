/**
 * Runs closed-place checks against OSM (T-113) and writes the results to the
 * place cache. Only ever called while the app is in use (on open, on return
 * to the foreground, when a card opens): there is no background task.
 */
import type { DataStore, PlaceRecord, Repository } from '@triangulair/data';
import type { CheckResult, OsmClient } from '@triangulair/osm';

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

export function loadResolutions(): ResolutionMap {
  return parseResolutions(getSetting(RESOLUTIONS_KEY));
}

export function saveResolution(placeId: string, decision: 'closed' | 'still_open', now = new Date()): void {
  const all = loadResolutions();
  all[placeId] = { decision, decidedAt: now.toISOString() };
  setSetting(RESOLUTIONS_KEY, JSON.stringify(all));
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
  mutate((store) =>
    store.repo.transaction(() => {
      for (const r of results) {
        const p = byRef.get(`${r.ref.type}/${r.ref.id}`);
        if (p) store.repo.updatePlaceOsmData(p.id, patchFromResult(r));
      }
    }),
  );
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
