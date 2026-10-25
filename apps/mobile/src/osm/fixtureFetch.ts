/**
 * Fixture mode (EXPO_PUBLIC_OSM_FIXTURES=1): a `fetch` that answers the OSM
 * client's requests with the osm package's test fixtures, so the app can be
 * demoed and screenshot without network. Pure routing logic, unit-tested;
 * the fixture JSON is passed in (see `fixtures.ts`).
 *
 * The fixtures are synthetic places in the Marais (Paris 3e), see
 * packages/osm/test/fixtures/README.md.
 */
export interface OsmFixtures {
  nearby: { elements: FixtureElement[] };
  elements: { elements: FixtureElement[] }[];
  photon: { features: PhotonFeature[] };
  photonReverse: unknown;
  nominatim: unknown;
  nominatimReverse: unknown;
  wikidata: unknown;
  commonsCategory: unknown;
  commonsImageInfo: unknown;
  panoramax: unknown;
}

export interface FixtureElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export interface PhotonFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: Record<string, unknown> & { name?: string };
}

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const OSM_KEYS = ['amenity', 'shop', 'tourism', 'leisure', 'historic'];

/** A Photon feature for an Overpass fixture element (so search finds the nearby places too). */
function toPhoton(el: FixtureElement): PhotonFeature | null {
  const tags = el.tags ?? {};
  const pt = el.lat !== undefined && el.lon !== undefined ? { lat: el.lat, lon: el.lon } : el.center;
  if (!tags.name || !pt) return null;
  const key = OSM_KEYS.find((k) => tags[k]);
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [pt.lon, pt.lat] },
    properties: {
      osm_type: el.type === 'node' ? 'N' : el.type === 'way' ? 'W' : 'R',
      osm_id: el.id,
      ...(key ? { osm_key: key, osm_value: tags[key] } : {}),
      type: 'house',
      name: tags.name,
      ...(tags['addr:housenumber'] ? { housenumber: tags['addr:housenumber'] } : {}),
      ...(tags['addr:street'] ? { street: tags['addr:street'] } : {}),
      ...(tags['addr:postcode'] ? { postcode: tags['addr:postcode'] } : {}),
      city: tags['addr:city'] ?? 'Paris',
      country: 'France',
      countrycode: 'FR',
    },
  };
}

function allElements(fx: OsmFixtures): FixtureElement[] {
  const byKey = new Map<string, FixtureElement>();
  for (const list of [fx.nearby.elements, ...fx.elements.map((e) => e.elements)]) {
    for (const el of list) byKey.set(`${el.type}/${el.id}`, { ...byKey.get(`${el.type}/${el.id}`), ...el });
  }
  return [...byKey.values()];
}

export interface FixtureFetchOptions {
  /** Simulated latency, ms (default 150). */
  delayMs?: number;
}

export function createFixtureFetch(fx: OsmFixtures, opts: FixtureFetchOptions = {}) {
  const delay = opts.delayMs ?? 150;
  const elements = allElements(fx);
  const photonIndex = [
    ...fx.photon.features,
    ...elements.map(toPhoton).filter((f): f is PhotonFeature => f !== null),
  ].filter((f, i, all) => all.findIndex((g) => g.properties.osm_id === f.properties.osm_id) === i);

  return async function fixtureFetch(input: string, init?: RequestInit): Promise<Response> {
    const url = String(input);
    const body = typeof init?.body === 'string' ? decodeURIComponent(init.body.replace(/\+/g, ' ')) : '';
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delay);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('aborted', 'AbortError'));
      });
    });
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');

    if (url.includes('interpreter')) {
      if (body.includes('around:') || /nwr\(-?\d/.test(body)) return json(fx.nearby);
      // Element lookups: node(id:…); way(id:…); rel(id:…);
      const wanted = new Set<string>();
      for (const m of body.matchAll(/(node|way|rel)\(id:([\d,]+)\)/g)) {
        const type = m[1] === 'rel' ? 'relation' : m[1]!;
        for (const id of m[2]!.split(',')) wanted.add(`${type}/${id}`);
      }
      return json({ ...fx.nearby, elements: elements.filter((e) => wanted.has(`${e.type}/${e.id}`)) });
    }
    if (url.includes('/reverse')) return json(url.includes('nominatim') ? fx.nominatimReverse : fx.photonReverse);
    if (url.includes('photon') || /\/api\?q=/.test(url)) {
      const q = fold(new URL(url).searchParams.get('q') ?? '').trim();
      const words = q.split(/\s+/).filter(Boolean);
      const features = photonIndex.filter((f) => {
        const hay = fold(`${f.properties.name ?? ''} ${String(f.properties.street ?? '')} ${String(f.properties.city ?? '')}`);
        return words.every((w) => hay.includes(w));
      });
      return json({ type: 'FeatureCollection', features });
    }
    if (url.includes('nominatim')) return json(fx.nominatim);
    if (url.includes('wikidata')) return json(fx.wikidata);
    if (url.includes('commons') && url.includes('generator=categorymembers')) return json(fx.commonsCategory);
    if (url.includes('commons')) return json(fx.commonsImageInfo);
    if (url.includes('panoramax')) return json(fx.panoramax);
    return new Response(`no fixture for ${url}`, { status: 404 });
  };
}
