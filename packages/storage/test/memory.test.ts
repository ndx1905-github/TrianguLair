import { describe, expect, it } from 'vitest';
import { InvalidPath, MemoryAdapter, packIdOf, packPath, probeConditionalWrites } from '../src/index.ts';
import { runAdapterConformance } from '../src/testing/conformance.ts';

// Unnamed form: runAdapterConformance(factory).
runAdapterConformance(async () => ({ adapter: new MemoryAdapter() }));

runAdapterConformance('Memory (read-only)', async () => {
  const adapter = new MemoryAdapter({ readOnly: true });
  return { adapter, seed: async (p, d) => void adapter.putUnchecked(p, d) };
});

describe('layout', () => {
  it('packPath validates ids and round-trips', () => {
    expect(packPath('abc_D-9')).toBe('packs/abc_D-9.bin');
    expect(packIdOf('packs/abc_D-9.bin')).toBe('abc_D-9');
    expect(packIdOf('packs/sub/x.bin')).toBeNull();
    expect(() => packPath('../x')).toThrow(InvalidPath);
    expect(() => packPath('')).toThrow(InvalidPath);
  });
});

describe('probeConditionalWrites', () => {
  it('reports true for an enforcing backend and cleans up', async () => {
    const a = new MemoryAdapter();
    expect(await probeConditionalWrites(a)).toBe(true);
    expect(await a.list('')).toEqual([]);
  });
});
