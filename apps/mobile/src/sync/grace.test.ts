import { describe, expect, it } from 'vitest';

import { withGrace, type GraceNative } from './grace';

function fakeNative(opts: { refuse?: boolean } = {}) {
  const calls: string[] = [];
  let listener: ((e: { id: number }) => void) | null = null;
  const native: GraceNative = {
    begin: async (name) => {
      calls.push(`begin ${name}`);
      return opts.refuse ? 0 : 7;
    },
    end: async (id) => {
      calls.push(`end ${id}`);
    },
    addListener: (_event, l) => {
      listener = l;
      return {
        remove: () => {
          calls.push('remove');
          listener = null;
        },
      };
    },
  };
  return { native, calls, expire: (id: number) => listener?.({ id }) };
}

describe('last pass in the iOS grace period (gap #5)', () => {
  it('runs the pass inside a grace period and always ends it', async () => {
    const f = fakeNative();
    let ran = false;
    const out = await withGrace(f.native, 'last', async () => {
      ran = true;
    });
    expect(out).toBe('done');
    expect(ran).toBe(true);
    expect(f.calls).toEqual(['begin last', 'remove', 'end 7']);
  });

  it('ends the grace period when the pass fails', async () => {
    const f = fakeNative();
    const out = await withGrace(f.native, 'last', async () => {
      throw new Error('storage unreachable');
    });
    expect(out).toBe('done');
    expect(f.calls.at(-1)).toBe('end 7');
  });

  it('stops waiting when the system says time is up (the pass resumes at the next launch)', async () => {
    const f = fakeNative();
    let release: () => void = () => {};
    const pass = new Promise<void>((r) => (release = r));
    const p = withGrace(f.native, 'last', () => pass);
    await Promise.resolve();
    await Promise.resolve();
    f.expire(3); // another grace period: ignored
    f.expire(7);
    expect(await p).toBe('expired');
    expect(f.calls.at(-1)).toBe('end 7');
    release();
  });

  it('without the module (Android, web) or when refused, the pass still runs', async () => {
    let n = 0;
    expect(await withGrace(null, 'last', async () => void n++)).toBe('no-grace');
    const f = fakeNative({ refuse: true });
    expect(await withGrace(f.native, 'last', async () => void n++)).toBe('no-grace');
    expect(n).toBe(2);
    expect(f.calls).toEqual(['begin last']);
  });
});
