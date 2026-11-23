/**
 * Sample places in Paris and an example friend, Léa.
 *
 * - Real users (beta feedback): nothing by default. The first launch only creates the starter
 *   tags (`seedStarterTags`). "Show me with examples" on the last first-launch step adds the
 *   examples (`seedExamples`): every sample place as a save of the example friend, in my local
 *   cache only (`people` and foreign `saves` rows, like a friend's places read from their
 *   storage), never in my document, so they are never synced, published or shared.
 *   `deleteExamples` removes them in one go, and also the examples the 0.9.0-beta.1 build seeded
 *   as my own saves (in my document, so possibly published: deleting them publishes their
 *   deletion).
 * - Test builds (fixture mode, EXPO_PUBLIC_OSM_FIXTURES=1, or EXPO_PUBLIC_DEMO_SEED=1): the
 *   former seed (`seedDemoData`), which the end-to-end tests rely on: the sample places as my
 *   saves (with tags, status, price, comments), the friend's saves, and some OSM-like info
 *   (opening hours, terrace…) so the practical filters have data. In fixture mode, one place of
 *   the osm package's fixtures is also saved, so the add screen shows "Already in my places".
 *
 * The OSM info of these places is illustrative, not fetched: they are manual (`local:`) places
 * whose ids start with `local:demoplace` (`isExamplePlace`).
 */
import {
  normalizeSnapshot,
  placeIdFromOsm,
  saveIdFor,
  type DataStore,
  type PriceLevel,
  type Rating,
  type SaveStatus,
} from '@triangulair/data';

import type { ForeignTag } from '@triangulair/data';

import type { IconName } from '../theme/icons';
import { PALETTE, TAGS, TAG_IDS, type TagId } from '../theme/tags';

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
  /** The demo friend's rating of the place (stars). */
  friendRating?: Rating;
  /** Days before the seed date (for the "recent" sort). */
  ageDays: number;
}

/** Demo sub-tags ("Restaurant › Pizza"), created under a demo tag. */
export const DEMO_SUB_TAGS: { id: 'pizza'; label: string; parent: TagId; color: string; icon: IconName }[] = [
  { id: 'pizza', label: 'Pizza', parent: 'restaurant', color: PALETTE.orange, icon: 'pizza' },
];


/** The ids of the sample places (and only theirs) start with this. */
export const EXAMPLE_PLACE_PREFIX = 'local:demoplace';
const p = (n: number) => `${EXAMPLE_PLACE_PREFIX}${String(n).padStart(2, '0')}`;

export function isExamplePlace(placeId: string): boolean {
  return placeId.startsWith(EXAMPLE_PLACE_PREFIX);
}

/** Phase-0 sample places around Paris. Coordinates are approximate. */
export const DEMO_PLACES: DemoPlace[] = [
  { id: p(1), name: 'Du Pain et des Idées', lat: 48.8713, lon: 2.3633, tags: ['bakery', 'cafe'], ownerIsMe: true, category: 'shop=bakery', osmTags: { shop: 'bakery', opening_hours: 'Mo-Fr 07:15-19:30', outdoor_seating: 'no' }, status: 'favorite', price: 1, comment: 'Escargot pistache-chocolat.', ageDays: 2 },
  { id: p(2), name: 'Le Comptoir du Relais', lat: 48.8519, lon: 2.3388, tags: ['restaurant'], ownerIsMe: true, alsoFriend: true, category: 'amenity=restaurant', osmTags: { amenity: 'restaurant', cuisine: 'french;regional', opening_hours: 'Mo-Su 12:00-23:00', outdoor_seating: 'yes', reservation: 'recommended' }, status: 'tried', price: 3, friendRating: 4, ageDays: 40 },
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

/**
 * Léa's own tags that match none of mine (spec "Others' tags"): they keep
 * her colors until I map them. "Rooftop" uses my Viewpoint color on purpose
 * (the tag panel flags the clash).
 */
export const DEMO_FRIEND_EXTRA_TAGS: Record<string, ForeignTag[]> = {
  [p(10)]: [{ name: 'Rooftop', color: PALETTE.cyan, icon: 'view' }],
  [p(14)]: [{ name: 'Terrasses', color: PALETTE.yellow, icon: 'cafe' }],
  [p(9)]: [{ name: 'Pique-nique', color: PALETTE.lime, icon: 'park' }],
  [p(13)]: [{ name: 'Bouffe', color: PALETTE.earth, icon: 'restaurant' }],
};

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

/**
 * Fixture mode: a saved place that OSM now tags `disused:amenity=restaurant`
 * (osm package fixture), never checked yet, so the monthly closed-place check
 * flags it "maybe closed" when the app opens.
 */
export const FIXTURE_CLOSED_PLACE = {
  osm: { type: 'node' as const, id: 9123456720 },
  name: 'Chez Paulette',
  category: 'amenity=restaurant',
  lat: 48.8602311,
  lon: 2.360142,
  osmTags: { amenity: 'restaurant', cuisine: 'french', opening_hours: 'Tu-Sa 12:00-14:00,19:00-22:00', 'addr:street': 'Rue Charlot', 'addr:city': 'Paris' },
};

export function hasAnyData(store: DataStore): boolean {
  return store.repo.tags().length > 0 || store.repo.queryPlaces({ limit: 1 }).length > 0 || store.repo.trash().length > 0;
}

export interface SeedOptions {
  /** Tag name for a demo tag id, in the device language. */
  tagName: (id: TagId) => string;
  /** Name of a demo sub-tag (default: English). */
  subTagName?: (id: (typeof DEMO_SUB_TAGS)[number]['id']) => string;
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
    for (const sub of DEMO_SUB_TAGS) {
      tagIds.set(sub.id as TagId, tx.createTag({ name: opts.subTagName?.(sub.id) ?? sub.label, parentId: tagIds.get(sub.parent)!, color: sub.color, icon: sub.icon }));
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
        tagIds: [tagIds.get('pizza' as TagId)!, tagIds.get('restaurant')!],
        mainTagId: tagIds.get('pizza' as TagId)!,
        status: 'to_try',
        priceLevel: 2,
      });
      const c = FIXTURE_CLOSED_PLACE;
      tx.putSave({
        place: { osm: c.osm, name: c.name, category: c.category, geometry: { type: 'Point', coordinates: [c.lon, c.lat] } },
        tagIds: [tagIds.get('restaurant')!],
        mainTagId: tagIds.get('restaurant')!,
        status: 'tried',
        priceLevel: 2,
        comment: 'Blanquette on Thursdays.',
        commentVisibility: 'friends',
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
          ...(d.friendRating && { rating: d.friendRating }),
          theirTags: [...d.tags.map((t) => TAGS[t].label), ...(DEMO_FRIEND_EXTRA_TAGS[d.id] ?? [])],
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
      const c = FIXTURE_CLOSED_PLACE;
      // Never checked: the closed-place check runs when the app opens.
      repo.updatePlaceOsmData(placeIdFromOsm(c.osm.type, c.osm.id), { osmTags: c.osmTags, openingHours: c.osmTags.opening_hours, osmSyncedAt: null });
    }
  });
  return true;
}

