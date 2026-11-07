/**
 * On-storage layout (spec):
 *
 *   index.json              signed index (opaque bytes to this package): the
 *                           oldest major format version still written
 *   index.v<N>.json         the index in a newer major version N, published
 *                           next to index.json during a major transition
 *   packs/<id>.bin          encrypted packs
 *   public/lists.geojson   public lists (plain GeoJSON, uMap-compatible)
 *
 * There is deliberately no `inbox/`: friends never write to your storage;
 * they send a return link (pointing to their own storage) instead.
 */
import { InvalidPath } from './errors.ts';

export const INDEX_PATH = 'index.json';
export const PACKS_DIR = 'packs/';
export const PUBLIC_LISTS_PATH = 'public/lists.geojson';

/**
 * Path of the signed index. Without `major` (or for the base major), the
 * classic `index.json`; for a newer major `N` written next to it during a
 * major format transition (spec "Format versions"), `index.v<N>.json`.
 */
export function indexPath(major?: number, baseMajor?: number): string {
  if (major === undefined || major === baseMajor) return INDEX_PATH;
  if (!Number.isSafeInteger(major) || major < 1 || major > 9999) throw new InvalidPath(String(major), 'index major must be an integer 1..9999');
  return `index.v${major}.json`;
}

/** Major of an `index.v<N>.json` path, `null` for `index.json`, `undefined` if the path is not an index. */
export function indexMajorOf(path: string): number | null | undefined {
  if (path === INDEX_PATH) return null;
  const m = /^index\.v([1-9][0-9]{0,3})\.json$/.exec(path);
  return m ? Number(m[1]) : undefined;
}

const PACK_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function packPath(id: string): string {
  if (!PACK_ID.test(id)) throw new InvalidPath(id, 'pack id must match [A-Za-z0-9_-]{1,128}');
  return `${PACKS_DIR}${id}.bin`;
}

/** Inverse of `packPath`; `null` if the path is not a pack. */
export function packIdOf(path: string): string | null {
  const m = /^packs\/([A-Za-z0-9_-]{1,128})\.bin$/.exec(path);
  return m ? m[1]! : null;
}
