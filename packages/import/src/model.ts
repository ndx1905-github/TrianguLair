// SPDX-License-Identifier: MPL-2.0
/**
 * The common model every parser produces (docs/SPEC.md "Importing your
 * places"): one `ImportedPlace` per place found in the file, whatever the
 * source, plus the source's tags/lists with their colors when it has them.
 */
import type { ListFilter, PlaceGeometry, PlaceKind, CommentVisibility, OsmType, PriceLevel, SaveStatus, Sharing, ZoneEdge } from '@triangulair/data';

export type ZoneGeometry = Exclude<PlaceGeometry, { type: 'Point' }>;

export type SourceFormat =
  | 'google-saved-geojson'
  | 'google-labeled-geojson'
  | 'google-saved-csv'
  | 'kml'
  | 'kmz'
  | 'geojson'
  | 'csv'
  | 'mapstr'
  | 'pindrop'
  | 'triangulair';

/** Whether the parser was written against real exports or only from documentation and guesses. */
export const FORMAT_VERIFIED: Record<SourceFormat, boolean> = {
  'google-saved-geojson': true,
  'google-labeled-geojson': true,
  'google-saved-csv': true,
  kml: true,
  kmz: true,
  geojson: true,
  csv: true,
  // Checked against a real Mapstr export (T-009).
  mapstr: true,
  // UNVERIFIED: no real Pin Drop export has been seen yet (task T-009).
  pindrop: false,
  triangulair: true,
};

/** Identifiers the source gave the place, kept to recognize it on a re-import. */
export interface SourceIds {
  /** OSM identity when the source has it (TrianguLair export, uMap/OSM-derived GeoJSON). */
  osm?: { type: OsmType; id: number };
  /** Google Maps CID (decimal string), from `?cid=` or the `0x…:0x…` feature id. */
  googleCid?: string;
  /** Google feature id `0x…:0x…`. */
  googleFid?: string;
  /** Google Places place id (`ChIJ…`). */
  googlePlaceId?: string;
  /** The source's own id (Mapstr, Pin Drop, a CSV `id` column…). */
  sourceId?: string;
  /** The TrianguLair place id (`osm:…` or `local:…`) of an exported place. */
  placeId?: string;
}

export interface ImportedPlace {
  /** Index in the file (stable key for the preview). */
  key: string;
  name: string;
  /** Representative point. Absent when the source only has an address or a URL without coordinates. */
  lat?: number;
  lon?: number;
  /**
   * A zone (street segment, neighborhood, drawn area) instead of a point;
   * `lat`/`lon` is then its representative point.
   */
  shape?: { geometry: ZoneGeometry; edge?: ZoneEdge };
  address?: string;
  /**
   * Source tags and lists, by key (a list in Google or My Maps becomes a tag).
   * The key is the tag's name, except in a TrianguLair export where it is the
   * exported tag id (two sub-tags may share a name). See `ParseResult.tags`.
   */
  tags: string[];
  /** Key of the tag shown first, when the source has a notion of main tag/category. */
  mainTag?: string;
  comment?: string;
  status?: SaveStatus;
  url?: string;
  ids: SourceIds;
  /** ms since the epoch. */
  createdAt?: number;
  /** OSM `key=value` category when the source has it. */
  category?: string;
  /** Default: "zone" with a shape, "place" otherwise. */
  kind?: PlaceKind;
  // Only from a TrianguLair export (lossless round trip):
  /** Was in the trash. */
  trashed?: boolean;
  priceLevel?: PriceLevel;
  sharing?: Sharing;
  commentVisibility?: CommentVisibility;
  /**
   * My photos in a TrianguLair export. Only a photo whose images came with it (the `.zip` archive)
   * is imported; a plain GeoJSON export carries their metadata only.
   */
  media?: ImportedPhoto[];
  /**
   * The source's own rating, as written (Mapstr: an undocumented scale). The data model has no
   * rating: it is never written as such; `ratingsInComments` adds it to the comment when the
   * user asks for it in the preview.
   */
  rating?: string;
  /**
   * Photos the source keeps on its own server (Mapstr: URLs on its image host). Counted in the
   * preview only: never downloaded (that would contact a third party) and never written.
   */
  remotePhotos?: string[];
}

