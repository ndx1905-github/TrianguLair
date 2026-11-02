/**
 * Synthetic OSM answers for zones in fixture mode (EXPO_PUBLIC_OSM_FIXTURES=1)
 * and in tests: four quarters of the Marais (Paris 3e) and a few streets with
 * shared intersection nodes. Names are real, shapes are simplified and
 * approximate (not copied from OSM), ids are in a range OSM does not use yet.
 * Bundled only through `fixtures.ts`, which Metro empties outside fixture mode.
 */
import type { NominatimArea, OverpassGeomElement } from '../zones/osmZones';

type P = [lon: number, lat: number];
const g = (pts: P[]) => pts.map(([lon, lat]) => ({ lat, lon }));
const closed = (pts: P[]) => g([...pts, pts[0]!]);

// Quarter outlines (shared borders).
const ARTS: P[] = [
  [2.3515, 48.8665],
  [2.357, 48.869],
  [2.3605, 48.8672],
  [2.359, 48.864],
  [2.354, 48.8625],
];
const ENFANTS: P[] = [
  [2.3605, 48.8672],
  [2.3665, 48.8665],
  [2.368, 48.8625],
  [2.3625, 48.8605],
  [2.359, 48.864],
];
// Archives is a relation of two outer ways (north and south halves of its outline).
const ARCHIVES_N: P[] = [
  [2.356, 48.859],
  [2.359, 48.864],
  [2.3625, 48.8605],
  [2.368, 48.8625],
];
const ARCHIVES_S: P[] = [
  [2.356, 48.859],
  [2.36, 48.8555],
  [2.366, 48.8565],
  [2.368, 48.8625],
];
const AVOIE: P[] = [
  [2.354, 48.8625],
  [2.359, 48.864],
  [2.356, 48.859],
  [2.36, 48.8555],
  [2.353, 48.8575],
  [2.3505, 48.861],
];

const neighbourhoods: OverpassGeomElement[] = [
  { type: 'way', id: 990000101, tags: { place: 'quarter', name: 'Arts-et-Métiers' }, geometry: closed(ARTS) },
  { type: 'way', id: 990000102, tags: { place: 'quarter', name: 'Enfants-Rouges' }, geometry: closed(ENFANTS) },
  {
    type: 'relation',
    id: 990000103,
    tags: { type: 'multipolygon', place: 'quarter', name: 'Archives' },
    members: [
      { type: 'way', ref: 990000111, role: 'outer', geometry: g(ARCHIVES_N) },
      // Stored reversed, as OSM members often are.
      { type: 'way', ref: 990000112, role: 'outer', geometry: g(ARCHIVES_S.slice().reverse()) },
    ],
  },
  { type: 'way', id: 990000104, tags: { place: 'quarter', name: 'Sainte-Avoie' }, geometry: closed(AVOIE) },
];

// Street network: node id -> position; intersections are shared nodes.
const N: Record<number, P> = {
  1: [2.3555, 48.8578],
  2: [2.3575, 48.8601],
  3: [2.3592, 48.8618],
  4: [2.3605, 48.8631],
  5: [2.3612, 48.8645],
  6: [2.3578, 48.8572],
  7: [2.3598, 48.8592],
  8: [2.362, 48.8612],
  9: [2.3632, 48.8628],
  10: [2.3652, 48.8582],
  11: [2.3648, 48.856],
  12: [2.3656, 48.8606],
  13: [2.366, 48.8626],
  14: [2.3664, 48.865],
  15: [2.3545, 48.8606],
};
const way = (id: number, name: string, nodes: number[]): OverpassGeomElement => ({
  type: 'way',
  id,
  tags: { highway: 'residential', name },
  nodes: nodes.map((n) => 990001000 + n),
  geometry: nodes.map((n) => ({ lon: N[n]![0], lat: N[n]![1] })),
});

const streets: OverpassGeomElement[] = [
  way(990000201, 'Rue des Archives', [1, 2, 3, 4, 5]),
  way(990000202, 'Rue Vieille-du-Temple', [6, 7, 8, 9]),
  way(990000203, 'Rue de Turenne', [11, 10, 12, 13, 14]),
  way(990000204, 'Rue des Francs-Bourgeois', [15, 2, 7, 10]),
  // Rue de Bretagne in two ways, as long streets often are in OSM.
  way(990000205, 'Rue de Bretagne', [4, 9]),
  way(990000206, 'Rue de Bretagne', [9, 13]),
];

const ring = (pts: P[]) => [...pts, pts[0]!];
/** Nominatim polygon answers by name. */
const nominatimAreas: NominatimArea[] = [
  ...neighbourhoods.map((el): NominatimArea => {
    const outline = el.type === 'relation' ? [...ARCHIVES_N, ...ARCHIVES_S.slice(1, -1).reverse()] : (el.geometry ?? []).slice(0, -1).map((p): P => [p!.lon, p!.lat]);
    return {
      osm_type: el.type,
      osm_id: el.id,
      name: el.tags!.name,
      display_name: `${el.tags!.name}, Paris 3e Arrondissement, Paris, France`,
      category: 'place',
      type: 'quarter',
      geojson: { type: 'Polygon', coordinates: [ring(outline)] },
    };
  }),
  {
    osm_type: 'relation',
    osm_id: 990000301,
    name: 'Paris',
    display_name: 'Paris, Île-de-France, France métropolitaine, France',
    category: 'boundary',
    type: 'administrative',
    geojson: {
      type: 'Polygon',
      coordinates: [
        ring([
          [2.2242, 48.8535],
          [2.2525, 48.8345],
          [2.2915, 48.8275],
          [2.3445, 48.8158],
          [2.3905, 48.8255],
          [2.4205, 48.8335],
          [2.4135, 48.8505],
          [2.4155, 48.8705],
          [2.4005, 48.8835],
          [2.3925, 48.9011],
          [2.3195, 48.9005],
          [2.2795, 48.8785],
          [2.2555, 48.8735],
        ]),
      ],
    },
  },
];

export interface ZoneFixtures {
  neighbourhoods: { elements: OverpassGeomElement[] };
  streets: { elements: OverpassGeomElement[] };
  nominatimAreas: NominatimArea[];
}

export function loadZoneFixtures(): ZoneFixtures {
  return { neighbourhoods: { elements: neighbourhoods }, streets: { elements: streets }, nominatimAreas };
}
