import { describe, expect, it } from 'vitest';
import { buildPlan, readImportFile, type ImportReport } from '@triangulair/import';

import { firstGroup, itemsByGroup, previewWarnings, rowOutcome, toWrite, undoableReport, serializeReport, UNDO_DAYS } from './logic';

const KML = `<kml><Document><Folder><name>Bars</name>
<Placemark><name>A</name><Point><coordinates>2.36,48.86</coordinates></Point></Placemark>
<Placemark><name>A</name><Point><coordinates>2.36,48.86</coordinates></Point></Placemark>
</Folder></Document></kml>`;

describe('import screen logic', () => {
  it('groups, outcomes and counts', () => {
    const o = readImportFile({ name: 'x.kml', text: KML });
    if (o.kind !== 'parsed') throw new Error(o.kind);
    const plan = buildPlan(o.result, new Map(), null);
    expect(itemsByGroup(plan).manual).toHaveLength(2);
    expect(firstGroup(plan)).toBe('manual');
    expect(plan.items.map((it) => rowOutcome(it))).toEqual(['manual', 'duplicate']);
    expect(toWrite(plan)).toBe(1);
  });

  it('a place already saved: left as it is unless the user merges; Mapstr warnings counted', () => {
    const plan = buildPlan({ format: 'mapstr', places: [{ key: 'm0', name: 'A', lat: 48.86, lon: 2.36, tags: [], ids: {} }], tags: [], warnings: [
      { code: 'remote-photos', detail: '3' },
      { code: 'row-not-joined', at: 'm0' },
      { code: 'row-not-joined', at: 'm1' },
      { code: 'no-coordinates', at: 'm1' },
    ] }, new Map(), null);
    const existing = { ...plan, items: plan.items.map((it) => ({ ...it, existing: { placeId: 'local:abcdefgh', name: 'A', reason: 'nearby-similar' as const, inTrash: false } })) };
    expect(rowOutcome(existing.items[0]!)).toBe('existing');
    expect(rowOutcome(existing.items[0]!, true)).toBe('merge');
    expect(toWrite(existing)).toBe(0);
    expect(toWrite({ ...existing, mergeExisting: true })).toBe(1);
    expect(previewWarnings(plan)).toEqual([
      { code: 'row-not-joined', count: 2 },
      { code: 'remote-photos', count: 3 },
    ]);
  });

  it('the last import can be undone for a few days', () => {
    const r: ImportReport = {
      format: 'kml',
      at: 1000,
      cancelled: false,
      createdPlaceIds: ['local:x'],
      merged: [],
      createdTagIds: [],
      createdListIds: [],
      counts: { imported: 1, created: 1, merged: 0, linkedToOsm: 0, manual: 1, toCheck: 0, skipped: 0, duplicates: 0 },
    };
    expect(undoableReport(serializeReport(r), 2000)).toEqual(r);
    expect(undoableReport(serializeReport(r), 1000 + UNDO_DAYS * 86_400_000 + 1)).toBeNull();
    expect(undoableReport('{bad', 0)).toBeNull();
    expect(undoableReport(null, 0)).toBeNull();
  });
});
