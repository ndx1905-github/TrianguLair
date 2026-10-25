/**
 * Closed-place check, network part: refreshes a batch of places from
 * Overpass (which also refreshes their cards, as the spec asks), confirms
 * deletions with the OSM API, looks for a new business at the same spot,
 * and turns all that into signals and a status.
 */
import { isAbortError } from '../errors.ts';
import { type PlaceInfo, normalizeElement } from '../normalize.ts';
import type { OsmApiClient } from '../osmapi.ts';
import type { NearbyPlace, OverpassClient } from '../overpass.ts';
import type { OsmRef, RequestOptions } from '../types.ts';
import { refKey } from '../types.ts';
import {
  type ClosureAssessment,
  type ClosureReport,
  type ClosureSignal,
  type OsmObservation,
  type PlaceSnapshot,
  type UserResolution,
  assessClosure,
  osmSignals,
  reportSignals,
  sameName,
  snapshotOf,
} from './signals.ts';

export interface CheckInput {
  ref: OsmRef;
  /** Snapshot stored at the previous check (name, category, hours, version, location). */
  previous?: PlaceSnapshot;
  /** The user's last answer to a "maybe closed" notice. */
  resolution?: UserResolution;
  /** "Closed" reports from me and friends. */
  reports?: ClosureReport[];
}

export interface CheckResult {
  ref: OsmRef;
  checkedAt: string;
  observation: OsmObservation;
  /** Fresh card data (null when deleted/missing or no longer a place). */
  place: PlaceInfo | null;
  /** Store this for the next check (unchanged previous snapshot if the element is gone). */
  snapshot: PlaceSnapshot | undefined;
  signals: ClosureSignal[];
  assessment: ClosureAssessment;
  /** A different named place at the same spot (likely the new business). */
  successor?: NearbyPlace;
}

export interface ClosureCheckerOptions {
  overpass: OverpassClient;
  /** Confirms deletions (410 Gone) and their date; without it, a missing element gives `not_found`. */
  osmApi?: OsmApiClient;
  /** Cap on OSM API lookups per run (the OSM API is for editing; stay light). Default 10. */
  maxDeletionChecks?: number;
  /** Look for a new business within this radius (m) when a closure signal is found; 0 disables. Default 20. */
  successorRadius?: number;
  now?: () => Date;
}

const STRONG = new Set(['deleted', 'not_found', 'lifecycle_prefix', 'lifecycle_tag', 'shop_vacant', 'end_date_past']);

export class ClosureChecker {
  private readonly maxDeletionChecks: number;
  private readonly successorRadius: number;
  private readonly now: () => Date;

  constructor(private readonly o: ClosureCheckerOptions) {
    this.maxDeletionChecks = o.maxDeletionChecks ?? 10;
    this.successorRadius = o.successorRadius ?? 20;
    this.now = o.now ?? (() => new Date());
  }

  /** Checks a batch (use `placesDueForCheck` to pick it). Always bypasses the cache. */
  async check(inputs: CheckInput[], opts: RequestOptions = {}): Promise<CheckResult[]> {
    if (inputs.length === 0) return [];
    const reqOpts: RequestOptions = { ...opts, cache: 'reload' };
    const { found } = await this.o.overpass.getElements(
      inputs.map((i) => i.ref),
      reqOpts,
    );
    const now = this.now();
    let apiBudget = this.maxDeletionChecks;
    const results: CheckResult[] = [];

    for (const input of inputs) {
      let observation: OsmObservation;
      const el = found.get(refKey(input.ref));
      if (el) {
        observation = { kind: 'present', element: el };
      } else if (this.o.osmApi && apiBudget > 0) {
        apiBudget--;
        observation = await this.confirmMissing(input.ref, opts);
      } else {
        observation = { kind: 'missing' };
      }

      const signals = [...osmSignals(observation, input.previous, now), ...reportSignals(input.reports ?? [], now)];
      const assessment = assessClosure(signals, input.resolution);
      const place = observation.kind === 'present' ? normalizeElement(observation.element) : null;
      const result: CheckResult = {
        ref: input.ref,
        checkedAt: now.toISOString(),
        observation,
        place,
        snapshot: observation.kind === 'present' ? snapshotOf(observation.element) : input.previous,
        signals,
        assessment,
      };

      const location = place?.location ?? input.previous?.location;
      if (this.successorRadius > 0 && location && assessment.signals.some((s) => STRONG.has(s.code))) {
        const successor = await this.findSuccessor(input, location, opts);
        if (successor) result.successor = successor;
      }
      results.push(result);
    }
    return results;
  }

  private async confirmMissing(ref: OsmRef, opts: RequestOptions): Promise<OsmObservation> {
    try {
      const r = await this.o.osmApi!.lookup(ref, { ...opts, withHistory: true, cache: 'reload' });
      if (r.status === 'present') return { kind: 'present', element: r.element };
      if (r.status === 'deleted') {
        return {
          kind: 'deleted',
          ...(r.deletedAt ? { deletedAt: r.deletedAt } : {}),
          ...(r.lastVersion ? { lastVersion: r.lastVersion } : {}),
        };
      }
      // 404: the id never existed (bad import or redacted): as good as deleted.
      return { kind: 'deleted' };
    } catch (e) {
      if (isAbortError(e)) throw e;
      return { kind: 'missing' };
    }
  }

  private async findSuccessor(
    input: CheckInput,
    location: { lat: number; lon: number },
    opts: RequestOptions,
  ): Promise<NearbyPlace | undefined> {
    try {
      const around = await this.o.overpass.nearby(location, { ...opts, radius: this.successorRadius, limit: 5 });
      const oldName = input.previous?.name;
      return around.find(
        (p) =>
          refKey(p.ref) !== refKey(input.ref) &&
          p.distance <= this.successorRadius &&
          !!p.name &&
          (!oldName || !sameName(oldName, p.name)),
      );
    } catch (e) {
      if (isAbortError(e)) throw e;
      return undefined;
    }
  }
}
