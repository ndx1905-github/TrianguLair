import { describe, expect, it } from 'vitest';
import { osmPoint } from './helpers.ts';
import { openStore } from './stores.ts';

describe('smoke', () => {
  it('saves a place and finds it', () => {
    const store = openStore();
    const tag = store.createTag({ name: 'Pizza' });
    const pid = store.putSave({ place: osmPoint(1, 'Pizzeria Napoli', 48.85, 2.35), tagIds: [tag], comment: 'Très bon' });
    expect(pid).toBe('osm:node/1');
    const hits = store.repo.queryPlaces({ bbox: [2.3, 48.8, 2.4, 48.9] });
    expect(hits.map((h) => h.id)).toEqual(['osm:node/1']);
    expect(hits[0]!.mine!.tagIds).toEqual([tag]);
    expect(store.repo.search('tres napo').map((h) => h.id)).toEqual(['osm:node/1']);
    expect(store.repo.search('pizza').map((h) => h.id)).toEqual(['osm:node/1']);
  });
});
