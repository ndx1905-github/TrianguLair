/**
 * Demo data seeded on first launch, so the test build shows something: the
 * phase-0 sample places in Paris turned into my saves (with tags, status,
 * price, comments), a friend's saves, and some OSM-like info (opening hours,
 * terrace…) so the practical filters have data.
 *
 * The OSM info of these places is illustrative, not fetched: they are
 * manual (`local:`) places. In fixture mode, one place of the osm package's
 * fixtures is also saved, so the add screen shows "Already in my places".
 */
import {
  normalizeSnapshot,
  placeIdFromOsm,
  saveIdFor,
  type DataStore,
  type PriceLevel,
  type SaveStatus,
} from '@triangulair/data';

import { TAGS, TAG_IDS, type TagId } from '../theme/tags';

export interface DemoPlace {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** Ordered: the first tag is the main one. */
  tags: TagId[];
  /** false = only saved by a friend (drawn faded). */
  ownerIsMe: boolean;
  /** Also saved by the demo friend. */
  alsoFriend?: boolean;
  category: string;
  osmTags: Record<string, string>;
  status?: SaveStatus;
  price?: PriceLevel;
  comment?: string;
  /** Days before the seed date (for the "recent" sort). */
  ageDays: number;
}

const p = (n: number) => `local:demoplace${String(n).padStart(2, '0')}`;

/** Phase-0 sample places around Paris. Coordinates are approximate. */
export const DEMO_PLACES: DemoPlace[] = [
  { id: p(1), name: 'Du Pain et des Idées', lat: 48.8713, lon: 2.3633, tags: ['bakery', 'cafe'], ownerIsMe: true, category: 'shop=bakery', osmTags: { shop: 'bakery', opening_hours: 'Mo-Fr 07:15-19:30', outdoor_seating: 'no' }, status: 'favorite', price: 1, comment: 'Escargot pistache-chocolat.', ageDays: 2 },
  { id: p(2), name: 'Le Comptoir du Relais', lat: 48.8519, lon: 2.3388, tags: ['restaurant'], ownerIsMe: true, alsoFriend: true, category: 'amenity=restaurant', osmTags: { amenity: 'restaurant', cuisine: 'french;regional', opening_hours: 'Mo-Su 12:00-23:00', outdoor_seating: 'yes', reservation: 'recommended' }, status: 'tried', price: 3, ageDays: 40 },
  { id: p(3), name: 'Musée d’Orsay', lat: 48.86, lon: 2.3266, tags: ['museum'], ownerIsMe: true, category: 'tourism=museum', osmTags: { tourism: 'museum', museum: 'art', opening_hours: 'Tu-Su 09:30-18:00; Th 09:30-21:45; Mo off', fee: 'yes', charge: '16 EUR' }, status: 'to_try', ageDays: 15 },
  { id: p(4), name: 'Jardin du Luxembourg', lat: 48.8462, lon: 2.3372, tags: ['park', 'view'], ownerIsMe: true, category: 'leisure=park', osmTags: { leisure: 'park', opening_hours: 'Mo-Su 07:30-20:30', fee: 'no' }, ageDays: 60 },
  { id: p(5), name: 'Sacré-Cœur steps', lat: 48.8867, lon: 2.3431, tags: ['view'], ownerIsMe: true, category: 'tourism=viewpoint', osmTags: { tourism: 'viewpoint' }, ageDays: 90 },
  { id: p(6), name: 'Le Baron Rouge', lat: 48.8496, lon: 2.3782, tags: ['bar', 'restaurant'], ownerIsMe: true, category: 'amenity=bar', osmTags: { amenity: 'bar', opening_hours: 'Tu-Sa 10:00-22:00; Su 10:00-16:00', outdoor_seating: 'sidewalk', happy_hours: 'Tu-Fr 17:00-19:00' }, status: 'favorite', price: 2, comment: 'Oysters on Sunday morning.', ageDays: 5 },
  { id: p(7), name: 'Shakespeare and Company', lat: 48.8526, lon: 2.3471, tags: ['shop', 'cafe', 'museum'], ownerIsMe: true, category: 'shop=books', osmTags: { shop: 'books', opening_hours: 'Mo-Su 10:00-20:00', second_hand: 'yes' }, ageDays: 120 },
  { id: p(8), name: 'New Morning', lat: 48.8723, lon: 2.3532, tags: ['music', 'bar'], ownerIsMe: true, category: 'amenity=music_venue', osmTags: { amenity: 'music_venue', opening_hours: 'Mo-Su 19:30-01:00' }, status: 'to_try', ageDays: 8 },
  { id: p(9), name: 'Parc des Buttes-Chaumont', lat: 48.8809, lon: 2.3828, tags: ['park'], ownerIsMe: false, category: 'leisure=park', osmTags: { leisure: 'park', opening_hours: 'Mo-Su 07:00-22:00' }, ageDays: 30 },
  { id: p(10), name: 'Le Perchoir', lat: 48.8612, lon: 2.3811, tags: ['bar', 'view'], ownerIsMe: false, category: 'amenity=bar', osmTags: { amenity: 'bar', opening_hours: 'Mo-Su 18:00-02:00', outdoor_seating: 'roof', happy_hours: 'Mo-Fr 18:00-20:00' }, ageDays: 12 },
  { id: p(11), name: 'Musée Rodin', lat: 48.8553, lon: 2.3158, tags: ['museum', 'park'], ownerIsMe: false, category: 'tourism=museum', osmTags: { tourism: 'museum', museum: 'art', opening_hours: 'Tu-Su 10:00-18:30', fee: 'yes', outdoor_seating: 'yes' }, ageDays: 25 },
  { id: p(12), name: 'Marché des Enfants Rouges', lat: 48.8628, lon: 2.3618, tags: ['restaurant', 'shop'], ownerIsMe: true, category: 'amenity=marketplace', osmTags: { amenity: 'marketplace', opening_hours: 'Tu-Sa 08:30-20:30; Su 08:30-17:00', outdoor_seating: 'yes', 'diet:vegetarian': 'yes', cuisine: 'moroccan;japanese;italian' }, status: 'tried', price: 2, comment: 'Moroccan stall at the back.', ageDays: 3 },
  { id: p(13), name: 'Hôtel Grand Amour', lat: 48.8746, lon: 2.3597, tags: ['hotel', 'bar', 'restaurant', 'cafe'], ownerIsMe: false, category: 'tourism=hotel', osmTags: { tourism: 'hotel', outdoor_seating: 'yes' }, ageDays: 50 },
  { id: p(14), name: 'Café de Flore', lat: 48.8541, lon: 2.3326, tags: ['cafe'], ownerIsMe: false, category: 'amenity=cafe', osmTags: { amenity: 'cafe', opening_hours: 'Mo-Su 07:30-01:30', outdoor_seating: 'yes' }, ageDays: 70 },
  { id: p(15), name: 'Philharmonie de Paris', lat: 48.8918, lon: 2.3939, tags: ['music', 'view'], ownerIsMe: true, category: 'amenity=concert_hall', osmTags: { amenity: 'concert_hall', opening_hours: 'Tu-Su 12:00-20:00' }, ageDays: 100 },
];