/**
 * The starter tags of a new user (theme/tags.ts), named in the device language. Nothing when the
 * store already has data. In my document: they are my own tags from then on.
 */
export function seedStarterTags(store: DataStore, tagName: (id: TagId) => string): boolean {
  if (hasAnyData(store)) return false;
  store.change((tx) => {
    for (const id of TAG_IDS) {
      const def = TAGS[id];
      tx.createTag({ name: tagName(id), color: def.color, icon: def.icon, osmCategories: def.osmCategories });
    }
  }, 'starter tags');
  return true;
}

export interface ExampleOptions {
  /** The example friend's name, marked as an example ("Léa (example)"). */
  friendName: string;
  /** Tag name for a starter tag id, in the device language (the friend's tags then match mine). */
  tagName: (id: TagId) => string;
  now?: number;
}

/**
 * "Show me with examples": every sample place as a save of the example friend, in my local cache
 * only. Nothing goes to my document (so nothing is synced or published); `deleteExamples`
 * removes it all. Returns false when the examples are already there.
 */
export function seedExamples(store: DataStore, opts: ExampleOptions): boolean {
  const repo = store.repo;
  if (repo.getPerson(DEMO_FRIEND.id)) return false;
  const now = opts.now ?? Date.now();
  const day = 24 * 3600_000;
  repo.transaction(() => {
    repo.upsertPerson({ id: DEMO_FRIEND.id, displayName: opts.friendName });
    for (const d of DEMO_PLACES) {
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
        status: d.status ?? null,
        priceLevel: d.price ?? null,
        ...(d.friendRating && { rating: d.friendRating }),
        ...(d.comment ? { comment: d.comment, commentVisibility: 'friends' as const } : {}),
        theirTags: [...d.tags.map((t) => opts.tagName(t)), ...(DEMO_FRIEND_EXTRA_TAGS[d.id] ?? [])],
        createdAt: now - d.ageDays * day,
        updatedAt: now - d.ageDays * day,
      });
      repo.updatePlaceOsmData(d.id, { osmTags: d.osmTags, openingHours: d.osmTags.opening_hours ?? null, osmSyncedAt: null });
    }
  });
  return true;
}

/** My own saves of sample places (the 0.9.0-beta.1 seed and the test builds' one), in the trash too. */
function ownExampleSaves(store: DataStore): string[] {
  return store.repo.db
    .all<{ place_id: string }>(`SELECT place_id FROM saves WHERE owner_id = ? AND substr(place_id, 1, ?) = ?`, [
      store.meId,
      EXAMPLE_PLACE_PREFIX.length,
      EXAMPLE_PLACE_PREFIX,
    ])
    .map((r) => r.place_id);
}

/** Are there example places (the example friend, or my own saves of sample places)? */
export function hasExamples(store: DataStore): boolean {
  return !!store.repo.getPerson(DEMO_FRIEND.id) || ownExampleSaves(store).length > 0;
}

/**
 * "Delete the example places": the example friend and their saves (local cache), and my own saves
 * of sample places (my document: deleted and purged from the trash at once, so my storage and
 * friends get their deletion). My tags stay. Returns the number of places removed.
 */
export function deleteExamples(store: DataStore): number {
  const repo = store.repo;
  const mine = ownExampleSaves(store);
  if (mine.length) {
    store.change((tx) => {
      for (const placeId of mine) {
        try {
          tx.deleteSave(placeId);
        } catch {
          // Already in the trash.
        }
        tx.purgeTrash({ kind: 'save', id: placeId });
      }
    }, 'delete the example places');
  }
  const theirs = repo.db.all<{ place_id: string }>(`SELECT place_id FROM saves WHERE owner_id = ?`, [DEMO_FRIEND.id]).map((r) => r.place_id);
  repo.transaction(() => {
    if (repo.getPerson(DEMO_FRIEND.id)) repo.removePerson(DEMO_FRIEND.id);
    // The sample places' own rows, once no save refers to them (other cached places stay).
    repo.db.run(
      `DELETE FROM places WHERE substr(id, 1, ?) = ? AND NOT EXISTS (SELECT 1 FROM saves s WHERE s.place_id = places.id)`,
      [EXAMPLE_PLACE_PREFIX.length, EXAMPLE_PLACE_PREFIX],
    );
  });
  return new Set([...mine, ...theirs]).size;
}
