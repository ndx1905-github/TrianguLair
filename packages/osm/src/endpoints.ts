/**
 * Service addresses. None is hardcoded in the clients: the app passes its
 * configuration (settings or a configuration update), as OSM's usage policies
 * recommend, and these defaults are only the public instances.
 */

export interface Endpoints {
  /** Overpass interpreter URLs, tried in order (failover on 429/5xx/network errors). */
  overpass: string[];
  /** Photon base URL (the app calls `${photon}/api` and `${photon}/reverse`). */
  photon: string;
  /** Nominatim base URL (`${nominatim}/search`, `${nominatim}/reverse`). */
  nominatim: string;
  /** OSM editing API base, used only to confirm deletions (`${osmApi}/api/0.6/…`). */
  osmApi: string;
  /** Wikimedia Commons action API. */
  commonsApi: string;
  /** Wikidata action API. */
  wikidataApi: string;
  /** Panoramax instance (or meta-catalog) API base. */
  panoramax: string;
  /** Web page of a Panoramax picture; `{id}` is replaced by the picture id. */
  panoramaxViewer: string;
}

export const DEFAULT_ENDPOINTS: Endpoints = {
  overpass: ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'],
  photon: 'https://photon.komoot.io',
  nominatim: 'https://nominatim.openstreetmap.org',
  osmApi: 'https://api.openstreetmap.org',
  commonsApi: 'https://commons.wikimedia.org/w/api.php',
  wikidataApi: 'https://www.wikidata.org/w/api.php',
  panoramax: 'https://api.panoramax.xyz/api',
  panoramaxViewer: 'https://api.panoramax.xyz/#focus=pic&pic={id}',
};

export function resolveEndpoints(partial?: Partial<Endpoints>): Endpoints {
  const e = { ...DEFAULT_ENDPOINTS, ...partial };
  const strip = (u: string) => u.replace(/\/+$/, '');
  return {
    ...e,
    overpass: e.overpass.map(strip),
    photon: strip(e.photon),
    nominatim: strip(e.nominatim),
    osmApi: strip(e.osmApi),
    panoramax: strip(e.panoramax),
  };
}

/** Attribution lines the app must show next to data from each source. */
export const ATTRIBUTIONS = {
  osm: {
    text: '© OpenStreetMap contributors',
    license: 'ODbL 1.0',
    url: 'https://www.openstreetmap.org/copyright',
  },
  photon: {
    text: 'Search by Photon (komoot), data © OpenStreetMap contributors',
    license: 'ODbL 1.0',
    url: 'https://www.openstreetmap.org/copyright',
  },
  nominatim: {
    text: 'Search by Nominatim, data © OpenStreetMap contributors',
    license: 'ODbL 1.0',
    url: 'https://www.openstreetmap.org/copyright',
  },
  wikipedia: {
    text: 'Source: Wikipedia',
    license: 'CC BY-SA 4.0',
    url: 'https://creativecommons.org/licenses/by-sa/4.0/',
  },
} as const;