export const DEMO_FRIEND = { id: 'demo-friend-lea', displayName: 'Léa' };

/** A place of the osm package fixtures (fixture mode only). */
export const FIXTURE_SAVED_PLACE = {
  osm: { type: 'node' as const, id: 9123456702 },
  name: 'Trattoria Da Lucia',
  category: 'amenity=restaurant',
  lat: 48.8591004,
  lon: 2.3621507,
  osmTags: {
    amenity: 'restaurant',
    cuisine: 'italian;pizza',
    'diet:vegetarian': 'yes',
    outdoor_seating: 'yes',
    reservation: 'recommended',
    opening_hours: 'Tu-Su 12:00-14:30,19:00-22:30; PH off',
    'addr:housenumber': '12',
    'addr:street': 'Rue de Bretagne',
    'addr:postcode': '75003',
    'addr:city': 'Paris',
  },
};

export function hasAnyData(store: DataStore): boolean {
  return store.repo.tags().length > 0 || store.repo.queryPlaces({ limit: 1 }).length > 0 || store.repo.trash().length > 0;
}

export interface SeedOptions {
  /** Tag name for a demo tag id, in the device language. */
  tagName: (id: TagId) => string;
  fixtures: boolean;
  now?: number;
}

/** Seeds the demo data. Returns false (and does nothing) when the store already has data. */
export function seedDemoData(store: DataStore, opts: SeedOptions): boolean {
  if (hasAnyData(store)) return false;
  const now = opts.now ?? Date.now();
  const day = 24 * 3600_000;
  const tagIds = new Map<TagId, string>();

  store.change((tx) => {
    for (const id of TAG_IDS) {
      const def = TAGS[id];
      tagIds.set(id, tx.createTag({ name: opts.tagName(id), color: def.color, icon: def.icon, osmCategories: def.osmCategories }));
    }
    for (const d of DEMO_PLACES) {
      if (!d.ownerIsMe) continue;
      const ids = d.tags.map((t) => tagIds.get(t)!);
      tx.putSave({
        place: { id: d.id, name: d.name, category: d.category, geometry: { type: 'Point', coordinates: [d.lon, d.lat] } },
        tagIds: ids,
        mainTagId: ids[0] ?? null,
        status: d.status ?? null,
        priceLevel: d.price ?? null,
        ...(d.comment ? { comment: d.comment, commentVisibility: 'friends' as const } : {}),
      });
    }
    if (opts.fixtures) {
      const f = FIXTURE_SAVED_PLACE;
      tx.putSave({
        place: { osm: f.osm, name: f.name, category: f.category, geometry: { type: 'Point', coordinates: [f.lon, f.lat] } },
        tagIds: [tagIds.get('restaurant')!],
        mainTagId: tagIds.get('restaurant')!,
        status: 'to_try',
        priceLevel: 2,
      });
    }
  }, 'demo data');

  const repo = store.repo;
  repo.transaction(() => {
    repo.upsertPerson({ id: DEMO_FRIEND.id, displayName: DEMO_FRIEND.displayName, iFollow: true, followsMe: true });
    for (const d of DEMO_PLACES) {
      if (!d.ownerIsMe || d.alsoFriend) {
        const place = normalizeSnapshot({
          id: d.id,
          name: d.name,
          category: d.category,
          geometry: { type: 'Point', coordinates: [d.lon, d.lat] },
        });
        repo.upsertForeignSave({
          id: saveIdFor(DEMO_FRIEND.id, d.id),
          ownerId: DEMO_FRIEND.id,
          place,
          theirTags: d.tags.map((t) => TAGS[t].label),
          createdAt: now - d.ageDays * day,
          updatedAt: now - d.ageDays * day,
        });
      }
      repo.updatePlaceOsmData(d.id, { osmTags: d.osmTags, openingHours: d.osmTags.opening_hours ?? null, osmSyncedAt: null });
    }
    if (opts.fixtures) {
      const f = FIXTURE_SAVED_PLACE;
      repo.updatePlaceOsmData(placeIdFromOsm(f.osm.type, f.osm.id), {
        osmTags: f.osmTags,
        openingHours: f.osmTags.opening_hours,
        address: '12 Rue de Bretagne, 75003 Paris',
        osmSyncedAt: now,
      });
    }
  });
  return true;
}
