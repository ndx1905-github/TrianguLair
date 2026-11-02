// SPDX-License-Identifier: MPL-2.0
/**
 * TrianguLair's own export (T-115): one GeoJSON FeatureCollection, openable
 * as is in uMap, QGIS, Organic Maps or geojson.io, that also carries
 * everything needed for a lossless re-import in a foreign member
 * (RFC 7946 §6.1) `triangulair`: tags (tree, colors, icons, OSM categories),
 * lists (filters, manual items, visibility, link key), tag mappings.
 *
 * Each feature is one of my saves (places and zones, trash included):
 * `id` is the place id (`osm:node/1`, `local:…`), the geometry is the saved
 * snapshot's, and the properties hold name, category, OSM reference, tags
 * (names for other tools, ids for re-import), comment and its visibility,
 * status, price, sharing, dates and photo metadata (not the photo files).
 *
 * Versions follow the spec's "Format versions": `version` is the major
 * (a reader refuses a higher one), `minor` marks compatible additions
 * (unknown fields are then ignored).
 */
import {
  parseOsmPlaceId,
  type CommentVisibility,
  type DataStore,
  type ListFilter,
  type PlaceGeometry,
  type PriceLevel,
  type Repository,
  type SaveStatus,
  type Sharing,
  type ZoneEdge,
} from '@triangulair/data';
import type { Feature, FeatureCollection } from 'geojson';

import type { ExportedList, ImportedPlace, ParseResult, ParseWarning, SourceTag } from '../model.ts';
import { locate } from './geojson.ts';

export const EXPORT_FORMAT = 'triangulair-export';
export const EXPORT_VERSION = 1;
export const EXPORT_MINOR = 0;

export interface ExportTag {
  id: string;
  name: string;
  parent_id: string | null;
  color: string | null;
  icon: string | null;
  osm_categories: string[];
  deleted_at: string | null;
}

export interface ExportMeta {
  format: typeof EXPORT_FORMAT;
  version: number;
  minor?: number;
  exported_at: string;
  app?: string;
  owner: string;
  tags: ExportTag[];
  lists: {
    id: string;
    name: string;
    description: string;
    visibility: 'link' | 'public';
    link_key: string | null;
    kind: 'filter' | 'manual';
    filter: ListFilter;
    items: string[];
    created_at: string;
    deleted_at: string | null;
  }[];
  tag_mappings: { person_id: string; their_tag: string; my_tag_id: string }[];
}

export interface ExportProperties {
  name: string;
  /** OSM reference "node/123" (null for a manual point or a drawn zone). */
  osm: string | null;
  osm_url?: string;
  category: string | null;
  kind: 'place' | 'zone';
  edge?: ZoneEdge;
  /** Tag names, main first (for other tools). */
  tags: string[];
  tag_ids: string[];
  main_tag_id: string | null;
  comment: string;
  comment_visibility: CommentVisibility;
  status: SaveStatus | null;
  price_level: PriceLevel | null;
  sharing: Sharing;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  address?: string;
  website?: string;
  media?: { id: string; file: string; blurhash: string | null; width: number | null; height: number | null }[];
}

export type ExportDocument = FeatureCollection<PlaceGeometry, ExportProperties> & { triangulair: ExportMeta };

const iso = (ms: number) => new Date(ms).toISOString();
const isoOrNull = (ms: number | null) => (ms === null ? null : iso(ms));

export interface ExportOptions {
  now?: () => number;
  /** "TrianguLair 0.1.0". */
  app?: string;
}

