import { describe, expect, it } from 'vitest';

import { MemoryAdapter, PreconditionFailed } from '../src/index.ts';
import { emulatePrecondition, sameEtag } from '../src/util.ts';

describe('ETags rewritten by a compressing proxy', () => {
  it('compare weakly', () => {
    expect(sameEtag('W/"abc"', '"abc"')).toBe(true);
    expect(sameEtag('"abc-gzip"', '"abc"')).toBe(true);
    expect(sameEtag('"abc;gzip"', 'W/"abc"')).toBe(true);
    expect(sameEtag('"abc"', '"abd"')).toBe(false);
  });

  it('pass the emulated If-Match when the file did not change, fail when it did', async () => {
    const head = async () => ({ etag: '"v1"' });
    await expect(emulatePrecondition(head, 'index.json', 'W/"v1"', undefined)).resolves.toBeUndefined();
    await expect(emulatePrecondition(head, 'index.json', '"v1-gzip"', undefined)).resolves.toBeUndefined();
    await expect(emulatePrecondition(head, 'index.json', 'W/"v0"', undefined)).rejects.toBeInstanceOf(PreconditionFailed);
    void MemoryAdapter;
  });
});
