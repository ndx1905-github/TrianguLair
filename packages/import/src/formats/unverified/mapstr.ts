// SPDX-License-Identifier: MPL-2.0
/**
 * UNVERIFIED — Mapstr export reader, written WITHOUT a real export (task
 * T-009 pending). What is public: Mapstr's App Store listing mentions a CSV
 * export (possibly reserved to the paid plan); its columns are not
 * documented. This reader therefore:
 *
 * - recognizes a Mapstr file by its name ("mapstr…") or by a header/property
 *   that only Mapstr would write (`mapstr…`, `user comment`, `tag colors`);
 * - reads it through the generic CSV / GeoJSON paths (column guessing), plus
 *   the guesses below, each one harmless when absent:
 *   - tags as a list (`Pizza, Bar`), or as JSON `[{"name":"Pizza","color":"#E53935"}]`;
 *   - a separate tag-colors column (`Pizza:#E53935, Bar:#3949AB`);
 *   - "user comment" / "public comment" columns (both kept, user first).
 *
 * Every result carries an `unverified-format` warning so the preview says so.
 * Replace the guesses with the real columns once an export is available
 * (fixtures under test/fixtures/hypothetical/).
 */
import type { Feature } from 'geojson';

import { parseCsv, type CsvTable } from '../../csv.ts';
import type { ParseResult, SourceTag } from '../../model.ts';
import { normalizeColor, splitTags, str } from '../../util.ts';
import { guessMapping, parseCsvWithMapping } from '../csv.ts';
import { parseGenericGeoJson, pick } from '../geojson.ts';

const norm = (s: string) => s.toLowerCase().replace(/[\s_-]/g, '');

export function isMapstrName(fileName: string): boolean {
  return /mapstr/i.test(fileName);
}

export function isMapstrCsv(table: CsvTable, fileName: string): boolean {
  const h = table.headers.map(norm);
  return isMapstrName(fileName) || h.some((x) => x.startsWith('mapstr') || x === 'usercomment' || x === 'tagcolors');
}

export function isMapstrGeoJson(json: unknown, fileName: string): boolean {
  if (isMapstrName(fileName)) return true;
  const fs = (json as { features?: Feature[] } | null)?.features;
  const p = Array.isArray(fs) ? (fs[0]?.properties as Record<string, unknown> | null | undefined) : undefined;
  return !!p && Object.keys(p).some((k) => norm(k).startsWith('mapstr') || norm(k) === 'usercomment');
}

/** Tags as JSON `[{name, color}]`, or a plain list. */
function readTags(v: string | undefined): { names: string[]; colors: Map<string, string> } {
  const colors = new Map<string, string>();
  if (!v) return { names: [], colors };
  const t = v.trim();
  if (t.startsWith('[')) {
    try {
      const arr = JSON.parse(t) as unknown[];
      const names: string[] = [];
      for (const x of arr) {
        if (typeof x === 'string') names.push(x);
        else if (x && typeof x === 'object') {
          const name = str((x as Record<string, unknown>).name);
          if (!name) continue;
          names.push(name);
          const c = normalizeColor((x as Record<string, unknown>).color);
          if (c) colors.set(name, c);
        }
      }
      return { names, colors };
    } catch {
      // not JSON: fall through
    }
  }
  return { names: splitTags(t), colors };
}

/** "Pizza:#E53935, Bar:#3949AB" */
function readTagColors(v: string | undefined, into: Map<string, string>): void {
  for (const part of (v ?? '').split(/[,;|]/)) {
    const m = /^\s*(.+?)\s*[:=]\s*(#?[0-9a-f]{3,8})\s*$/i.exec(part);
    const c = m ? normalizeColor(m[2]) : undefined;
    if (m && c) into.set(m[1]!, c);
  }
}

function finish(r: ParseResult, colors: Map<string, string>): ParseResult {
  const defs = new Map<string, SourceTag>(r.tags.map((t) => [t.key, t]));
  for (const p of r.places) for (const t of p.tags) if (!defs.has(t)) defs.set(t, { key: t, name: t });
  for (const [name, color] of colors) {
    const d = defs.get(name);
    if (d && !d.color) d.color = color;
  }
  return { ...r, format: 'mapstr', tags: [...defs.values()], warnings: [{ code: 'unverified-format', detail: 'mapstr' }, ...r.warnings] };
}

export function parseMapstrCsv(text: string): ParseResult {
  const table = parseCsv(text);
  const h = table.headers.map(norm);
  const col = (...names: string[]) => {
    const i = h.findIndex((x) => names.includes(x));
    return i >= 0 ? i : undefined;
  };
  const { mapping } = guessMapping(table);
  const tagCol = col('tags', 'tag', 'mapstrtags');
  const colorCol = col('tagcolors', 'tagscolors', 'colors');
  const userComment = col('usercomment', 'mycomment', 'comment', 'mapstrcomment');
  const publicComment = col('publiccomment', 'description');
  const comments = [userComment, publicComment].filter((x): x is number => x !== undefined);
  if (comments.length > 0) mapping.comment = comments;
  const idCol = col('mapstrid', 'id', 'placeid');
  if (idCol !== undefined && mapping.id === undefined) mapping.id = idCol;
  if (colorCol !== undefined && mapping.color === colorCol) delete mapping.color;
  // Tags are parsed here (they may be JSON), not by the generic reader.
  delete mapping.tags;
  const result = parseCsvWithMapping(table, mapping, { format: 'mapstr' });
  const colors = new Map<string, string>();
  const byKey = new Map(result.places.map((p) => [p.key, p]));
  table.rows.forEach((row, i) => {
    const p = byKey.get(`r${i + 2}`);
    if (!p) return;
    const { names, colors: c } = readTags(tagCol === undefined ? undefined : row[tagCol]);
    for (const [k, v] of c) colors.set(k, v);
    readTagColors(colorCol === undefined ? undefined : row[colorCol], colors);
    p.tags = [...new Set([...p.tags, ...names])];
    if (names[0] && !p.mainTag) p.mainTag = names[0];
  });
  return finish(result, colors);
}

export function parseMapstrGeoJson(json: unknown): ParseResult {
  const result = parseGenericGeoJson(json);
  const colors = new Map<string, string>();
  const fs = ((json as { features?: Feature[] }).features ?? []) as Feature[];
  // parseGenericGeoJson keys features f0, f1… in order.
  const byKey = new Map(result.places.map((p) => [p.key, p]));
  fs.forEach((f, i) => {
    const props = (f.properties ?? {}) as Record<string, unknown>;
    const p = byKey.get(`f${i}`);
    if (!p) return;
    const raw = pick(props, 'tags', 'mapstr_tags');
    if (Array.isArray(raw)) {
      const { names, colors: c } = readTags(JSON.stringify(raw));
      for (const [k, v] of c) colors.set(k, v);
      p.tags = [...new Set(names.length ? names : p.tags)];
      if (names[0]) p.mainTag = names[0];
    }
    const user = str(pick(props, 'userComment', 'user_comment', 'myComment'));
    const pub = str(pick(props, 'publicComment', 'public_comment'));
    const comment = [user, pub].filter(Boolean).join('\n\n');
    if (comment) p.comment = comment;
  });
  return finish(result, colors);
}
