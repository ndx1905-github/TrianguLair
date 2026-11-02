// SPDX-License-Identifier: MPL-2.0
/**
 * The import preview: what will happen to each imported place (linked to an
 * OSM object, to check, manual point, skipped), duplicates folded (in the
 * file, and against my existing saves, spec "No duplicates"), and what each
 * source tag becomes (one of my tags, a new tag, or nothing).
 *
 * Pure functions over the parse result, the match outcomes and the
 * repository's reads; the preview screen edits `resolution` and tag actions,
 * then calls `refreshPlan` and finally `applyImport`.
 */
import {
  bboxAround,
  DEDUP_DEFAULTS,
  haversineM,
  nameSimilarity,
  normalizeText,
  placeIdFromOsm,
  type LatLon,
  type Repository,
  type TagRecord,
} from '@triangulair/data';

import type { MatchOutcome, OsmCandidate, ScoredCandidate } from './match.ts';
import type { ExportExtras, ImportedPlace, ParseResult, ParseWarning, SourceFormat, SourceTag } from './model.ts';
import { FORMAT_VERIFIED } from './model.ts';

export type Resolution =
  /** Link to this OSM object. */
  | { kind: 'osm'; candidate: OsmCandidate }
  /** Keep the identity the source gave (OSM reference or exported place id). */
  | { kind: 'source' }
  /** A manual point at the imported (or geocoded) position, or a zone with its shape. */
  | { kind: 'manual' }
  | { kind: 'skip' };

export interface ExistingSave {
  placeId: string;
  name: string;
  /** The same place (same id), or a manual point nearby with a similar name. */
  reason: 'same-place' | 'nearby-similar';
  inTrash: boolean;
}

export type ItemGroup = 'matched' | 'ambiguous' | 'manual' | 'unlocated';

export interface PlanItem {
  key: string;
  place: ImportedPlace;
  match: MatchOutcome;
  resolution: Resolution;
  /** Position used for a manual point (imported, or found by the address search). */
  position: LatLon | null;
  /** Key of the item this one is folded into (same target place). */
  duplicateOf: string | null;
  /** My save it will be merged into, if any. */
  existing: ExistingSave | null;
}

export type TagAction =
  | { kind: 'map'; tagId: string }
  | { kind: 'create'; name: string; color: string | null }
  | { kind: 'skip' };

export interface TagPlanEntry {
  source: SourceTag;
  /** Number of imported places with this tag. */
  count: number;
  action: TagAction;
}

export interface ImportPlan {
  format: SourceFormat;
  verified: boolean;
  items: PlanItem[];
  tags: TagPlanEntry[];
  warnings: ParseWarning[];
  extras?: ExportExtras;
}

/** Colors for new tags without a source color: the app's vivid palette (spec "Colors and categories"). */
export const DEFAULT_TAG_COLORS = ['#EF4444', '#3B82F6', '#16A34A', '#D97706', '#8B5CF6', '#0891B2', '#EC4899', '#65A30D', '#EA580C', '#6366F1', '#0D9488', '#A16207'];

/** Which section of the preview an item belongs to (by how it was matched, not by the user's choice). */
export function groupOf(item: PlanItem): ItemGroup {
  switch (item.match.kind) {
    case 'source':
    case 'matched':
      return 'matched';
    case 'ambiguous':
      return 'ambiguous';
    case 'manual':
      return 'manual';
    case 'unlocated':
      return 'unlocated';
  }
}

function positionOf(p: ImportedPlace, m: MatchOutcome): LatLon | null {
  if (p.lat !== undefined && p.lon !== undefined) return { lat: p.lat, lon: p.lon };
  if ((m.kind === 'manual' || m.kind === 'ambiguous') && m.geocoded) return m.geocoded;
  return null;
}

/** The default choice for a match outcome. */
export function initialResolution(m: MatchOutcome, position: LatLon | null): Resolution {
  switch (m.kind) {
    case 'source':
      return { kind: 'source' };
    case 'matched':
      return { kind: 'osm', candidate: m.best };
    case 'ambiguous': {
      // Pre-select a likely candidate; the item stays in "to check".
      const best = m.candidates[0];
      if (best && best.similarity >= 0.6) return { kind: 'osm', candidate: best };
      return position ? { kind: 'manual' } : best ? { kind: 'osm', candidate: best } : { kind: 'skip' };
    }
    case 'manual':
      return position ? { kind: 'manual' } : { kind: 'skip' };
    case 'unlocated':
      return { kind: 'skip' };
  }
}