/** One of my photos from a TrianguLair export. */
export interface ImportedPhoto {
  /** Its id in the exported account (a re-import gives it a new one). */
  id: string;
  /** Content hash of the full image (`b2b256:…`): a photo already on the save is not added twice. */
  file: string;
  thumb?: string | null;
  mime?: string | null;
  blurhash?: string | null;
  width?: number | null;
  height?: number | null;
  /** When it was added (ms). */
  createdAt?: number;
  /** Owner id of its author (always the exporting account: friends' photos are not exported). */
  author?: string;
  /** The images, from the archive (decrypted, without metadata). */
  images?: { full: Uint8Array; thumb: Uint8Array };
}

/**
 * A "maybe closed" signal, the same shape as `ClosureSignal` of `@triangulair/osm` (this package
 * does not depend on it: the app passes the osm package's `osmSignals` to `buildPlan`). Stored on
 * the place like the monthly check's signals.
 */
export interface ClosureSignalLike {
  code: string;
  reliability: 'low' | 'medium' | 'high';
  source: 'osm' | 'user' | 'friend';
  detail: string;
  since?: string;
  observedAt: string;
  osmVersion?: number;
  data?: Record<string, string>;
}

/** A tag or list as defined in the source, with what we know about it. */
export interface SourceTag {
  /** What `ImportedPlace.tags` refers to (the name, or the exported id). */
  key: string;
  name: string;
  color?: string;
  icon?: string;
  /** Key of the parent tag (TrianguLair export: sub-tags). */
  parentKey?: string;
  osmCategories?: string[];
  /** Was in the trash when exported. */
  deleted?: boolean;
}

export interface ParseWarning {
  /** Machine code for the UI's wording. */
  code:
    | 'no-coordinates'
    | 'bad-coordinates'
    | 'no-name'
    | 'unsupported-geometry'
    | 'unknown-columns'
    | 'unverified-format'
    | 'empty'
    | 'bad-row'
    | 'newer-version'
    /** A TrianguLair export whose photos are not in the file (a plain GeoJSON, or an image missing from the archive). */
    | 'photos-not-included'
    /** Mapstr ZIP: its GeoJSON is not valid JSON; the CSV was used alone (no positions). */
    | 'invalid-geojson'
    /** Places without coordinates in a file that has none (Mapstr CSV alone): found by name and address. `detail`: how many. */
    | 'positions-from-address'
    /** Mapstr ZIP: a CSV row with no matching GeoJSON feature (no position). */
    | 'row-not-joined'
    /** Photos left on the source's server (`detail`: how many). */
    | 'remote-photos';
  /** Place key or row number, when it concerns one entry. */
  at?: string;
  detail?: string;
}

/** Lists and other whole-account data of a TrianguLair export, kept for a lossless re-import. */
export interface ExportExtras {
  lists: ExportedList[];
  tagMappings: { personId: string; theirTag: string; myTag: string }[];
}

export interface ExportedList {
  id: string;
  name: string;
  description: string;
  visibility: 'link' | 'public';
  linkKey: string | null;
  kind: 'filter' | 'manual';
  /** The list filter as stored, tag ids being the exported tag keys and places their place ids. */
  filter: ListFilter;
  /** Place ids. */
  items: string[];
  createdAt: number;
  deletedAt: number | null;
}

export interface ParseResult {
  format: SourceFormat;
  places: ImportedPlace[];
  tags: SourceTag[];
  warnings: ParseWarning[];
  /** Present only for a TrianguLair export. */
  extras?: ExportExtras;
}

/** A file as handed over by the picker. */
export interface ImportFile {
  name: string;
  /** Raw bytes (needed for KMZ); text files may be given as `text` instead. */
  bytes?: Uint8Array;
  text?: string;
}
