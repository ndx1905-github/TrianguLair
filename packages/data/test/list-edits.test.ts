// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { osmPoint, rect } from './helpers.ts';
import { openStore } from './stores.ts';

describe('list edits used by the app (T-112)', () => {
  it('switching a list between filter and manual keeps both definitions', () => {
    const s = openStore();
    s.putSave({ place: osmPoint(1, 'Napoli', 48.85, 2.35), status: 'favorite' });
    s.putSave({ place: osmPoint(2, 'Flore', 48.85, 2.33), status: 'to_try' });
    const id = s.createList({ name: 'Mix', kind: 'filter', filter: { statuses: ['favorite'] } });
    s.addToList(id, 'osm:node/2'); // filter list: an inclusion
    expect(s.repo.listItems(id)).toEqual([s.saveId('osm:node/1'), s.saveId('osm:node/2')]);

    s.updateList(id, { kind: 'manual' });
    expect(s.repo.getList(id)!.kind).toBe('manual');
    expect(s.repo.listItems(id)).toEqual([]); // nothing selected by hand yet
    s.addToList(id, 'osm:node/1'); // manual list: a selection
    expect(s.repo.listItems(id)).toEqual([s.saveId('osm:node/1')]);

    s.updateList(id, { kind: 'filter' });
    const back = s.repo.getList(id)!;
    expect(back.filter).toEqual({ statuses: ['favorite'], include: ['osm:node/2'] });
    expect(back.manualItems).toEqual(['osm:node/1']);
    expect(s.repo.listItems(id)).toEqual([s.saveId('osm:node/1'), s.saveId('osm:node/2')]);
  });

  it('leaving link-only drops the list key, so coming back needs a new link (sync review L-01)', () => {
    const s = openStore();
    const id = s.createList({ name: 'L', kind: 'manual', visibility: 'link', linkKey: 'k1' });
    s.updateList(id, { name: 'L2' });
    expect(s.repo.getList(id)!.linkKey).toBe('k1');
    s.updateList(id, { visibility: 'public' });
    expect(s.repo.getList(id)!.linkKey).toBeNull();
    s.updateList(id, { visibility: 'link' });
    expect(s.repo.getList(id)!.linkKey).toBeNull();
    s.updateList(id, { linkKey: 'k2' });
    s.updateList(id, { visibility: 'link' }); // unchanged: kept
    expect(s.repo.getList(id)!.linkKey).toBe('k2');
  });

  it('refuses an unknown kind and leaves the list unchanged', () => {
    const s = openStore();
    const id = s.createList({ name: 'L', kind: 'manual' });
    expect(() => s.updateList(id, { kind: 'smart' as never })).toThrow();
    expect(s.repo.getList(id)!.kind).toBe('manual');
  });

  it('a kind change merges across devices like any field (last writer wins)', () => {
    const a = openStore({ actor: 'device-a' });
    const id = a.createList({ name: 'L', kind: 'filter' });
    const b = openStore({ actor: 'device-b' });
    b.merge(a.exportDoc());
    b.updateList(id, { kind: 'manual' });
    a.merge(b.exportDoc(a.heads()));
    expect(a.repo.getList(id)!.kind).toBe('manual');
    expect(Y.encodeStateVector(a.doc)).toEqual(Y.encodeStateVector(b.doc));
  });

  it('a drawn filter zone keeps its optional name, which does not affect matching', () => {
    const s = openStore();
    s.putSave({ place: osmPoint(1, 'Inside', 48.85, 2.35) });
    s.putSave({ place: osmPoint(2, 'Outside', 48.95, 2.35) });
    const zone = { kind: 'drawn' as const, name: 'My Marais', geometry: rect(2.3, 48.8, 2.4, 48.9) };
    const id = s.createList({ name: 'Zone', kind: 'filter', filter: { zones: [zone] } });
    expect(s.repo.getList(id)!.filter.zones).toEqual([zone]);
    expect(s.repo.listItems(id)).toEqual([s.saveId('osm:node/1')]);
    // Same shape under another name: one zone (the key is the shape).
    s.setListFilter(id, { zones: [zone, { ...zone, name: 'Other' }] });
    expect(s.repo.getList(id)!.filter.zones).toHaveLength(1);
  });
});