/** The place id the item will be saved under, when known before writing (null: a new manual point). */
export function targetPlaceId(item: PlanItem): string | null {
  const r = item.resolution;
  if (r.kind === 'osm') return placeIdFromOsm(r.candidate.ref.type, r.candidate.ref.id);
  if (r.kind === 'source') {
    const { osm, placeId } = item.place.ids;
    if (osm) return placeIdFromOsm(osm.type, osm.id);
    return placeId ?? null;
  }
  return null;
}

/** Where the item will be on the map (for the preview map and dedup). */
export function itemPoint(item: PlanItem): LatLon | null {
  const r = item.resolution;
  if (r.kind === 'osm') return { lat: r.candidate.lat, lon: r.candidate.lon };
  if (r.kind === 'skip') return null;
  return item.position;
}

// ------------------------------------------------------------------ tags

function tagPath(t: Pick<TagRecord, 'id' | 'name' | 'parentId'>, byId: Map<string, Pick<TagRecord, 'id' | 'name' | 'parentId'>>): string {
  const parts: string[] = [];
  let cur: typeof t | undefined = t;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    parts.unshift(normalizeText(cur.name));
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return parts.join('/');
}

/**
 * Source tag → my tag with the same name (accent- and case-insensitive; for
 * sub-tags of an export, the same path), else a new tag with the source's
 * color or one of the palette.
 */
export function proposeTagActions(
  sourceTags: readonly SourceTag[],
  places: readonly ImportedPlace[],
  myTags: readonly (TagRecord & { active?: boolean })[],
  opts: { paletteForMissing?: boolean } = {},
): TagPlanEntry[] {
  const palette = opts.paletteForMissing ?? true;
  const counts = new Map<string, number>();
  for (const p of places) for (const t of new Set(p.tags)) counts.set(t, (counts.get(t) ?? 0) + 1);
  const defs = new Map(sourceTags.map((t) => [t.key, t]));
  for (const k of counts.keys()) if (!defs.has(k)) defs.set(k, { key: k, name: k });
  const live = myTags.filter((t) => t.deletedAt === null);
  const myById = new Map(live.map((t) => [t.id, t]));
  const myByPath = new Map<string, string>();
  for (const t of live) if (!myByPath.has(tagPath(t, myById))) myByPath.set(tagPath(t, myById), t.id);
  // A tag that was in the trash when exported meets my trashed tag of the same path (re-import of my own export).
  const allById = new Map(myTags.map((t) => [t.id, t]));
  const trashedByPath = new Map<string, string>();
  for (const t of myTags) if (t.deletedAt !== null && !trashedByPath.has(tagPath(t, allById))) trashedByPath.set(tagPath(t, allById), t.id);
  const srcById = new Map([...defs.values()].map((t) => [t.key, { id: t.key, name: t.name, parentId: t.parentKey ?? null }]));
  let color = 0;
  const usedColors = new Set(live.map((t) => t.color?.toUpperCase()));
  const nextColor = () => {
    for (let i = 0; i < DEFAULT_TAG_COLORS.length; i++) {
      const c = DEFAULT_TAG_COLORS[(color + i) % DEFAULT_TAG_COLORS.length]!;
      if (!usedColors.has(c)) {
        color += i + 1;
        usedColors.add(c);
        return c;
      }
    }
    return DEFAULT_TAG_COLORS[color++ % DEFAULT_TAG_COLORS.length]!;
  };
  return [...defs.values()].map((source) => {
    const path = tagPath(srcById.get(source.key)!, srcById);
    const existing = myByPath.get(path) ?? (source.deleted ? trashedByPath.get(path) : undefined);
    const action: TagAction = existing
      ? { kind: 'map', tagId: existing }
      : { kind: 'create', name: source.name, color: source.color ?? (palette ? nextColor() : null) };
    return { source, count: counts.get(source.key) ?? 0, action };
  });
}

// ------------------------------------------------------------------ duplicates

const MERGE_RADIUS_M = DEDUP_DEFAULTS.maxDistanceM;
const MERGE_SIMILARITY = DEDUP_DEFAULTS.minSimilarity;

/**
 * Recomputes duplicates (in the file) and existing saves after any change of
 * resolution. Items with the same target place are folded into the first; two
 * manual points within 30 m with similar names too (same rule as the data
 * package's duplicate suggestions).
 */
