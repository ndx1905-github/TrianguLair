// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { normalizeSnapshot } from '../src/place.ts';
import { parseTheirTags } from '../src/sqlite/repository.ts';
import { FRIEND, osmPoint } from './helpers.ts';
import { openRepo, writeMySave } from './fixtures.ts';

describe("friends' tags with their author's color (T-108)", () => {
  it('parses names and tags with color/icon, skipping bad entries', () => {
    expect(parseTheirTags(['Bar', ' ', { name: 'Bouffe', color: '#EA580C', icon: 'restaurant' }, { name: 3 }, null, { name: 'Rooftop', color: 7 }])).toEqual([
      { name: 'Bar' },
      { name: 'Bouffe', color: '#EA580C', icon: 'restaurant' },
      { name: 'Rooftop' },
    ]);
    expect(parseTheirTags('nope')).toEqual([]);
  });

  it('stores and lists friends tags of live foreign saves only', () => {
    const repo = openRepo();
    writeMySave(repo, osmPoint(1, 'Mine', 48.85, 2.35), { updatedAt: 1 });
    repo.upsertForeignSave({
      id: 'f1',
      ownerId: FRIEND,
      place: normalizeSnapshot(osmPoint(2, 'Le Perchoir', 48.86, 2.38, 'amenity=bar')),
      theirTags: ['Bar', { name: 'Rooftop', color: '#0891B2', icon: 'view' }],
      createdAt: 1,
      updatedAt: 1,
    });
    repo.upsertForeignSave({
      id: 'f2',
      ownerId: FRIEND,
      place: normalizeSnapshot(osmPoint(3, 'Gone', 48.87, 2.39)),
      theirTags: ['Bouffe'],
      createdAt: 1,
      updatedAt: 1,
    });
    repo.deleteForeignSave('f2');
    expect(repo.friendTags()).toEqual([
      { personId: FRIEND, saveId: 'f1', placeId: 'osm:node/2', name: 'Bar', color: null, icon: null },
      { personId: FRIEND, saveId: 'f1', placeId: 'osm:node/2', name: 'Rooftop', color: '#0891B2', icon: 'view' },
    ]);
  });

  it('plain names are still stored as strings (format unchanged)', () => {
    const repo = openRepo();
    repo.upsertForeignSave({
      id: 'f1',
      ownerId: FRIEND,
      place: normalizeSnapshot(osmPoint(2, 'P', 48.86, 2.38)),
      theirTags: ['Bar'],
      createdAt: 1,
      updatedAt: 1,
    });
    const raw = repo.db.get<{ their_tags: string }>(`SELECT their_tags FROM saves WHERE id = 'f1'`);
    expect(raw?.their_tags).toBe('["Bar"]');
  });
});
