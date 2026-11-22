// SPDX-License-Identifier: MPL-2.0
/**
 * Two of my devices publishing at once on a server with coarse ETags and emulated (non-atomic)
 * conditions, as WsgiDAV with `conditionalWrites: false`: deterministic interleavings of the two
 * publications (index read, content check, emulated HEAD + PUT, read-back, commit, garbage deletion).
 *
 * The intermittent CI failure of real-servers.test.ts (WsgiDAV, "concurrent publishers") is the
 * first scenario: one device's emulated If-Match check passes, the other device then publishes
 * completely (its read-back sees its own index), and only then does the first device's PUT land.
 * Both read back their own index, both report success, and one index silently replaced the other.
 */
import { serialize } from '@triangulair/crypto';
import { MemoryAdapter, PreconditionFailed, type StorageAdapter } from '@triangulair/storage';
import { describe, expect, it } from 'vitest';
import { addDevice, makeUser, point, World, type Device } from './helpers.ts';

type Step = 'get' | 'got' | 'checked' | 'put' | 'delete';

/**
 * WsgiDAV-like server as the sync sees it: ETags from the size only (every write lands within the
 * same second: the worst case of "mtime in whole seconds + size"), If-Match / If-None-Match checked
 * with a HEAD and then written without a lock. `hook` runs at each step of the device's requests.
 */
function wsgidavLike(inner: MemoryAdapter, hook: (step: Step, path: string) => Promise<void>): StorageAdapter {
  const tag = (size: number) => `"s${size}"`;
  return {
    capabilities: { ...inner.capabilities, conditionalWrites: false },
    async get(p, o) {
      await hook('get', p);
      const g = await inner.get(p, o);
      await hook('got', p);
      return g && { data: g.data, etag: tag(g.data.length) };
    },
    async head(p) {
      const h = await inner.head(p);
      return h && { etag: tag(h.size), size: h.size };
    },
    list: (p) => inner.list(p),
    async delete(p) {
      await hook('delete', p);
      await inner.delete(p);
    },
    async put(p, d, o = {}) {
      const h = await inner.head(p);
      if (o.ifMatch !== undefined && (!h || tag(h.size) !== o.ifMatch)) throw new PreconditionFailed(p);
      if (o.ifNoneMatch === '*' && h) throw new PreconditionFailed(p);
      await hook('checked', p);
      await inner.put(p, d);
      await hook('put', p);
      return { etag: tag(d.length) };
    },
  };
}

/** Where, in the late device's publication, the other device's whole publication is run. */
interface Interleaving {
  name: string;
  /** Step and occurrence (1-based, counting index.json requests of that step in the pass) to inject at. */
  step: Step;
  nth: number;
  /** Any path (garbage deletion) instead of index.json. */
  anyPath?: boolean;
}

const interleavings: Interleaving[] = [
  { name: 'between the index read and the content check', step: 'get', nth: 2 },
  { name: 'between the emulated If-Match check and the PUT (lost update no read-back sees)', step: 'checked', nth: 1 },
  { name: 'between the PUT and the read-back', step: 'put', nth: 1 },
  { name: 'right after the read-back', step: 'got', nth: 3 },
  { name: 'at the first garbage deletion', step: 'delete', nth: 1, anyPath: true },
];