export function refreshPlan(plan: ImportPlan, repo: Repository | null): ImportPlan {
  const items = plan.items.map((it) => ({ ...it, duplicateOf: null as string | null, existing: null as ExistingSave | null }));
  const byTarget = new Map<string, string>();
  const manual: PlanItem[] = [];
  for (const it of items) {
    if (it.resolution.kind === 'skip') continue;
    const target = targetPlaceId(it);
    if (target) {
      const first = byTarget.get(target);
      if (first) it.duplicateOf = first;
      else byTarget.set(target, it.key);
      continue;
    }
    const pt = itemPoint(it);
    if (!pt) {
      manual.push(it);
      continue;
    }
    const twin = manual.find((m) => {
      const q = itemPoint(m);
      return q && !m.place.shape === !it.place.shape && haversineM(pt, q) <= MERGE_RADIUS_M && nameSimilarity(m.place.name, it.place.name) >= MERGE_SIMILARITY;
    });
    if (twin) it.duplicateOf = twin.key;
    else manual.push(it);
  }
  if (repo) {
    for (const it of items) {
      if (it.resolution.kind === 'skip' || it.duplicateOf) continue;
      const target = targetPlaceId(it);
      if (target) {
        const s = repo.getMySaveForPlace(target);
        if (s) it.existing = { placeId: target, name: repo.getPlace(target)?.name ?? it.place.name, reason: 'same-place', inTrash: s.deletedAt !== null };
        continue;
      }
      const pt = itemPoint(it);
      if (!pt) continue;
      const kind = it.place.kind ?? (it.place.shape ? 'zone' : 'place');
      const near = repo.queryPlaces({ bbox: bboxAround(pt, MERGE_RADIUS_M), source: 'mine', limit: 50 });
      // Zones: the same rule on their representative point (a re-imported drawn zone is the same zone).
      const hit = near
        .filter((h) => h.mine && h.kind === kind && haversineM(pt, h) <= MERGE_RADIUS_M && nameSimilarity(h.name, it.place.name) >= MERGE_SIMILARITY)
        .sort((a, b) => nameSimilarity(b.name, it.place.name) - nameSimilarity(a.name, it.place.name))[0];
      if (hit) it.existing = { placeId: hit.id, name: hit.name, reason: 'nearby-similar', inTrash: false };
    }
  }
  return { ...plan, items };
}

export function buildPlan(result: ParseResult, matches: Map<string, MatchOutcome>, repo: Repository | null): ImportPlan {
  const items: PlanItem[] = result.places.map((place) => {
    const match = matches.get(place.key) ?? { kind: place.lat === undefined ? 'unlocated' : 'manual', candidates: [] };
    const position = positionOf(place, match);
    return { key: place.key, place, match, resolution: initialResolution(match, position), position, duplicateOf: null, existing: null };
  });
  const plan: ImportPlan = {
    format: result.format,
    verified: FORMAT_VERIFIED[result.format],
    items,
    // My own export keeps tags without a color as they were.
    tags: proposeTagActions(result.tags, result.places, repo ? repo.tags() : [], { paletteForMissing: result.format !== 'triangulair' }),
    warnings: result.warnings,
    ...(result.extras && { extras: result.extras }),
  };
  return refreshPlan(plan, repo);
}

/** Changes one item's resolution (the preview's choice), then recomputes duplicates. */
export function resolveItem(plan: ImportPlan, key: string, resolution: Resolution, repo: Repository | null): ImportPlan {
  return refreshPlan({ ...plan, items: plan.items.map((it) => (it.key === key ? { ...it, resolution } : it)) }, repo);
}

export function setTagAction(plan: ImportPlan, sourceKey: string, action: TagAction): ImportPlan {
  return { ...plan, tags: plan.tags.map((t) => (t.source.key === sourceKey ? { ...t, action } : t)) };
}

export interface PlanSummary {
  total: number;
  /** Linked to OSM automatically (or by the source). */
  matched: number;
  /** Doubtful matches, to check. */
  ambiguous: number;
  /** Manual points. */
  manual: number;
  /** No position, nothing found. */
  unlocated: number;
  /** Will be written as new saves. */
  toCreate: number;
  /** Folded into an existing save of mine. */
  toMerge: number;
  /** Folded into another place of the same file. */
  duplicates: number;
  skipped: number;
  linkedToOsm: number;
}

export function summarizePlan(plan: ImportPlan): PlanSummary {
  const s: PlanSummary = { total: plan.items.length, matched: 0, ambiguous: 0, manual: 0, unlocated: 0, toCreate: 0, toMerge: 0, duplicates: 0, skipped: 0, linkedToOsm: 0 };
  for (const it of plan.items) {
    s[groupOf(it)]++;
    if (it.resolution.kind === 'skip') s.skipped++;
    else if (it.duplicateOf) s.duplicates++;
    else if (it.existing) s.toMerge++;
    else s.toCreate++;
    if (it.resolution.kind !== 'skip' && targetPlaceId(it)?.startsWith('osm:')) s.linkedToOsm++;
  }
  return s;
}

export type { ScoredCandidate };
