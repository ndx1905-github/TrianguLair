// SPDX-License-Identifier: MPL-2.0
/**
 * One entry point for a picked file: detects the format from the bytes and
 * the file name, then runs the matching reader. A CSV that is neither a
 * Google list nor a recognized app export is returned as `needsMapping`
 * with a guessed mapping, for the column-mapping screen.
 */
import { parseCsv, stripBom, type CsvTable } from './csv.ts';
import { guessMapping, isGoogleSavedCsv, parseCsvWithMapping, parseGoogleSavedCsv, type ColumnMapping } from './formats/csv.ts';
import { isGoogleLabeledPlaces, isGoogleSavedPlaces, parseGenericGeoJson, parseGoogleLabeledPlaces, parseGoogleSavedPlaces } from './formats/geojson.ts';
import { isZip, looksLikeKml, parseKml, parseKmz } from './formats/kml.ts';
import { isTriangulairArchive, isTriangulairExport, parseTriangulairArchive, parseTriangulairExport } from './formats/triangulair.ts';
import { isMapstrCsv, isMapstrGeoJson, parseMapstrCsv, parseMapstrGeoJson } from './formats/unverified/mapstr.ts';
import { isPinDropCsv, isPinDropKml, parsePinDropCsv, parsePinDropKml } from './formats/unverified/pindrop.ts';
import type { ImportFile, ParseResult } from './model.ts';
import { baseName, bytesToText } from './util.ts';

export type ReadOutcome =
  | { kind: 'parsed'; result: ParseResult }
  /** A generic CSV: confirm or correct the mapping, then call `parseCsvWithMapping`. */
  | { kind: 'needsMapping'; table: CsvTable; mapping: ColumnMapping; unmapped: number[]; fileName: string }
  | { kind: 'error'; code: 'unreadable' | 'unknown-format' | 'empty' | 'too-new'; detail?: string };

function textOf(file: ImportFile): string {
  if (file.text !== undefined) return stripBom(file.text);
  if (file.bytes) return stripBom(bytesToText(file.bytes));
  return '';
}

export function readImportFile(file: ImportFile): ReadOutcome {
  const name = file.name ?? '';
  const ext = (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase();
  try {
    if (isZip(file.bytes) || ext === 'kmz' || ext === 'zip') {
      if (!file.bytes) return { kind: 'error', code: 'unreadable' };
      // My own export with photos, or a KMZ.
      if (isTriangulairArchive(file.bytes)) {
        try {
          return { kind: 'parsed', result: parseTriangulairArchive(file.bytes) };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return { kind: 'error', code: /newer version/.test(msg) ? 'too-new' : 'unreadable', detail: msg };
        }
      }
      return { kind: 'parsed', result: parseKmz(file.bytes) };
    }
    const text = textOf(file);
    if (!text.trim()) return { kind: 'error', code: 'empty' };
    const head = text.trimStart();
    if (head.startsWith('{') || head.startsWith('[')) {
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return { kind: 'error', code: 'unreadable', detail: 'json' };
      }
      if (isTriangulairExport(json)) {
        try {
          return { kind: 'parsed', result: parseTriangulairExport(json) };
        } catch (e) {
          return { kind: 'error', code: 'too-new', detail: e instanceof Error ? e.message : String(e) };
        }
      }
      if (isGoogleSavedPlaces(json)) return { kind: 'parsed', result: parseGoogleSavedPlaces(json) };
      if (isGoogleLabeledPlaces(json, name)) return { kind: 'parsed', result: parseGoogleLabeledPlaces(json) };
      if (isMapstrGeoJson(json, name)) return { kind: 'parsed', result: parseMapstrGeoJson(json) };
      const r = parseGenericGeoJson(json);
      if (r.places.length === 0 && !(json as { type?: string }).type) return { kind: 'error', code: 'unknown-format' };
      return { kind: 'parsed', result: r };
    }
    if (head.startsWith('<')) {
      if (!looksLikeKml(head)) return { kind: 'error', code: 'unknown-format', detail: 'xml' };
      if (isPinDropKml(head, name)) return { kind: 'parsed', result: parsePinDropKml(text) };
      return { kind: 'parsed', result: parseKml(text) };
    }
    // Anything else is read as CSV / TSV.
    const table = parseCsv(text);
    if (table.headers.length < 2 || table.rows.length === 0) return { kind: 'error', code: table.headers.length < 2 ? 'unknown-format' : 'empty' };
    if (isGoogleSavedCsv(table)) return { kind: 'parsed', result: parseGoogleSavedCsv(table, name) };
    if (isMapstrCsv(table, name)) return { kind: 'parsed', result: parseMapstrCsv(text) };
    if (isPinDropCsv(table, name)) return { kind: 'parsed', result: parsePinDropCsv(text) };
    const { mapping, unmapped } = guessMapping(table);
    return { kind: 'needsMapping', table, mapping, unmapped, fileName: baseName(name) };
  } catch (e) {
    return { kind: 'error', code: 'unreadable', detail: e instanceof Error ? e.message : String(e) };
  }
}

/** Generic CSV once the mapping is confirmed; `fileTag` adds the file name as a tag (optional). */
export function readCsvWithMapping(table: CsvTable, mapping: ColumnMapping, fileTag?: string): ParseResult {
  return parseCsvWithMapping(table, mapping, fileTag ? { listTag: fileTag } : {});
}
