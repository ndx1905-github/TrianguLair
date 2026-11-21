import { describe, expect, it } from 'vitest';
import initSqlJs from 'sql.js';
import { DataStore, savePlaceIds } from '@triangulair/data';
import { MemoryAdapter } from '@triangulair/storage';

import { SqlJsDriver } from '../data/sqljsDriver';
import { hostOf, parseBlocked, parseReported, reportTarget, withBlocked, withoutBlocked } from './blocked';
import { deleteAllContent, deleteStorageFiles, emptyDocument, type DeleteStep } from './deleteAll';

const SQL = await initSqlJs();
const ALICE = 'ed25519:' + 'A'.repeat(43);
const BOB = 'ed25519:' + 'B'.repeat(43);

function openStore() {
  let n = 0;
  return DataStore.open({ driver: new SqlJsDriver(new SQL.Database()), meId: 'ed25519:test-owner', actor: 'aa'.repeat(16), newId: () => `id${String(++n).padStart(8, '0')}` });
}

function seeded() {
  const s = openStore();
  const tag = s.createTag({ name: 'Bar' });
  s.putSave({ place: { osm: { type: 'node', id: 1 }, name: 'Café A', geometry: { type: 'Point', coordinates: [2.35, 48.85] } }, tagIds: [tag], comment: 'secret' });
  s.putSave({ place: { osm: { type: 'node', id: 2 }, name: 'Café B', geometry: { type: 'Point', coordinates: [2.36, 48.85] } } });
  s.deleteSave('osm:node/2'); // in the trash: deleted too
  s.putSave({ place: { id: 'local:zone0001', kind: 'zone', name: 'My street', geometry: { type: 'Polygon', coordinates: [[[2.3, 48.8], [2.4, 48.8], [2.4, 48.9], [2.3, 48.8]]] } } });
  s.createList({ name: 'Best', kind: 'manual', items: ['osm:node/1'], visibility: 'public' });
  s.setTagMapping(ALICE, 'Pubs', tag);
  return s;
}

async function storageWith(paths: string[]) {
  const m = new MemoryAdapter();
  for (const p of paths) await m.put(p, new TextEncoder().encode(p));
  return m;
}

describe('delete all my content (gap #6)', () => {
  it('empties the document: places, zones, trash, tags, lists and mappings, leaving tombstones only', () => {
    const s = seeded();
    expect(emptyDocument(s)).toEqual({ places: 2, zones: 1, tags: 1, lists: 1 });
    expect(savePlaceIds(s.doc)).toEqual([]);
    expect(s.repo.queryPlaces({})).toEqual([]);
    expect(s.repo.trash()).toEqual([]);
    expect(s.repo.tags()).toEqual([]);
    expect(s.repo.lists({ includeDeleted: true })).toEqual([]);
    expect(s.repo.tagMappings()).toEqual([]);
    expect(JSON.stringify(s.repo.dumpOwnData())).not.toContain('secret');
  });

  it('deletes every file but the index and what it lists', async () => {
    const m = await storageWith(['index.json', 'media/b2b256-doc.bin', 'packs/b2b256-old.bin', 'vault.bin', 'keys/ABC.bin', 'public/lists.geojson', 'transfer/x.bin']);
    const r = await deleteStorageFiles(m, ['media/b2b256-doc.bin']);
    expect(r).toEqual({ filesDeleted: 5, filesFailed: [], filesKept: 2, listingUnsupported: false });
    expect((await m.list('')).map((e) => e.path)).toEqual(['index.json', 'media/b2b256-doc.bin']);
  });

  it('runs the steps in order and erases the device last', async () => {
    const s = seeded();
    const steps: DeleteStep[] = [];
    const removed: string[] = [];
    const unfollowed: string[] = [];
    const m = await storageWith(['index.json', 'packs/b2b256-a.bin', 'vault.bin']);
    let wiped = false;
    const summary = await deleteAllContent({
      store: s,
      contacts: () => [ALICE, BOB],
      removeContact: (o) => removed.push(o),
      cancelInvitations: () => 2,
      followedLists: () => ['list-1'],
      unfollowList: (id) => unfollowed.push(id),
      publish: async () => {
        expect(removed).toEqual([ALICE, BOB]); // contacts removed before the publication
        await m.put('media/b2b256-empty.bin', new Uint8Array([1]));
        return { listed: ['media/b2b256-empty.bin'] };
      },
      storage: m,
      wipe: async () => {
        wiped = true;
      },
      onStep: (x) => steps.push(x),
    });
    expect(steps).toEqual(['content', 'contacts', 'publish', 'files', 'device']);
    expect(unfollowed).toEqual(['list-1']);
    expect(wiped).toBe(true);
    expect(summary).toMatchObject({ places: 2, zones: 1, tags: 1, lists: 1, contacts: 2, invitations: 2, followedLists: 1, storage: true, filesDeleted: 2, filesKept: 2 });
  });

  it('a failed publication stops before anything is erased on the device', async () => {
    const s = seeded();
    let wiped = false;
    const m = await storageWith(['index.json', 'vault.bin']);
    await expect(
      deleteAllContent({
        store: s,
        contacts: () => [],
        removeContact: () => {},
        cancelInvitations: () => 0,
        followedLists: () => [],
        unfollowList: () => {},
        publish: async () => {
          throw new Error('storage unreachable');
        },
        storage: m,
        wipe: async () => {
          wiped = true;
        },
      }),
    ).rejects.toThrow('storage unreachable');
    expect(wiped).toBe(false);
    expect((await m.list('')).length).toBe(2);
  });

  it('local only: nothing to publish, the device is still erased', async () => {
    const s = seeded();
    let wiped = false;
    const r = await deleteAllContent({
      store: s,
      contacts: () => [],
      removeContact: () => {},
      cancelInvitations: () => 0,
      followedLists: () => [],
      unfollowList: () => {},
      publish: null,
      storage: null,
      wipe: async () => {
        wiped = true;
      },
    });
    expect(wiped).toBe(true);
    expect(r).toMatchObject({ storage: false, filesDeleted: 0, places: 2 });
  });
});

describe('blocking and reporting (gap #6)', () => {
  it('keeps a clean, deduplicated list of blocked people', () => {
    let list = withBlocked([], { owner: ALICE, name: 'Alice', at: 1 });
    list = withBlocked(list, { owner: BOB, name: '', at: 2 });
    list = withBlocked(list, { owner: ALICE, name: 'Alice B.', at: 3 });
    expect(list.map((p) => [p.owner, p.name])).toEqual([
      [ALICE, 'Alice B.'],
      [BOB, ''],
    ]);
    expect(withoutBlocked(list, ALICE).map((p) => p.owner)).toEqual([BOB]);
    expect(parseBlocked([{ owner: 'nope' }, null, 3, { owner: BOB, name: 7, at: 'x' }])).toEqual([{ owner: BOB, name: '', at: 0 }]);
    expect(parseBlocked('garbage')).toEqual([]);
    expect(parseReported([{ id: 'l1', owner: ALICE, location: 'https://h/x/' }, { id: 2 }])).toHaveLength(1);
  });

  it('names the host and the public file of a reported list', () => {
    expect(hostOf('https://cloud.example.org/public.php/dav/files/tok/')).toBe('cloud.example.org');
    expect(hostOf('not a url')).toBe('');
    expect(reportTarget('https://cloud.example.org/x/')).toMatch(/^https:\/\/cloud\.example\.org\/x\/public\/lists\.geojson$/);
  });
});