/** Everything I own, as a GeoJSON document (pure read of the repository). */
export function buildExport(source: DataStore | Repository, opts: ExportOptions = {}): ExportDocument {
  const repo: Repository = 'repo' in source ? source.repo : source;
  const tags = repo.tags();
  const tagName = new Map(tags.map((t) => [t.id, t.name]));
  const features: Feature<PlaceGeometry, ExportProperties>[] = [];
  const saves = repo
    .ownSaveIds()
    .map((id) => repo.getSave(id))
    .filter((s) => s !== null)
    .sort((a, b) => a.createdAt - b.createdAt || (a.placeId < b.placeId ? -1 : 1));
  let meId = '';
  for (const s of saves) {
    meId = s.ownerId;
    const place = repo.getPlace(s.placeId);
    if (!place) continue;
    const media = repo.getMedia(s.id);
    const props: ExportProperties = {
      name: place.name,
      osm: place.osmType && place.osmId ? `${place.osmType}/${place.osmId}` : null,
      ...(place.osmType && place.osmId && { osm_url: `https://www.openstreetmap.org/${place.osmType}/${place.osmId}` }),
      category: place.category,
      kind: place.kind,
      ...(place.kind === 'zone' && { edge: place.edge }),
      tags: s.tagIds.map((id) => tagName.get(id)).filter((n): n is string => !!n),
      tag_ids: s.tagIds,
      main_tag_id: s.mainTagId,
      comment: s.comment,
      comment_visibility: s.commentVisibility,
      status: s.status,
      price_level: s.priceLevel,
      sharing: s.sharing,
      created_at: iso(s.createdAt),
      updated_at: iso(s.updatedAt),
      deleted_at: isoOrNull(s.deletedAt),
      ...(place.address && { address: place.address }),
      ...(place.website && { website: place.website }),
      ...(media.length > 0 && {
        media: media.map((m) => ({ id: m.id, file: m.file, blurhash: m.blurhash, width: m.width, height: m.height })),
      }),
    };
    features.push({ type: 'Feature', id: place.id, geometry: place.geometry, properties: props });
  }
  const meta: ExportMeta = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    minor: EXPORT_MINOR,
    exported_at: iso((opts.now ?? Date.now)()),
    ...(opts.app && { app: opts.app }),
    owner: meId || (tags[0]?.ownerId ?? ''),
    tags: tags.map((t) => ({
      id: t.id,
      name: t.name,
      parent_id: t.parentId,
      color: t.color,
      icon: t.icon,
      osm_categories: t.osmCategories,
      deleted_at: isoOrNull(t.deletedAt),
    })),
    lists: repo.lists({ includeDeleted: true }).map((l) => ({
      id: l.id,
      name: l.name,
      description: l.description,
      visibility: l.visibility,
      link_key: l.linkKey,
      kind: l.kind,
      filter: l.filter,
      items: l.manualItems,
      created_at: iso(l.createdAt),
      deleted_at: isoOrNull(l.deletedAt),
    })),
    tag_mappings: repo.tagMappings().map((m) => ({ person_id: m.personId, their_tag: m.theirTag, my_tag_id: m.myTagId })),
  };
  return { type: 'FeatureCollection', triangulair: meta, features };
}

export function exportGeoJson(source: DataStore | Repository, opts: ExportOptions = {}): string {
  return JSON.stringify(buildExport(source, opts), null, 1);
}

/** File name for an export: "triangulair-2026-11-02.geojson". */
export function exportFileName(now: number = Date.now()): string {
  return `triangulair-${new Date(now).toISOString().slice(0, 10)}.geojson`;
}

// ------------------------------------------------------------------ reading it back

export function isTriangulairExport(json: unknown): boolean {
  const m = (json as { triangulair?: { format?: unknown } } | null)?.triangulair;
  return !!m && m.format === EXPORT_FORMAT;
}

const ms = (v: unknown): number | undefined => {
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
};

const STATUSES: readonly SaveStatus[] = ['to_try', 'tried', 'favorite'];
const VIS: readonly CommentVisibility[] = ['private', 'friends', 'public'];

