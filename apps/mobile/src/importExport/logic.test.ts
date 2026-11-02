import { describe, expect, it } from 'vitest';
import { buildPlan, readImportFile, type ImportReport } from '@triangulair/import';

import { firstGroup, itemsByGroup, rowOutcome, toWrite, undoableReport, serializeReport, UNDO_DAYS } from './logic';

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
    expect(plan.items.map(rowOutcome)).toEqual(['manual', 'duplicate']);
    expect(toWrite(plan)).toBe(1);
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
