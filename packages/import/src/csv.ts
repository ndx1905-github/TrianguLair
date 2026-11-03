// SPDX-License-Identifier: MPL-2.0
/**
 * A small RFC 4180 CSV reader: quoted fields with embedded separators,
 * quotes and newlines, CRLF or LF, a UTF-8 BOM, and the separator sniffed
 * among `,` `;` and tab (spreadsheets in French locales write `;`).
 */

export interface CsvTable {
  headers: string[];
  rows: string[][];
  delimiter: string;
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Picks the separator that splits the first line (outside quotes) into the most fields. */
export function sniffDelimiter(text: string): string {
  const candidates = [',', ';', '\t'];
  let best = ',';
  let bestCount = 0;
  let firstLine = '';
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    firstLine += quoted ? '' : ch;
  }
  for (const d of candidates) {
    const n = firstLine.split(d).length - 1;
    if (n > bestCount) {
      best = d;
      bestCount = n;
    }
  }
  return best;
}

export function parseCsvRows(input: string, delimiter?: string): { rows: string[][]; delimiter: string } {
  const text = stripBom(input);
  const d = delimiter ?? sniffDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field.trim() === '') {
      field = '';
      quoted = true;
      i++;
    } else if (ch === d) {
      row.push(field);
      field = '';
      i++;
    } else if (ch === '\r' || ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else {
      field += ch;
      i++;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop blank lines.
  return { rows: rows.filter((r) => r.some((f) => f.trim() !== '')), delimiter: d };
}

export function parseCsv(input: string, delimiter?: string): CsvTable {
  const { rows, delimiter: d } = parseCsvRows(input, delimiter);
  const headers = (rows[0] ?? []).map((h) => h.trim());
  return { headers, rows: rows.slice(1), delimiter: d };
}

/** Quotes a field when needed (export). */
export function csvField(v: string, delimiter = ','): string {
  return /["\r\n]/.test(v) || v.includes(delimiter) || /^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function toCsv(headers: readonly string[], rows: readonly (readonly string[])[], delimiter = ','): string {
  return [headers, ...rows].map((r) => r.map((f) => csvField(f, delimiter)).join(delimiter)).join('\r\n') + '\r\n';
}
