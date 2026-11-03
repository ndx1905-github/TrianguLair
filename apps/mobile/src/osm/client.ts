/**
 * The app's single OSM client (shared HTTP layer: rate limits, coalescing,
 * cache). In fixture mode its fetch serves the osm package's fixtures.
 */
import { Platform } from 'react-native';
import { buildUserAgent, createOsmClient, type OsmClient } from '@triangulair/osm';

import { APP_CONTACT_URL, APP_VERSION, OSM_FIXTURES } from '../config';
import { createFixtureFetch } from './fixtureFetch';
import { withZoneFixtures } from './zoneFixtureFetch';

let client: OsmClient | null = null;

export function osmClient(): OsmClient {
  if (client) return client;
  // Outside fixture mode Metro replaces ./fixtures by an empty module (metro.config.js).
  const fixtures = OSM_FIXTURES ? (require('./fixtures') as typeof import('./fixtures')) : null;
  const fetchImpl = fixtures
    ? withZoneFixtures(fixtures.loadZoneFixtures(), createFixtureFetch(fixtures.loadFixtures()))
    : undefined;
  client = createOsmClient({
    userAgent: buildUserAgent({ name: 'TrianguLair', version: APP_VERSION, contact: APP_CONTACT_URL }),
    platform: Platform.OS === 'web' ? 'web' : 'native',
    timeoutMs: 12_000,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  return client;
}
