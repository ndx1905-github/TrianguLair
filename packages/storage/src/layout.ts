/**
 * On-storage layout (spec):
 *
 *   index.json              signed index (opaque bytes to this package)
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