function setup(opts: { fullCheckMs: number; raceCheckMs?: number }) {
  const w = new World();
  const mem = new MemoryAdapter();
  const inject = new Map<string, (step: Step, path: string) => Promise<void>>();
  const adapter = (name: string) => wsgidavLike(mem, async (s, p) => inject.get(name)?.(s, p));
  const user = makeUser(w, 'alice', { storage: adapter('setup') });
  const common = { fullCheckMs: opts.fullCheckMs, raceCheckMs: opts.raceCheckMs ?? 0 };
  const a = addDevice(w, user, { ...common, storage: adapter('a') });
  // a2 writes a full snapshot once 2 document files are listed: its publication drops the base's
  // document files, which a's index (built on the same base, adding a delta) still lists.
  const a2 = addDevice(w, user, { ...common, maxOwnDeltas: 2, storage: adapter('a2') });
  /** Runs `other`'s whole sync at `it` in `late`'s next publication. */
  const arm = (it: Interleaving, late: Device, other: Device) => {
    const name = late === a ? 'a' : 'a2';
    let n = 0;
    inject.set(name, async (s, p) => {
      if (s !== it.step || (!it.anyPath && p !== 'index.json')) return;
      if (++n !== it.nth) return;
      inject.delete(name);
      const r = await other.engine.sync();
      expect(r.problems).toEqual([]);
    });
  };
  return { w, mem, user, a, a2, arm, inject };
}

/** Every file the index on the storage lists exists (an index never points to a missing file). */
async function missingListed(mem: MemoryAdapter, d: Device): Promise<string[]> {
  const idx = d.engine.own!.index;
  if (!idx) return ['<no index>'];
  const out: string[] = [];
  for (const p of idx.packs) if (!(await mem.head(p.file))) out.push(p.file);
  return out;
}

/** Files of my document (media/: own document, manifest) listed by the index on the storage and missing from it. */
async function missingDocFiles(mem: MemoryAdapter): Promise<string[]> {
  const g = await mem.get('index.json');
  const packs = (JSON.parse(new TextDecoder().decode(g!.data)) as { packs: { file: string }[] }).packs;
  const out: string[] = [];
  for (const p of packs) if (p.file.startsWith('media/') && !(await mem.head(p.file))) out.push(p.file);
  return out;
}

async function restoredFromStorage(w: World, d: Device): Promise<string> {
  const c = addDevice(w, d.user);
  await c.engine.sync();
  return c.store.repo.dumpOwnData();
}

