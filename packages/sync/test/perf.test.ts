// SPDX-License-Identifier: MPL-2.0
/**
 * Full sync of 1,000 and 10,000 places: sizes and times (README "Measurements").
 * `npm run test:perf` (PERF_REPORT=1 prints the table). With TL_REAL_SERVERS=1,
 * also over the real Apache WebDAV server (scripts in packages/storage).
 */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { MemoryAdapter, WebDavAdapter, type StorageAdapter } from '@triangulair/storage';
import { deflateSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { featureFor, placesCollection, readOwnItems } from '../src/features.ts';
import { addDevice, befriend, counting, friendSaves, makeUser, World, type Device } from './helpers.ts';

const REPORT = process.env.PERF_REPORT === '1';
const rows: string[][] = [];
const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;
const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${n.toFixed(0)} ms`);

function fill(d: Device, n: number): void {
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const tags: string[] = [];
  d.store.change((tx) => {
    for (let i = 0; i < 20; i++) tags.push(tx.createTag({ name: `Tag ${i}`, color: '#EF4444', icon: 'pin', ...(i >= 10 && { parentId: tags[i - 10]! }) }));
  });
  for (let start = 0; start < n; start += 500) {
    d.store.change((tx) => {
      for (let i = start; i < Math.min(n, start + 500); i++) {
        const paris = rnd() < 0.6;
        const lat = paris ? 48.8 + rnd() * 0.12 : 43 + rnd() * 7;
        const lon = paris ? 2.25 + rnd() * 0.2 : -1 + rnd() * 8;
        const placeId = tx.putSave({
          place: { osm: { type: 'node', id: i + 1 }, name: `Place ${i} ${rnd().toString(36).slice(2, 8)}`, category: 'amenity=restaurant', geometry: { type: 'Point', coordinates: [lon, lat] } },
          ...(rnd() < 0.3 && { comment: `A comment about place ${i}, really worth it ${rnd().toString(36).slice(2)}` }),
          ...(rnd() < 0.1 && { sharing: 'private' as const }),
          ...(rnd() < 0.5 && { status: 'tried' as const }),
        });
        const k = 1 + Math.floor(rnd() * 3);
        for (let t = 0; t < k; t++) tx.addSaveTag(placeId, tags[Math.floor(rnd() * 20)]!);
        if (rnd() < 0.05) tx.deleteSave(placeId);
      }
    });
  }
}

async function measure(label: string, n: number, storage: StorageAdapter): Promise<void> {
  const w = new World();
  const cnt = counting(storage);
  const user = makeUser(w, 'alice', { storage: cnt });
  const alice = addDevice(w, user, { concurrency: 6 });
  const bob = addDevice(w, makeUser(w, 'bob'));
  fill(alice, n);
  await bob.engine.sync();
  await alice.engine.sync(); // create the index
  await befriend(w, alice, bob);

  let t = performance.now();
  const pub = await alice.engine.sync();
  const tPublish = performance.now() - t;
  const idxBytes = (await storage.get('index.json'))!.data.length;
  const files = await storage.list('packs/');
  const packBytes = files.reduce((s, f) => s + f.size, 0);

  t = performance.now();
  const read = await bob.engine.sync();
  const tRead = performance.now() - t;
  const shared = friendSaves(bob, user.owner).size;

  t = performance.now();
  const quiet = await bob.engine.sync();
  const tQuiet = performance.now() - t;

  alice.store.updateSave(readOwnItems(alice.store.repo)[Math.floor(n / 2)]!.placeId, { comment: 'edited' });
  t = performance.now();
  const inc = await alice.engine.sync();
  const tInc = performance.now() - t;
  t = performance.now();
  const incRead = await bob.engine.sync();
  const tIncRead = performance.now() - t;

  const device2 = addDevice(w, user);
  t = performance.now();
  await device2.engine.sync();
  const tRestore = performance.now() - t;
  expect(device2.store.repo.dumpOwnData()).toBe(alice.store.repo.dumpOwnData());

  // Raw vs compressed (informative).
  const items = readOwnItems(alice.store.repo).filter((i) => i.sharing !== 'private');
  const raw = placesCollection(items.map((i) => featureFor(i, 'friends')));
  const doc = alice.store.exportDoc();

  expect(read.ok && quiet.ok && inc.ok && incRead.ok).toBe(true);
  expect(quiet.friends[0]!.status).toBe('unchanged');
  rows.push([
    label, String(n), String(shared), String(files.length), kb(packBytes), kb(idxBytes),
    `${kb(raw.length)} → ${kb(deflateSync(raw).length)}`, `${kb(doc.length)} → ${kb(deflateSync(doc).length)}`,
    ms(tPublish), `${ms(tRead)} (${kb(read.friends[0]!.downloaded.bytes)})`, ms(tQuiet),
    `${ms(tInc)} (${inc.own!.packsWritten} packs, ${kb(inc.own!.bytesUploaded)})`,
    `${ms(tIncRead)} (${incRead.friends[0]!.downloaded.packs} packs)`, ms(tRestore),
  ]);
  void pub;
  if (n === 1000) expect(tRead).toBeLessThan(10_000); // spec: first read of a friend with 1,000 places under 10 s
}

describe('performance', () => {
  it('1,000 places, in memory', () => measure('memory', 1000, new MemoryAdapter()), 300_000);
  it('10,000 places, in memory', () => measure('memory', 10_000, new MemoryAdapter()), 600_000);
  if (process.env.TL_REAL_SERVERS === '1') {
    const dav = () => new WebDavAdapter({ baseUrl: `http://127.0.0.1:8081/dav/perf-${randomUUID()}/`, auth: { username: 'alice', password: 's3cret' } });
    it('1,000 places, Apache WebDAV', () => measure('Apache WebDAV', 1000, dav()), 300_000);
    it('10,000 places, Apache WebDAV', () => measure('Apache WebDAV', 10_000, dav()), 600_000);
  }
  it('report', () => {
    if (!REPORT) return;
    const head = ['storage', 'places', 'shared', 'pack files', 'packs total', 'index', 'places JSON raw → deflated', 'Yjs doc raw → deflated',
      'first publish', 'friend first read (downloaded)', 'friend, unchanged', 'edit one place: publish', 'friend reads the edit', 'new own device'];
    const table = [head, head.map(() => '---'), ...rows].map((r) => `| ${r.join(' | ')} |`).join('\n');
    console.log(table);
    if (process.env.PERF_OUT) writeFileSync(process.env.PERF_OUT, table + '\n');
  });
});
