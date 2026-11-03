// SPDX-License-Identifier: MPL-2.0
/**
 * What a Google Maps link tells about a place: its coordinates when the link
 * carries them, and its identifiers (CID, feature id, place id) otherwise.
 * Saved-list CSVs from Takeout only have the link, and most such links have
 * no coordinates (`/maps/place/Name/data=!4m2!3m1!1s0x…:0x…`): those places
 * are then found by name (see the matcher).
 */
import type { SourceIds } from './model.ts';

export interface GoogleUrlInfo {
  lat?: number;
  lon?: number;
  /** Place name from `/maps/place/<name>/`. */
  name?: string;
  ids: Pick<SourceIds, 'googleCid' | 'googleFid' | 'googlePlaceId'>;
}

function validLatLon(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
}

const NUM = String.raw`(-?\d{1,3}(?:\.\d+)?)`;

/** "48.85, 2.35" / "48.85,2.35" (a query that is only coordinates). */
export function parseLatLonText(s: string): { lat: number; lon: number } | null {
  const m = new RegExp(`^\\s*${NUM}\\s*[,; ]\\s*\\+?${NUM}\\s*$`).exec(s);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  return validLatLon(lat, lon) ? { lat, lon } : null;
}

/** The CID (decimal) is the second half of a `0x…:0x…` feature id, read as an unsigned 64-bit number. */
export function cidFromFid(fid: string): string | undefined {
  const m = /^0x[0-9a-f]+:0x([0-9a-f]{1,16})$/i.exec(fid);
  if (!m) return undefined;
  try {
    return BigInt(`0x${m[1]}`).toString(10);
  } catch {
    return undefined;
  }
}

export function isGoogleMapsUrl(url: string): boolean {
  return /^https?:\/\/((www|maps)\.)?google\.[a-z.]+\/(maps|\?|search)|^https?:\/\/maps\.app\.goo\.gl\/|^https?:\/\/goo\.gl\/maps\//i.test(url.trim());
}

export function parseGoogleMapsUrl(raw: string): GoogleUrlInfo {
  const out: GoogleUrlInfo = { ids: {} };
  const url = raw.trim();
  let decoded = url;
  try {
    decoded = decodeURIComponent(url.replace(/\+/g, ' '));
  } catch {
    // keep the raw URL
  }
  // 1. Exact place coordinates in the data blob: !3d<lat>!4d<lon>.
  const dm = new RegExp(`!3d${NUM}!4d${NUM}`).exec(decoded);
  if (dm && validLatLon(Number(dm[1]), Number(dm[2]))) {
    out.lat = Number(dm[1]);
    out.lon = Number(dm[2]);
  }
  // 2. Query parameters.
  const qIndex = url.indexOf('?');
  if (qIndex >= 0) {
    const params = new Map<string, string>();
    for (const part of url.slice(qIndex + 1).split('#')[0]!.split('&')) {
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      try {
        params.set(part.slice(0, eq), decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' ')));
      } catch {
        params.set(part.slice(0, eq), part.slice(eq + 1));
      }
    }
    const cid = params.get('cid');
    if (cid && /^\d{1,20}$/.test(cid)) out.ids.googleCid = cid;
    const ftid = params.get('ftid');
    if (ftid && /^0x[0-9a-f]+:0x[0-9a-f]+$/i.test(ftid)) out.ids.googleFid = ftid.toLowerCase();
    const pid = params.get('query_place_id') ?? params.get('place_id');
    if (pid && /^[A-Za-z0-9_-]{10,}$/.test(pid)) out.ids.googlePlaceId = pid;
    if (out.lat === undefined) {
      for (const k of ['query', 'q', 'll', 'sll', 'center', 'daddr']) {
        const v = params.get(k);
        const p = v ? parseLatLonText(v) : null;
        if (p) {
          out.lat = p.lat;
          out.lon = p.lon;
          break;
        }
      }
    }
  }
  // 3. Feature id in the data blob: !1s0x…:0x….
  const fm = /!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i.exec(decoded);
  if (fm && !out.ids.googleFid) out.ids.googleFid = fm[1]!.toLowerCase();
  // 4. Place id in the data blob: !1sChIJ… (newer links).
  const pm = /!1s(ChIJ[A-Za-z0-9_-]+)/.exec(decoded);
  if (pm && !out.ids.googlePlaceId) out.ids.googlePlaceId = pm[1]!;
  if (out.ids.googleFid && !out.ids.googleCid) {
    const cid = cidFromFid(out.ids.googleFid);
    if (cid) out.ids.googleCid = cid;
  }
  // 5. /maps/search/<lat>,<lon> and /maps/place/<lat>,<lon>.
  const path = decoded.split('?')[0]!;
  const sm = /\/maps\/(?:search|place|dir)\/([^/@]+)/.exec(path);
  if (sm) {
    const p = parseLatLonText(sm[1]!);
    if (p && out.lat === undefined) {
      out.lat = p.lat;
      out.lon = p.lon;
    } else if (!p && /\/maps\/place\//.test(path)) {
      out.name = sm[1]!.trim();
    }
  }
  // 6. The viewport "@lat,lon,zoom" (centered on the place when opened from it): last resort.
  if (out.lat === undefined) {
    const am = new RegExp(`@${NUM},${NUM}`).exec(path);
    if (am && validLatLon(Number(am[1]), Number(am[2]))) {
      out.lat = Number(am[1]);
      out.lon = Number(am[2]);
    }
  }
  return out;
}