describe('concurrent publishers on a coarse-ETag server with emulated conditions (WsgiDAV)', () => {
  for (const fullCheckMs of [0, 3_600_000]) for (const lateName of ['a', 'a2'] as const) {
    for (const it_ of interleavings) {
      it(`${lateName} late, ${it_.name}; ${fullCheckMs ? 'ETag shortcut on' : 'index read in full'}: no update lost, converges at the next passes`, async () => {
        const { w, mem, a, a2, arm } = setup({ fullCheckMs });
        for (let i = 1; i <= 6; i++) a.store.putSave({ place: point(i, `P${i}`) });
        expect((await a.engine.sync()).ok).toBe(true);
        expect((await a2.engine.sync()).ok).toBe(true);
        a.store.updateSave('osm:node/1', { comment: 'edited' });
        expect((await a.engine.sync()).ok).toBe(true);
        expect((await a2.engine.sync()).ok).toBe(true);
        expect(a2.store.repo.dumpOwnData()).toBe(a.store.repo.dumpOwnData());

        a.store.putSave({ place: point(200, 'from a') });
        a2.store.putSave({ place: point(300, 'from a2') });
        // The other device's whole publication runs inside the late writer's.
        const [late, other] = lateName === 'a' ? [a, a2] : [a2, a];
        arm(it_, late, other);
        const r = await late.engine.sync();
        expect(r.problems).toEqual([]);
        expect(r.ok).toBe(true);
        // Whichever index survived, the files of my document it lists are all there: the storage
        // alone holds every save that index carries (friends' packs may 404 until the next pass).
        expect(await missingDocFiles(mem)).toEqual([]);

        // Settle exactly as real-servers.test.ts does: a, a2, a.
        for (const d of [a, a2, a]) {
          const s = await d.engine.sync();
          expect(s.problems).toEqual([]);
        }
        expect(a2.store.repo.dumpOwnData()).toBe(a.store.repo.dumpOwnData());
        for (const id of [1, 200, 300]) {
          expect(a.store.repo.getMySaveForPlace(`osm:node/${id}`)).not.toBeNull();
        }
        expect(await missingListed(mem, a)).toEqual([]);
        expect(await restoredFromStorage(w, a)).toBe(a.store.repo.dumpOwnData());
      });
    }
  }

  it('the lost update itself: the overwritten device notices at its next pass and merges the other index (no save only on one device)', async () => {
    const { w, mem, a, a2, arm } = setup({ fullCheckMs: 3_600_000 });
    for (let i = 1; i <= 6; i++) a.store.putSave({ place: point(i, `P${i}`) });
    await a.engine.sync();
    await a2.engine.sync();
    // A second document file: a2's next publication replaces both with a full snapshot.
    a.store.updateSave('osm:node/1', { comment: 'edited' });
    await a.engine.sync();
    await a2.engine.sync();
    a.store.putSave({ place: point(200, 'from a') });
    a2.store.putSave({ place: point(300, 'from a2') });
    arm(interleavings[1]!, a, a2);
    expect((await a.engine.sync()).ok).toBe(true);
    // a's index replaced a2's after a2 read its own back: a2's save is only on a2 now.
    expect(new TextDecoder().decode((await mem.get('index.json'))!.data)).toBe(serialize(a.engine.own!.index!));
    // The files of my document that the surviving index lists are all there (none deleted by a2).
    expect(await missingDocFiles(mem)).toEqual([]);
    // a2's next pass (nothing changed on a2, ETag shortcut on): sees the other index, merges it, republishes both.
    const r2 = await a2.engine.sync();
    expect(r2.problems).toEqual([]);
    expect(a2.store.repo.getMySaveForPlace('osm:node/200')).not.toBeNull();
    const restored = await restoredFromStorage(w, a2);
    expect(restored).toBe(a2.store.repo.dumpOwnData());
    expect(restored).toContain('osm:node/200');
    expect(restored).toContain('osm:node/300');
    await a.engine.sync();
    expect(a.store.repo.dumpOwnData()).toBe(a2.store.repo.dumpOwnData());
    expect(await missingListed(mem, a)).toEqual([]);
  });

  it('the check after the read-back (emulated conditions) catches an overwrite within the same pass', async () => {
    const { w, mem, a, a2, inject } = setup({ fullCheckMs: 3_600_000, raceCheckMs: 30 });
    for (let i = 1; i <= 6; i++) a.store.putSave({ place: point(i, `P${i}`) });
    await a.engine.sync();
    await a2.engine.sync();
    a.store.putSave({ place: point(200, 'from a') });
    a2.store.putSave({ place: point(300, 'from a2') });
    // a2's If-Match check passes before a's PUT; a2's PUT lands right after a's read-back.
    let a2Checked!: () => void;
    let aReadBack!: () => void;
    const checked = new Promise<void>((r) => (a2Checked = r));
    const readBack = new Promise<void>((r) => (aReadBack = r));
    let aPut = false;
    inject.set('a', async (s, p) => {
      if (p !== 'index.json') return;
      if (s === 'checked') await checked;
      if (s === 'put') aPut = true;
      if (s === 'got' && aPut) aReadBack();
    });
    inject.set('a2', async (s, p) => {
      if (p !== 'index.json' || s !== 'checked') return;
      inject.delete('a2');
      a2Checked();
      await readBack;
    });
    const [ra, ra2] = await Promise.all([a.engine.sync(), a2.engine.sync()]);
    inject.clear();
    expect([ra.problems, ra2.problems]).toEqual([[], []]);
    expect(ra.own!.conflicts).toBeGreaterThanOrEqual(1);
    // Already in this pass: the storage alone holds both saves, nothing listed is missing.
    const restored = await restoredFromStorage(w, a);
    expect(restored).toContain('osm:node/200');
    expect(restored).toContain('osm:node/300');
    expect(await missingDocFiles(mem)).toEqual([]);
    await a2.engine.sync();
    expect(a2.store.repo.dumpOwnData()).toBe(a.store.repo.dumpOwnData());
  });
});
