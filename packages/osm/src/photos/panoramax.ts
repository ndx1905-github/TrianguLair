/**
 * Street-level pictures from Panoramax (the free, federated street view), as
 * a façade view when a place has no photo. Uses the STAC search endpoint
 * with `place_position`, which returns pictures whose camera looks at the
 * point, within `place_distance` meters.
 */
import { assertLatLon, distanceMeters, fmtCoord } from '../geo.ts';
import type { HttpClient } from '../http/client.ts';
import type { LatLon, RequestOptions } from '../types.ts';
import { type Photo, type PhotoLicense, attributionLine } from './types.ts';

interface StacLink {
  rel: string;
  href: string;
  title?: string;
}

interface StacItem {
  type: 'Feature';
  id: string;
  collection?: string;
  geometry?: { type: 'Point'; coordinates: [number, number] };
  properties?: Record<string, unknown>;
  providers?: Array<{ name?: string; roles?: string[] }>;
  assets?: Record<string, { href?: string; type?: string }>;
  links?: StacLink[];
}

interface StacCollection {
  type: 'FeatureCollection';
  features?: StacItem[];
}

const KNOWN_LICENSES: Record<string, Omit<PhotoLicense, 'attributionRequired'> & { attributionRequired: boolean }> = {
  'etalab-2.0': {
    name: 'Licence Ouverte 2.0',
    url: 'https://www.etalab.gouv.fr/licence-ouverte-open-licence/',
    attributionRequired: true,
  },
  'cc-by-sa-4.0': { name: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/', attributionRequired: true },
  'cc-by-4.0': { name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/', attributionRequired: true },
  'cc0-1.0': { name: 'CC0 1.0', url: 'https://creativecommons.org/publicdomain/zero/1.0/', attributionRequired: false },
};

export function panoramaxLicense(item: StacItem): PhotoLicense | null {
  const id = typeof item.properties?.license === 'string' ? item.properties.license : undefined;
  const link = item.links?.find((l) => l.rel === 'license');
  const known = id ? KNOWN_LICENSES[id.toLowerCase()] : undefined;
  if (known) return { ...known };
  if (id) return { name: id, ...(link ? { url: link.href } : {}), attributionRequired: true };
  if (link) return { name: link.title?.replace(/^License for this object \((.*)\)$/, '$1') ?? 'See source', url: link.href, attributionRequired: true };
  return null;
}

function author(item: StacItem): string | undefined {
  const producer = item.properties?.['geovisio:producer'];
  if (typeof producer === 'string' && producer.trim()) return producer.trim();
  const providers = item.providers ?? (item.properties?.providers as StacItem['providers']);
  const p = providers?.find((x) => x.roles?.includes('producer')) ?? providers?.[0];
  return p?.name?.trim() || undefined;
}

export function photoFromPanoramaxItem(item: StacItem, viewerUrl: string, place?: LatLon): Photo | null {
  const license = panoramaxLicense(item);
  if (!license) return null;
  const a = item.assets ?? {};
  const prop = (k: string) => (typeof item.properties?.[k] === 'string' ? (item.properties[k] as string) : undefined);
  const hd = a.hd?.href ?? prop('geovisio:image');
  const sd = a.sd?.href ?? hd;
  const thumb = a.thumb?.href ?? prop('geovisio:thumbnail') ?? sd;
  if (!hd || !sd || !thumb) return null;
  const by = author(item);
  const photo: Photo = {
    source: 'panoramax',
    id: item.id,
    url: sd,
    fullUrl: hd,
    thumbnailUrl: thumb,
    pageUrl: viewerUrl.replace('{id}', encodeURIComponent(item.id)),
    license,
    attribution: attributionLine({ ...(by ? { author: by } : {}), license }, 'Panoramax'),
    streetLevel: true,
  };
  if (by) photo.author = by;
  const dt = prop('datetime');
  if (dt) photo.capturedAt = dt;
  const az = item.properties?.['view:azimuth'];
  if (typeof az === 'number') photo.heading = az;
  const c = item.geometry?.coordinates;
  if (place && c) photo.distance = distanceMeters(place, { lat: c[1], lon: c[0] });
  return photo;
}

export interface PanoramaxClientOptions {
  http: HttpClient;
  /** API base, e.g. https://api.panoramax.xyz/api */
  baseUrl: string;
  /** Picture page template with `{id}`. */
  viewerUrl: string;
  /** Default 7 days. */
  ttlMs?: number;
}

export interface PanoramaxOptions extends RequestOptions {
  /** Max distance from the point, meters. Default 30. */
  radius?: number;
  /** Default 3. */
  limit?: number;
  /** Degrees of tolerance for "the camera looks at the point". Default 30. */
  fovTolerance?: number;
}

export class PanoramaxClient {
  private readonly ttlMs: number;
  constructor(private readonly o: PanoramaxClientOptions) {
    this.ttlMs = o.ttlMs ?? 7 * 24 * 3600_000;
  }

  /** Pictures looking at `place`, nearest and most recent first. */
  async picturesOf(place: LatLon, opts: PanoramaxOptions = {}): Promise<Photo[]> {
    assertLatLon(place);
    const limit = opts.limit ?? 3;
    const params = new URLSearchParams({
      place_position: `${fmtCoord(place.lon, 6)},${fmtCoord(place.lat, 6)}`,
      place_distance: `0-${Math.round(opts.radius ?? 30)}`,
      place_fov_tolerance: String(opts.fovTolerance ?? 30),
      limit: String(Math.min(limit * 3, 50)),
    });
    const r = await this.o.http.getJson<StacCollection>(
      { service: 'panoramax', url: `${this.o.baseUrl}/search?${params}`, ttlMs: this.ttlMs },
      opts,
    );
    const photos = (r.features ?? [])
      .map((f) => photoFromPanoramaxItem(f, this.o.viewerUrl, place))
      .filter((p): p is Photo => !!p);
    photos.sort(
      (a, b) =>
        Math.round((a.distance ?? 0) / 10) - Math.round((b.distance ?? 0) / 10) ||
        (b.capturedAt ?? '').localeCompare(a.capturedAt ?? ''),
    );
    return photos.slice(0, limit);
  }
}
