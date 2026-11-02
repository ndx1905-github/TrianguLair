/**
 * Directions and "open in" links from the place card (T-116): the phone's
 * navigation app, Apple Maps, Google Maps, OpenStreetMap. Pure, unit-tested.
 * On web these are plain https URLs opened in a new tab.
 */
export type MapsTarget = 'apple' | 'google' | 'osm';
export type Os = 'ios' | 'android' | 'web' | 'other';

export interface LinkPlace {
  name: string;
  lat: number;
  lon: number;
  /** One-line address, when known (helps Apple / Google find the business). */
  address?: string | null;
  osmType?: 'node' | 'way' | 'relation' | null;
  osmId?: number | null;
}

const coord = (n: number) => String(Math.round(n * 1e6) / 1e6);
const ll = (p: LinkPlace) => `${coord(p.lat)},${coord(p.lon)}`;
const q = (s: string) => encodeURIComponent(s);
/** Name plus address: what a search for the business needs. */
const label = (p: LinkPlace) => [p.name, p.address].filter(Boolean).join(', ');

/** Opens the place itself (to read reviews, photos, hours) in another map. */
export function openInUrl(target: MapsTarget, p: LinkPlace): string {
  switch (target) {
    case 'apple':
      return `https://maps.apple.com/?q=${q(p.name)}&ll=${ll(p)}`;
    case 'google':
      // A text query near the point finds the business listing (reviews, photos); coordinates alone only drop a pin.
      return `https://www.google.com/maps/search/?api=1&query=${q(label(p) || ll(p))}`;
    case 'osm':
      return p.osmType && p.osmId != null
        ? `https://www.openstreetmap.org/${p.osmType}/${p.osmId}`
        : `https://www.openstreetmap.org/?mlat=${coord(p.lat)}&mlon=${coord(p.lon)}#map=18/${coord(p.lat)}/${coord(p.lon)}`;
  }
}

/** Directions to the place in a given app. */
export function directionsUrl(target: MapsTarget, p: LinkPlace): string {
  switch (target) {
    case 'apple':
      return `https://maps.apple.com/?daddr=${ll(p)}&q=${q(p.name)}`;
    case 'google':
      return `https://www.google.com/maps/dir/?api=1&destination=${ll(p)}`;
    case 'osm':
      return `https://www.openstreetmap.org/directions?to=${ll(p)}`;
  }
}

/**
 * "Directions" with the phone's own navigation app: the `geo:` intent on
 * Android (the system offers every installed app: Google Maps, Organic Maps,
 * OsmAnd, Citymapper…), Apple Maps on iOS, Google Maps' web directions
 * elsewhere.
 */
export function defaultDirectionsUrl(os: Os, p: LinkPlace): string {
  if (os === 'android') return `geo:${ll(p)}?q=${ll(p)}(${q(p.name)})`;
  if (os === 'ios') return directionsUrl('apple', p);
  return directionsUrl('google', p);
}

/** Targets offered under "Open in", the platform's own first. */
export function openInTargets(os: Os): MapsTarget[] {
  return os === 'android' ? ['google', 'osm', 'apple'] : ['apple', 'google', 'osm'];
}
