/**
 * Shared conformance suite: every adapter must pass it.
 *
 *   runAdapterConformance(async () => ({ adapter, cleanup }))
 *   runAdapterConformance('WebDAV', async () => ({ adapter, cleanup }))   // named
 *
 * The factory is called before each test and must return an adapter on an
 * EMPTY root. Read-only adapters provide `seed` to write fixture data through
 * a writable path to the same backing store.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  InvalidPath,
  NotFound,
  PreconditionFailed,
  ReadOnly,
  Unsupported,
} from '../errors.ts';
import { INDEX_PATH, PUBLIC_LISTS_PATH, indexPath, packPath } from '../layout.ts';
import { fetchHighestIndex, fetchPack, fetchSnapshot, publishSnapshot } from '../snapshot.ts';
import type { StorageAdapter } from '../types.ts';

export interface ConformanceFixture {
  adapter: StorageAdapter;
  /** Required for read-only adapters: write `data` at `path` out of band. */
  seed?: (path: string, data: Uint8Array) => Promise<void>;
  /** If true, `capabilities.publicUrl()` must be anonymously fetchable with global fetch. */
  publicUrlFetchable?: boolean;
  /**
   * Known server limitation: conditions are enforced for sequential requests
   * but NOT atomically (check-then-write without a lock), so concurrent
   * conditional writers may all succeed. The concurrency tests then only
   * assert the weaker guarantee (at least one winner, losers get
   * PreconditionFailed, final content is one of the winners').
   */
  nonAtomicConditionals?: boolean;
  cleanup?: () => Promise<void>;
}

export type ConformanceFactory = () => Promise<ConformanceFixture>;

const enc = (s: string) => new TextEncoder().encode(s);
const allBytes = () => Uint8Array.from({ length: 256 * 3 }, (_, i) => i % 256);

