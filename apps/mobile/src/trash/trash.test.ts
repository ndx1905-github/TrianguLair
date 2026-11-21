import { describe, expect, it } from 'vitest';
import initSqlJs from 'sql.js';
import { DataStore, TRASH_RETENTION_MS } from '@triangulair/data';

import { SqlJsDriver } from '../data/sqljsDriver';
import { daysLeft, deleteForever, emptyTrash, purgeExpired, restoreItem, trashItems } from './model';

const SQL = await initSqlJs();
const DAY = 24 * 3600 * 1000;

function openStore(clock: { t: number }) {
  let n = 0;
  return DataStore.open({
    driver: new SqlJsDriver(new SQL.Database()),
    meId: 'ed25519:test-owner',
    actor: 'aa'.repeat(16),
    newId: () => `id${String(++n).padStart(8, '0')}`,
    now: () => clock.t,
  });
}

const point = (id: number, name: string) => ({ osm: { type: 'node' as const, id }, name, category: 'amenity=cafe', geometry: { type: 'Point' as const, coordinates: [2.35, 48.85] as [number, number] } });
const zone = (name: string) => ({
  id: 'local:zone0001',
  name,
  kind: 'zone' as const,
  geometry: { type: 'Polygon' as const, coordinates: [[[2.3, 48.8], [2.4, 48.8], [2.4, 48.9], [2.3, 48.8]]] },
});

describe('trash (gap #8)', () => {
  it('lists trashed places, zones, tags and lists, newest first, with the days left', () => {
    const clock = { t: Date.UTC(2026, 9, 1) };
    const s = openStore(clock);
    const tag = s.createTag({ name: 'Old tag' });
    s.putSave({ place: point(1, 'Café A'), tagIds: [tag] });
    s.putSave({ place: zone('My street') });
    const zoneId = 'local:zone0001';
    const list = s.createList({ name: 'Gone list', kind: 'manual' });
    s.deleteSave('osm:node/1');
    clock.t += DAY;
    s.deleteTag(tag);
    clock.t += DAY;
    s.deleteSave(zoneId);
    s.deleteList(list);
    clock.t += DAY / 2;
    const items = trashItems(s.repo, clock.t);
    expect(items.map((i) => [i.kind, i.name, i.daysLeft])).toEqual([
      ['list', 'Gone list', 30],
      ['zone', 'My street', 30],
      ['tag', 'Old tag', 29],
      ['place', 'Café A', 28],
    ]);
  });

  it('restores an item with its tags, deletes one forever, empties the rest', () => {
    const clock = { t: Date.UTC(2026, 9, 1) };
    const s = openStore(clock);
    const tag = s.createTag({ name: 'Bar' });
    s.putSave({ place: point(1, 'Café A'), tagIds: [tag], comment: 'Nice' });
    s.putSave({ place: point(2, 'Café B') });
    s.putSave({ place: point(3, 'Café C') });
    for (const p of ['osm:node/1', 'osm:node/2', 'osm:node/3']) s.deleteSave(p);
    const find = (name: string) => trashItems(s.repo, clock.t).find((i) => i.name === name)!;
    restoreItem(s, find('Café A'));
    const back = s.repo.getMySaveForPlace('osm:node/1')!;
    expect(back.deletedAt).toBeNull();
    expect(back.tagIds).toEqual([tag]);
    expect(back.comment).toBe('Nice');
    deleteForever(s, find('Café B'));
    expect(trashItems(s.repo, clock.t).map((i) => i.name)).toEqual(['Café C']);
    expect(s.repo.getMySaveForPlace('osm:node/2')).toBeNull();
    expect(emptyTrash(s, trashItems(s.repo, clock.t))).toBe(1);
    expect(trashItems(s.repo, clock.t)).toEqual([]);
    expect(s.repo.queryPlaces({}).map((h) => h.id)).toEqual(['osm:node/1']);
  });

  it('purges items older than 30 days at launch, keeps the others', () => {
    const clock = { t: Date.UTC(2026, 9, 1) };
    const s = openStore(clock);
    s.putSave({ place: point(1, 'Old') });
    s.putSave({ place: point(2, 'Recent') });
    s.deleteSave('osm:node/1');
    clock.t += 10 * DAY;
    s.deleteSave('osm:node/2');
    clock.t += TRASH_RETENTION_MS - 10 * DAY;
    expect(daysLeft(Date.UTC(2026, 9, 1), clock.t)).toBe(0);
    expect(purgeExpired(s)).toBe(1);
    expect(trashItems(s.repo, clock.t).map((i) => [i.name, i.daysLeft])).toEqual([['Recent', 10]]);
  });
});
