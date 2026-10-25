// SPDX-License-Identifier: MPL-2.0
/**
 * Domain types shared by the SQLite layer, the Automerge documents and the
 * list filters. Field names follow docs/SPEC.md, "Data model".
 */
import type { Geometry, LineString, MultiLineString, MultiPolygon, Point, Polygon } from 'geojson';

export type OsmType = 'node' | 'way' | 'relation';

/** Geometries a place or a zone may have (spec: point, line or polygon). */
export type PlaceGeometry = Point | LineString | MultiLineString | Polygon | MultiPolygon;
/** Area geometries usable as a filter zone. */
export type AreaGeometry = Polygon | MultiPolygon;

export type PlaceKind = 'place' | 'zone';
/** Edge indicator of a zone: "blurred" for a zone painted with a finger. */
export type ZoneEdge = 'sharp' | 'blurred';
/** Status of the place itself (OSM side, closed-place detection). */
export type PlaceStatus = 'open' | 'maybe_closed' | 'closed';

export type SaveStatus = 'to_try' | 'tried' | 'favorite';
export type CommentVisibility = 'private' | 'friends' | 'public';
/** "friends" by default; a private save never leaves the device and never enters a list. */
export type Sharing = 'private' | 'friends';
export type ListVisibility = 'link' | 'public';
export type ListKind = 'filter' | 'manual';
export type PriceLevel = 1 | 2 | 3 | 4;

/** [west, south, east, north] in degrees. west > east crosses the antimeridian. */
export type BBox = readonly [west: number, south: number, east: number, north: number];

export interface LatLon {
  lat: number;
  lon: number;
}

/**
 * The part of a place that travels with a save (in the Automerge document and,
 * later, in packs): identity, name and geometry. Everything else about a place
 * (opening hours, website, OSM tags…) is a local cache fetched from OSM.
 */
export interface PlaceSnapshot {
  /** Stable place id, see `placeIdFromOsm` / `newLocalPlaceId`. */
  id: string;
  osmType: OsmType | null;
  osmId: number | null;
  name: string;
  /** Main OSM category, `key=value` (e.g. `amenity=restaurant`). */
  category: string | null;
  kind: PlaceKind;
  edge: ZoneEdge;
  geometry: PlaceGeometry;
}

/** OSM-derived fields cached locally on the place card (never in the document). */
export interface PlaceOsmData {
  address?: string | null;
  openingHours?: string | null;
  website?: string | null;
  phone?: string | null;
  osmTags?: Record<string, string> | null;
  photos?: readonly string[] | null;
  status?: PlaceStatus;
  closedSignals?: readonly unknown[] | null;
  osmSyncedAt?: number | null;
}

export interface PlaceRecord extends PlaceSnapshot {
  /** Representative point (the point itself, or a point on/inside the shape). */
  lat: number;
  lon: number;
  bbox: BBox;
  address: string | null;
  openingHours: string | null;
  website: string | null;
  phone: string | null;
  osmTags: Record<string, string> | null;
  photos: string[] | null;
  status: PlaceStatus;
  closedSignals: unknown[] | null;
  osmSyncedAt: number | null;
}

export interface MediaRecord {
  id: string;
  saveId: string;
  file: string;
  blurhash: string | null;
  width: number | null;
  height: number | null;
  createdAt: number;
}

export interface SaveRecord {
  id: string;
  ownerId: string;
  placeId: string;
  comment: string;
  commentVisibility: CommentVisibility;
  status: SaveStatus | null;
  priceLevel: PriceLevel | null;
  sharing: Sharing;
  mainTagId: string | null;
  /** Main tag first, then the others by name. */
  tagIds: string[];
  createdAt: number;
  updatedAt: number;
  /** Set when in the trash. */
  deletedAt: number | null;
}

export interface TagRecord {
  id: string;
  ownerId: string;
  parentId: string | null;
  name: string;
  color: string | null;
  icon: string | null;
  osmCategories: string[];
  deletedAt: number | null;
}

export interface TagMappingRecord {
  personId: string;
  theirTag: string;
  myTagId: string;
}

/** A zone used inside a list filter: an OSM boundary or an outlined polygon. */
export type FilterZone =
  | {
      kind: 'osm';
      osmType: OsmType;
      osmId: number;
      name: string;
      /** Simplified boundary, kept so the filter works offline. */
      geometry: AreaGeometry;
    }
  | { kind: 'drawn'; geometry: AreaGeometry };

/**
 * Saved filter of a list (spec: "The list filter is stored as JSON (tags,
 * categories, statuses, zones, exceptions)"). Groups are ANDed; values inside a
 * group are ORed; an empty or missing group does not constrain.
 */
export interface ListFilter {
  /** Tag ids; a tag also matches its sub-tags. */
  tags?: string[];
  /** OSM categories (`key=value`) of the place. */
  categories?: string[];
  statuses?: SaveStatus[];
  priceLevels?: PriceLevel[];
  zones?: FilterZone[];
  /** Place ids (of my saves) added by hand, kept even when the criteria do not match. */
  include?: string[];
  /** Place ids removed by hand; wins over `include`. */
  exclude?: string[];
}

export interface ListRecord {
  id: string;
  ownerId: string;
  name: string;
  description: string;
  visibility: ListVisibility;
  linkKey: string | null;
  kind: ListKind;
  filter: ListFilter;
  /** Manual lists: the selected places (place ids of my saves; a filter list's items are computed). */
  manualItems: string[];
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface PersonRecord {
  id: string;
  displayName: string;
  avatar: string | null;
  publicKey: string | null;
  readUrl: string | null;
  isMe: boolean;
  iFollow: boolean;
  followsMe: boolean;
  requestState: 'received' | 'sent' | 'accepted' | null;
  lastEtag: string | null;
  lastSync: number | null;
}

export type { Geometry };
