// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { snapshotOfUpdates } from '../src/store.ts';
import { osmPoint } from './helpers.ts';
import { openStore } from './stores.ts';

describe('snapshots for the sync step (T-204)', () => {
  it('isAt / exportSince / snapshotOfUpdates agree', () => {
    const a = openStore({ actor: 'device-a' });
    a.putSave({ place: osmPoint(1, 'One', 48.85, 2.35) });
    const published = [a.exportDoc()];
    const remote = snapshotOfUpdates(published);
    expect(a.isAt(remote)).toBe(true);

    // An edit is detected, and exported.
    a.updateSave('osm:node/1', { status: 'tried' });
    expect(a.isAt(remote)).toBe(false);
    const delta = a.exportSince(remote);
    const remote2 = snapshotOfUpdates([...published, delta]);
    expect(a.isAt(remote2)).toBe(true);

    // A deletion alone (no new struct) is detected too: purgeTrash removes map entries.
    a.deleteSave('osm:node/1');
    const before = snapshotOfUpdates([...published, delta, a.exportSince(remote2)]);
    expect(a.isAt(before)).toBe(true);

    // Another device rebuilds the same state from the published updates.
    const b = openStore({ actor: 'device-b' });
    b.importChanges(published[0]!);
    b.importChanges(delta);
    expect(b.repo.getMySaveForPlace('osm:node/1')?.status).toBe('tried');
    expect(a.snapshot().byteLength).toBeGreaterThan(0);
  });

  it('a pure deletion changes the snapshot', () => {
    const a = openStore({ actor: 'device-a', now: () => 1_000 });
    a.putSave({ place: osmPoint(1, 'One', 48.85, 2.35) });
    a.deleteSave('osm:node/1');
    const s = a.snapshot();
    expect(a.isAt(s)).toBe(true);
    // Purge long after: removes the entry (a deletion without any new struct for that entry).
    const late = openStore({ actor: 'device-a2', now: () => 1_000 + 400 * 86_400_000 });
    late.importChanges(a.exportDoc());
    const s2 = late.snapshot();
    expect(late.purgeTrash()).toBeGreaterThan(0);
    expect(late.isAt(s2)).toBe(false);
  });
});