export function parseTriangulairExport(json: unknown): ParseResult {
  const doc = json as Partial<ExportDocument>;
  const meta = doc.triangulair!;
  if (typeof meta.version !== 'number' || meta.version > EXPORT_VERSION) {
    throw new Error(`This export was made by a newer version of TrianguLair (format ${String(meta.version)}). Update the app to import it.`);
  }
  const warnings: ParseWarning[] = [];
  if ((meta.minor ?? 0) > EXPORT_MINOR) warnings.push({ code: 'newer-version', detail: `${meta.version}.${meta.minor}` });
  const tags: SourceTag[] = (meta.tags ?? []).map((t) => ({
    key: t.id,
    name: t.name,
    ...(t.color && { color: t.color }),
    ...(t.icon && { icon: t.icon }),
    ...(t.parent_id && { parentKey: t.parent_id }),
    ...(t.osm_categories?.length && { osmCategories: t.osm_categories }),
    ...(t.deleted_at && { deleted: true }),
  }));
  const places: ImportedPlace[] = [];
  (doc.features ?? []).forEach((f, i) => {
    const p = (f.properties ?? {}) as Partial<ExportProperties>;
    const key = `t${i}`;
    const located = locate(f.geometry);
    if (located.lat === undefined || typeof p.name !== 'string' || !p.name.trim()) {
      warnings.push({ code: located.lat === undefined ? 'bad-coordinates' : 'no-name', at: key });
      return;
    }
    const placeId = typeof f.id === 'string' ? f.id : undefined;
    const osmFromId = placeId ? parseOsmPlaceId(placeId) : null;
    const osmRef = typeof p.osm === 'string' ? /^(node|way|relation)\/(\d+)$/.exec(p.osm) : null;
    const osm = osmRef ? { type: osmRef[1] as 'node' | 'way' | 'relation', id: Number(osmRef[2]) } : osmFromId ? { type: osmFromId.osmType, id: osmFromId.osmId } : undefined;
    const createdAt = ms(p.created_at);
    places.push({
      key,
      name: p.name,
      lat: located.lat,
      lon: located.lon!,
      ...(located.shape && { shape: { geometry: located.shape.geometry, ...(p.edge && { edge: p.edge }) } }),
      ...(p.address && { address: p.address }),
      tags: Array.isArray(p.tag_ids) ? p.tag_ids.filter((t): t is string => typeof t === 'string') : [],
      ...(p.main_tag_id && { mainTag: p.main_tag_id }),
      ...(p.comment && { comment: p.comment }),
      ...(p.status && STATUSES.includes(p.status) && { status: p.status }),
      ...(p.osm_url && { url: p.osm_url }),
      ids: { ...(osm && { osm }), ...(placeId && { placeId }) },
      ...(createdAt && { createdAt }),
      ...(p.category && { category: p.category }),
      ...(p.price_level && [1, 2, 3, 4].includes(p.price_level) && { priceLevel: p.price_level }),
      ...(p.sharing && (p.sharing === 'private' || p.sharing === 'friends') && { sharing: p.sharing }),
      ...(p.comment_visibility && VIS.includes(p.comment_visibility) && { commentVisibility: p.comment_visibility }),
      ...(p.kind && { kind: p.kind }),
      ...(p.deleted_at && { trashed: true }),
      ...(Array.isArray(p.media) && p.media.length > 0 && { media: p.media }),
    });
  });
  const lists: ExportedList[] = (meta.lists ?? []).map((l) => ({
    id: l.id,
    name: l.name,
    description: l.description ?? '',
    visibility: l.visibility,
    linkKey: l.link_key ?? null,
    kind: l.kind,
    filter: l.filter ?? {},
    items: l.items ?? [],
    createdAt: ms(l.created_at) ?? 0,
    deletedAt: ms(l.deleted_at) ?? null,
  }));
  return {
    format: 'triangulair',
    places,
    tags,
    warnings,
    extras: {
      lists,
      tagMappings: (meta.tag_mappings ?? []).map((m) => ({ personId: m.person_id, theirTag: m.their_tag, myTag: m.my_tag_id })),
    },
  };
}
