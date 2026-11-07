// SPDX-License-Identifier: MPL-2.0
/**
 * Public lists, published in plaintext as one GeoJSON file
 * (`public/lists.geojson`, listed in the signed index with its hash so that
 * readers verify it like the packs). Readable by anyone, including uMap.
 * T-211 (data part): the "View on uMap" link is the app's.
 *
 * - Only my public lists, only places that are not private, not in the trash
 *   and not known to be closed (the data package's list rules), and only
 *   comments marked public (spec "Comment with its own visibility").
 * - ODbL: the file contains data derived from OpenStreetMap (names,
 *   geometries), so it carries the attribution and the license (spec "Data
 *   attributions and licenses"; the legal analysis is still to be confirmed).
 * - One feature per (list, place), with `list` / `list_name`, so a uMap
 *   layer can be filtered by list; the author's color goes to
 *   `_umap_options.color` (uMap's per-feature style).
 */
import type { Repository } from '@triangulair/data';
import { featureFor, type OwnItem } from './features.ts';
import { utf8 } from './payload.ts';

export const PUBLIC_LISTS_NAME = 'lists';
export const ODBL_ATTRIBUTION = 'Contains data © OpenStreetMap contributors, available under the Open Database License (ODbL) 1.0';
export const ODBL_URL = 'https://opendatacommons.org/licenses/odbl/1-0/';

export interface PublicListsOptions {
  owner: string;
  /** Author name shown in the file (optional). */
  author?: string;
}

/** The public GeoJSON, or `null` when I have no public list. Deterministic (no timestamp) so it only changes with its content. */
export function buildPublicLists(repo: Repository, items: readonly OwnItem[], opts: PublicListsOptions): Uint8Array | null {
  const lists = repo.lists().filter((l) => l.visibility === 'public');
  if (lists.length === 0) return null;
  const bySave = new Map(items.map((i) => [i.saveId, i]));
  const features: unknown[] = [];
  const meta: { id: string; name: string; description?: string; updated: string }[] = [];
  for (const l of lists) {
    const m: (typeof meta)[number] = { id: l.id, name: l.name, updated: new Date(l.updatedAt).toISOString() };
    if (l.description) m.description = l.description;
    meta.push(m);
    for (const saveId of repo.listItems(l.id)) {
      const it = bySave.get(saveId);
      if (!it || it.sharing === 'private' || it.placeStatus === 'closed') continue;
      const f = featureFor(it, 'public');
      const props: Record<string, unknown> = { ...f.properties, list: l.id, list_name: l.name };
      if (f.properties.comment) props.description = f.properties.comment;
      const color = it.tags[0]?.color;
      if (color) props._umap_options = { color };
      features.push({ type: 'Feature', id: `${l.id}/${it.placeId}`, geometry: f.geometry, properties: props });
    }
  }
  const doc: Record<string, unknown> = {
    type: 'FeatureCollection',
    attribution: ODBL_ATTRIBUTION,
    license: { name: 'ODbL-1.0', url: ODBL_URL },
    triangulair: { kind: 'public-lists', version: 1, owner: opts.owner, ...(opts.author ? { author: opts.author } : {}), lists: meta },
    features,
  };
  return utf8(JSON.stringify(doc));
}
