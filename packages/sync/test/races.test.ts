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

function setup(opts: { fullCheckMs: number }) {
  const w = new World();
  const mem = new MemoryAdapter();
  let inject: ((step: Step, path: string) => Promise<void>) | null = null;
  const plain = wsgidavLike(mem, async () => {});
  const user = makeUser(w, 'alice', { storage: plain });
  const hooked = wsgidavLike(mem, async (s, p) => {
    if (inject) await inject(s, p);
  });
  // Every 2 deltas a full snapshot: the other device's publication drops the base's own-document files.
  const common = { fullCheckMs: opts.fullCheckMs, maxOwnDeltas: 2, raceCheckMs: 0 };
  const a = addDevice(w, user, { ...common, storage: hooked });
  const a2 = addDevice(w, user, { ...common, storage: plain });
  const arm = (it: Interleaving, other: Device) => {
    let n = 0;
    inject = async (s, p) => {
      if (s !== it.step || (!it.anyPath && p !== 'index.json')) return;
      if (++n !== it.nth) return;
      inject = null;
      const r = await other.engine.sync();
      expect(r.problems).toEqual([]);
    };
  };
  return { w, mem, user, a, a2, arm };
}

/** Every file the index on the storage lists exists (an index never points to a missing file). */
async function missingListed(mem: MemoryAdapter, d: Device): Promise<string[]> {
  const idx = d.engine.own!.index;
  if (!idx) return ['<no index>'];
  const out: string[] = [];
  for (const p of idx.packs) if (!(await mem.head(p.file))) out.push(p.file);
  return out;
}

async function restoredFromStorage(w: World, d: Device): Promise<string> {
  const c = addDevice(w, d.user);
  await c.engine.sync();
  return c.store.repo.dumpOwnData();
}

describe('concurrent publishers on a coarse-ETag server with emulated conditions (WsgiDAV)', () => {
  for (const fullCheckMs of [0, 3_600_000]) {
    for (const it_ of interleavings) {
      it(`${it_.name}; ${fullCheckMs ? 'ETag shortcut on' : 'index read in full'}: no update lost, converges at the next passes`, async () => {
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
        // a is the late writer: a2's whole publication runs inside a's.
        arm(it_, a2);
        const r = await a.engine.sync();
        expect(r.problems).toEqual([]);
        expect(r.ok).toBe(true);

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
    a.store.putSave({ place: point(200, 'from a') });
    a2.store.putSave({ place: point(300, 'from a2') });
    arm(interleavings[1]!, a2);
    expect((await a.engine.sync()).ok).toBe(true);
    // a's index replaced a2's after a2 read its own back: a2's save is only on a2 now.
    expect(new TextDecoder().decode((await mem.get('index.json'))!.data)).toBe(serialize(a.engine.own!.index!));
    // The files of my document that the surviving index lists are all there (none deleted by a2).
    const docFiles = a.engine.own!.index!.packs.filter((p) => p.file.startsWith('media/')).map((p) => p.file);
    for (const f of docFiles) expect(await mem.head(f)).not.toBeNull();
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
});