export function runAdapterConformance(factory: ConformanceFactory): void;
export function runAdapterConformance(name: string, factory: ConformanceFactory): void;
export function runAdapterConformance(
  nameOrFactory: string | ConformanceFactory,
  maybeFactory?: ConformanceFactory,
): void {
  const name = typeof nameOrFactory === 'string' ? nameOrFactory : 'storage';
  const factory = typeof nameOrFactory === 'string' ? maybeFactory : nameOrFactory;
  if (!factory) throw new Error('runAdapterConformance: missing factory');
  describe(`${name} adapter conformance`, () => {
    let fx: ConformanceFixture;
    let a: StorageAdapter;

    beforeEach(async () => {
      fx = await factory();
      a = fx.adapter;
    });
    afterEach(async () => {
      await fx.cleanup?.();
    });

    /** Write via the adapter, or via seed for read-only adapters. */
    async function write(path: string, data: Uint8Array): Promise<void> {
      if (a.capabilities.readOnly) {
        if (!fx.seed) throw new Error('read-only fixture needs seed()');
        await fx.seed(path, data);
      } else {
        await a.put(path, data);
      }
    }

    it('returns null for missing objects', async () => {
      expect(await a.get('nope.bin')).toBeNull();
      expect(await a.head('nope.bin')).toBeNull();
      expect(await a.get('no/such/dir/x.bin')).toBeNull();
    });

    it('rejects invalid paths', async () => {
      for (const p of ['', '/abs', '../up', 'a/../b', 'a//b', 'dir/', './x']) {
        await expect(a.get(p), p).rejects.toBeInstanceOf(InvalidPath);
      }
    });

    it('round-trips binary data (nested path) with consistent ETags', async () => {
      const data = allBytes();
      await write('packs/abc.bin', data);
      const g = await a.get('packs/abc.bin');
      expect(g).not.toBeNull();
      expect(Array.from(g!.data)).toEqual(Array.from(data));
      expect(g!.etag).toBeTruthy();
      const h = await a.head('packs/abc.bin');
      expect(h).toEqual({ etag: g!.etag, size: data.byteLength });
    });

    it('handles empty files and odd-but-valid names', async () => {
      await write('public/empty file é.txt', new Uint8Array());
      const g = await a.get('public/empty file é.txt');
      expect(g?.data.byteLength).toBe(0);
      expect((await a.head('public/empty file é.txt'))?.size).toBe(0);
    });

    it('capabilities are coherent', () => {
      const c = a.capabilities;
      expect(typeof c.readOnly).toBe('boolean');
      expect(typeof c.conditionalWrites).toBe('boolean');
      expect(typeof c.list).toBe('boolean');
      const u = c.publicUrl(INDEX_PATH);
      expect(u === null || /^https?:\/\//.test(u)).toBe(true);
    });

    it('publicUrl serves the object anonymously (when configured)', async () => {
      if (!fx.publicUrlFetchable) return;
      await write(PUBLIC_LISTS_PATH, enc('{"type":"FeatureCollection","features":[]}'));
      const url = a.capabilities.publicUrl(PUBLIC_LISTS_PATH);
      expect(url).toBeTruthy();
      const res = await fetch(url!);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('{"type":"FeatureCollection","features":[]}');
    });

    it('read-only adapters refuse writes with ReadOnly', async () => {
      if (!a.capabilities.readOnly) return;
      await expect(a.put('x.bin', enc('x'))).rejects.toBeInstanceOf(ReadOnly);
      await expect(a.delete('x.bin')).rejects.toBeInstanceOf(ReadOnly);
    });

    it('list is sorted, recursive, prefix-filtered (or Unsupported)', async () => {
      await write('index.json', enc('{}'));
      await write('packs/b.bin', enc('bb'));
      await write('packs/a.bin', enc('a'));
      await write('packs/sub/c.bin', enc('ccc'));
      await write('public/lists.geojson', enc('{}'));
      if (!a.capabilities.list) {
        await expect(a.list('packs/')).rejects.toBeInstanceOf(Unsupported);
        return;
      }
      const packs = await a.list('packs/');
      expect(packs.map((e) => e.path)).toEqual(['packs/a.bin', 'packs/b.bin', 'packs/sub/c.bin']);
      expect(packs.map((e) => e.size)).toEqual([1, 2, 3]);
      for (const e of packs) expect(e.etag).toBe((await a.head(e.path))!.etag);
      expect((await a.list('')).map((e) => e.path)).toEqual([
        'index.json',
        'packs/a.bin',
        'packs/b.bin',
        'packs/sub/c.bin',
        'public/lists.geojson',
      ]);
      expect((await a.list('packs/a')).map((e) => e.path)).toEqual(['packs/a.bin']);
      expect(await a.list('nothing/')).toEqual([]);
    });

    describe('writes', () => {
      it('overwrite changes the ETag', async () => {
        if (a.capabilities.readOnly) return;
        const p1 = await a.put('index.json', enc('v1'));
        const p2 = await a.put('index.json', enc('v2'));
        expect(p1.etag).not.toBe(p2.etag);
        expect((await a.head('index.json'))!.etag).toBe(p2.etag);
        expect(new TextDecoder().decode((await a.get('index.json'))!.data)).toBe('v2');
      });

      it('ifNoneMatch "*" creates only when absent', async () => {
        if (a.capabilities.readOnly) return;
        const { etag } = await a.put('index.json', enc('first'), { ifNoneMatch: '*' });
        await expect(a.put('index.json', enc('second'), { ifNoneMatch: '*' })).rejects.toBeInstanceOf(
          PreconditionFailed,
        );
        const g = await a.get('index.json');
        expect(new TextDecoder().decode(g!.data)).toBe('first');
        expect(g!.etag).toBe(etag);
      });

      it('ifMatch succeeds on current ETag and fails on stale/missing', async () => {
        if (a.capabilities.readOnly) return;
        const { etag: e1 } = await a.put('index.json', enc('one'));
        const { etag: e2 } = await a.put('index.json', enc('two'), { ifMatch: e1 });
        expect(e2).not.toBe(e1);
        await expect(a.put('index.json', enc('three'), { ifMatch: e1 })).rejects.toBeInstanceOf(PreconditionFailed);
        expect(new TextDecoder().decode((await a.get('index.json'))!.data)).toBe('two');
        await expect(a.put('missing.json', enc('x'), { ifMatch: e2 })).rejects.toBeInstanceOf(PreconditionFailed);
        expect(await a.head('missing.json')).toBeNull();
      });

      it('delete: idempotent, conditional with ifMatch', async () => {
        if (a.capabilities.readOnly) return;
        await a.delete('never-existed.bin');
        const { etag: e1 } = await a.put('packs/x.bin', enc('1'));
        const { etag: e2 } = await a.put('packs/x.bin', enc('22'));
        await expect(a.delete('packs/x.bin', { ifMatch: e1 })).rejects.toBeInstanceOf(PreconditionFailed);
        expect(await a.head('packs/x.bin')).not.toBeNull();
        await a.delete('packs/x.bin', { ifMatch: e2 });
        expect(await a.get('packs/x.bin')).toBeNull();
        await expect(a.delete('packs/x.bin', { ifMatch: e2 })).rejects.toBeInstanceOf(PreconditionFailed);
        await a.delete('packs/x.bin');
      });

      it('concurrent ifMatch writers: exactly one wins (atomic backends only)', async () => {
        if (a.capabilities.readOnly || !a.capabilities.conditionalWrites) return;
        const { etag } = await a.put('index.json', enc('base'));
        const results = await Promise.allSettled(
          Array.from({ length: 5 }, (_, i) => a.put('index.json', enc(`writer-${i}`), { ifMatch: etag })),
        );
        const won = results.filter((r) => r.status === 'fulfilled');
        const lost = results.filter((r) => r.status === 'rejected');
        for (const r of lost) expect((r as PromiseRejectedResult).reason).toBeInstanceOf(PreconditionFailed);
        const final = await a.get('index.json');
        const winnerEtags = won.map((r) => (r as PromiseFulfilledResult<{ etag: string }>).value.etag);
        if (fx.nonAtomicConditionals) {
          expect(won.length).toBeGreaterThanOrEqual(1);
          expect(winnerEtags).toContain(final!.etag);
        } else {
          expect(won).toHaveLength(1);
          expect(final!.etag).toBe(winnerEtags[0]);
        }
      });

      it('concurrent ifNoneMatch creators: exactly one wins (atomic backends only)', async () => {
        if (a.capabilities.readOnly || !a.capabilities.conditionalWrites) return;
        const results = await Promise.allSettled(
          Array.from({ length: 5 }, (_, i) => a.put('index.json', enc(`creator-${i}`), { ifNoneMatch: '*' })),
        );
        const won = results.filter((r) => r.status === 'fulfilled').length;
        if (fx.nonAtomicConditionals) expect(won).toBeGreaterThanOrEqual(1);
        else expect(won).toBe(1);
        for (const r of results)
          if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(PreconditionFailed);
      });

      it('caller mutation after put does not affect stored data', async () => {
        if (a.capabilities.readOnly) return;
        const buf = enc('abc');
        await a.put('m.bin', buf);
        buf[0] = 0x7a;
        expect(new TextDecoder().decode((await a.get('m.bin'))!.data)).toBe('abc');
      });
    });

    describe('snapshot helpers', () => {
      it('publish then fetch, skip when unchanged, detect concurrent publisher', async () => {
        if (a.capabilities.readOnly) {
          // Friend side only: fetch what the owner published.
          await fx.seed!(packPath('p1'), enc('pack-1'));
          await fx.seed!(INDEX_PATH, enc('{"v":1}'));
          const f1 = await fetchSnapshot(a, null);
          expect(f1.changed).toBe(true);
          const f2 = await fetchSnapshot(a, f1.etag);
          expect(f2).toEqual({ changed: false, etag: f1.etag });
          expect(new TextDecoder().decode(await fetchPack(a, 'p1'))).toBe('pack-1');
          return;
        }
        await expect(fetchSnapshot(a, null)).rejects.toBeInstanceOf(NotFound);

        const r1 = await publishSnapshot(a, {
          index: enc('{"v":1}'),
          packs: { p1: enc('pack-1'), p2: enc('pack-2') },
          previousIndexEtag: null,
          publicLists: enc('{"type":"FeatureCollection","features":[]}'),
        });
        expect(Object.keys(r1.packEtags).sort()).toEqual(['p1', 'p2']);

        const f1 = await fetchSnapshot(a, null);
        expect(f1.changed && new TextDecoder().decode(f1.index)).toBe('{"v":1}');
        expect(f1.etag).toBe(r1.indexEtag);
        expect(await fetchSnapshot(a, r1.indexEtag)).toEqual({ changed: false, etag: r1.indexEtag });
        expect(new TextDecoder().decode(await fetchPack(a, 'p2'))).toBe('pack-2');
        expect(await a.head(PUBLIC_LISTS_PATH)).not.toBeNull();

        // A second "first publish" must not clobber the existing index.
        await expect(
          publishSnapshot(a, { index: enc('{"v":"x"}'), packs: {}, previousIndexEtag: null }),
        ).rejects.toBeInstanceOf(PreconditionFailed);

        // Device A publishes v2 based on v1.
        const r2 = await publishSnapshot(a, {
          index: enc('{"v":2}'),
          packs: new Map([['p3', enc('pack-3')]]),
          previousIndexEtag: r1.indexEtag,
        });
        // Device B, still based on v1, loses the race: packs uploaded, index rejected.
        await expect(
          publishSnapshot(a, { index: enc('{"v":"B"}'), packs: { p4: enc('pack-4') }, previousIndexEtag: r1.indexEtag }),
        ).rejects.toBeInstanceOf(PreconditionFailed);
        const f2 = await fetchSnapshot(a, r1.indexEtag);
        expect(f2.changed).toBe(true);
        expect(f2.etag).toBe(r2.indexEtag);
        expect(f2.changed && new TextDecoder().decode(f2.index)).toBe('{"v":2}');
      });

      it('index.v<N>.json next to index.json during a major transition', async () => {
        const dec = (b: Uint8Array) => new TextDecoder().decode(b);
        if (a.capabilities.readOnly) {
          await fx.seed!(INDEX_PATH, enc('{"version":4}'));
          const old = await fetchHighestIndex(a, [5, 4]);
          expect(old.path).toBe(INDEX_PATH);
          await fx.seed!(indexPath(5), enc('{"version":5}'));
          const r = await fetchHighestIndex(a, [4, 5]);
          expect(r.changed && dec(r.index)).toBe('{"version":5}');
          expect(r.major).toBe(5);
          expect(await fetchHighestIndex(a, [5], { [indexPath(5)]: r.etag })).toMatchObject({ changed: false, major: 5 });
          return;
        }
        // A reader of 4 and 5, before the transition: only index.json.
        const r1 = await publishSnapshot(a, { index: enc('{"version":4}'), packs: {}, previousIndexEtag: null });
        const f0 = await fetchHighestIndex(a, [5, 4]);
        expect(f0).toMatchObject({ changed: true, major: null, path: INDEX_PATH });
        // The transition: both majors, each conditional.
        const r2 = await publishSnapshot(a, {
          index: enc('{"version":4,"seq":2}'),
          packs: {},
          previousIndexEtag: r1.indexEtag,
          newerIndexes: [{ major: 5, index: enc('{"version":5,"seq":2}'), previousEtag: null }],
        });
        expect(await a.head(indexPath(5))).not.toBeNull();
        const f5 = await fetchHighestIndex(a, [4, 5]);
        expect(f5.changed && dec(f5.index)).toBe('{"version":5,"seq":2}');
        expect(f5.etag).toBe(r2.newerIndexEtags[5]);
        // An older reader (4 only) keeps reading index.json.
        const f4 = await fetchHighestIndex(a, [4]);
        expect(f4.changed && dec(f4.index)).toBe('{"version":4,"seq":2}');
        // Unchanged: one HEAD, by path.
        expect(await fetchHighestIndex(a, [5, 4], { [indexPath(5)]: f5.etag })).toMatchObject({ changed: false, major: 5 });
        // The newer index is conditional too: a stale writer loses, and index.json is not touched.
        await expect(
          publishSnapshot(a, {
            index: enc('{"version":4,"seq":3}'),
            packs: {},
            previousIndexEtag: r2.indexEtag,
            newerIndexes: [{ major: 5, index: enc('{"version":5,"seq":3}'), previousEtag: null }],
          }),
        ).rejects.toBeInstanceOf(PreconditionFailed);
        expect(dec((await a.get(INDEX_PATH))!.data)).toBe('{"version":4,"seq":2}');
      });
    });
  });
}
