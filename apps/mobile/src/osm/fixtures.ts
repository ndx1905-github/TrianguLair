/**
 * The osm package's test fixtures, bundled for fixture mode
 * (EXPO_PUBLIC_OSM_FIXTURES=1). `client.ts` only loads this module in that mode.
 */
import elementRestaurant from '../../../../packages/osm/test/fixtures/overpass/element-restaurant.json';
import elementsRefresh from '../../../../packages/osm/test/fixtures/overpass/elements-refresh.json';
import nearby from '../../../../packages/osm/test/fixtures/overpass/nearby-marais.json';
import commonsCategory from '../../../../packages/osm/test/fixtures/photos/commons-category-museum.json';
import commonsImageInfo from '../../../../packages/osm/test/fixtures/photos/commons-imageinfo-museum.json';
import panoramax from '../../../../packages/osm/test/fixtures/photos/panoramax-search.json';
import wikidata from '../../../../packages/osm/test/fixtures/photos/wikidata-Q99999901.json';
import nominatimReverse from '../../../../packages/osm/test/fixtures/search/nominatim-reverse.json';
import nominatim from '../../../../packages/osm/test/fixtures/search/nominatim-trattoria.json';
import photonReverse from '../../../../packages/osm/test/fixtures/search/photon-reverse.json';
import photon from '../../../../packages/osm/test/fixtures/search/photon-trattoria.json';
import type { OsmFixtures } from './fixtureFetch';

// Zones (neighbourhoods, streets, areas by name): synthetic, see zoneFixtures.ts.
export { loadZoneFixtures } from './zoneFixtures';

// JSON imports are typed structurally (strings, number[]), not as the service formats.
export function loadFixtures(): OsmFixtures {
  return {
    nearby: nearby as unknown as OsmFixtures['nearby'],
    elements: [elementsRefresh, elementRestaurant] as unknown as OsmFixtures['elements'],
    photon: photon as unknown as OsmFixtures['photon'],
    photonReverse,
    nominatim,
    nominatimReverse,
    wikidata,
    commonsCategory,
    commonsImageInfo,
    panoramax,
  };
}
