// SPDX-License-Identifier: MPL-2.0
/**
 * UNVERIFIED — Pin Drop export reader, written WITHOUT a real export (task
 * T-009 pending). Public descriptions of Pin Drop (iOS) mention exporting
 * pins as KML and CSV; neither layout is documented. This reader:
 *
 * - recognizes a Pin Drop file by its name ("pin drop", "pindrop", "pins
 *   export"), or a KML whose Document name or generator mentions Pin Drop;
 * - KML: the standard KML reader (groups/folders become tags, colors read);
 * - CSV: the generic reader with its column guessing, plus the guesses below:
 *   `Group`/`Collection` → a tag (like a list), `Notes` → comment,
 *   `Visited` (yes/true) → status "tried".
 *
 * Results carry an `unverified-format` warning. Fixtures under
 * test/fixtures/hypothetical/.
 */
import { parseCsv, type CsvTable } from '../../csv.ts';
import type { ParseResult } from '../../model.ts';
import { guessMapping, parseCsvWithMapping } from '../csv.ts';
import { parseKml } from '../kml.ts';

const norm = (s: string) => s.toLowerCase().replace(/[\s_-]/g, '');

export function isPinDropName(fileName: string): boolean {
  return /pin[\s_-]?drop|pins?[\s_-]export/i.test(fileName);
}

export function isPinDropKml(text: string, fileName: string): boolean {
  return isPinDropName(fileName) || /pin\s?drop/i.test(text.slice(0, 3000));
}

export function isPinDropCsv(table: CsvTable, fileName: string): boolean {
  return isPinDropName(fileName) || table.headers.some((h) => norm(h).startsWith('pindrop'));
}

function unverified(r: ParseResult): ParseResult {
  return { ...r, format: 'pindrop', warnings: [{ code: 'unverified-format', detail: 'pindrop' }, ...r.warnings] };
}

export function parsePinDropKml(text: string): ParseResult {
  return unverified(parseKml(text, { format: 'pindrop' }));
}

export function parsePinDropCsv(text: string): ParseResult {
  const table = parseCsv(text);
  const h = table.headers.map(norm);
  const { mapping } = guessMapping(table);
  const group = h.findIndex((x) => x === 'group' || x === 'collection' || x === 'groupname');
  if (group >= 0 && mapping.list === undefined) {
    mapping.list = group;
    if (mapping.tags) mapping.tags = mapping.tags.filter((i) => i !== group);
  }
  const visited = h.findIndex((x) => x === 'visited' || x === 'beenhere');
  if (visited >= 0 && mapping.status === visited) delete mapping.status;
  const r = parseCsvWithMapping(table, mapping, { format: 'pindrop' });
  if (visited >= 0) {
    const byKey = new Map(r.places.map((p) => [p.key, p]));
    table.rows.forEach((row, i) => {
      const p = byKey.get(`r${i + 2}`);
      if (p && !p.status && /^(yes|true|1|oui|x)$/i.test((row[visited] ?? '').trim())) p.status = 'tried';
    });
  }
  return unverified(r);
}
