// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';

import { osmPoint } from './helpers.ts';
import { openStore } from './stores.ts';

describe('SaveInput.createdAt (imports keep the original date)', () => {
  it('sets the creation date of a new save; updatedAt defaults to it', () => {
    const s = openStore();
    s.putSave({ place: osmPoint(1, 'A', 48.85, 2.35), createdAt: 1_600_000_000_000 });
    const save = s.repo.getMySaveForPlace('osm:node/1')!;
    expect(save.createdAt).toBe(1_600_000_000_000);
    expect(save.updatedAt).toBe(1_600_000_000_000);
  });

  it('is ignored for an existing save and when invalid', () => {
    const s = openStore();
    s.putSave({ place: osmPoint(1, 'A', 48.85, 2.35) });
    const first = s.repo.getMySaveForPlace('osm:node/1')!.createdAt;
    s.putSave({ place: osmPoint(1, 'A', 48.85, 2.35), createdAt: 5 });
    expect(s.repo.getMySaveForPlace('osm:node/1')!.createdAt).toBe(first);
    s.putSave({ place: osmPoint(2, 'B', 48.85, 2.35), createdAt: Number.NaN });
    expect(s.repo.getMySaveForPlace('osm:node/2')!.createdAt).toBeGreaterThan(1_000_000_000_000);
  });
});
