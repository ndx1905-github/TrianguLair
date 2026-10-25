// SPDX-License-Identifier: MPL-2.0
/** Text normalization shared by full-text search and duplicate detection. */

const LIGATURES: Record<string, string> = { œ: 'oe', æ: 'ae', ß: 'ss', ø: 'o', ł: 'l', đ: 'd', ı: 'i' };

/** Lowercase, no diacritics, punctuation as spaces, single spaces. "Café d’Orsay!" → "cafe d orsay". */
export function normalizeText(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[œæßøłđı]/g, (c) => LIGATURES[c] ?? c)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function tokenize(s: string): string[] {
  const n = normalizeText(s);
  return n === '' ? [] : n.split(' ');
}

/**
 * FTS5 MATCH expression for search-as-you-type: every token must match, the
 * last one (and every other) as a prefix. Tokens are normalized, so they only
 * contain letters and digits and are safe inside double quotes.
 */
export function ftsMatchQuery(input: string): string | null {
  const tokens = tokenize(input).slice(0, 12);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"*`).join(' ');
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const padded = ` ${s} `;
  for (let i = 0; i + 1 < padded.length; i++) {
    const g = padded.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Words that say little about which place it is, ignored when comparing names. */
const GENERIC = new Set([
  'le', 'la', 'les', 'l', 'de', 'du', 'des', 'd', 'the', 'a', 'an', 'of', 'and', 'et', 'chez', 'au', 'aux',
]);

function significant(s: string): string {
  const toks = tokenize(s);
  const kept = toks.filter((t) => !GENERIC.has(t));
  return (kept.length > 0 ? kept : toks).join(' ');
}

/**
 * Name similarity in [0, 1]: Sørensen–Dice on character bigrams of the
 * normalized names (generic words removed), with 1 when one name contains the
 * other as whole words ("Paul" / "Boulangerie Paul"). Symmetric.
 */
export function nameSimilarity(a: string, b: string): number {
  const x = significant(a);
  const y = significant(b);
  if (x === '' || y === '') return 0;
  if (x === y) return 1;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length >= 4 && ` ${long} `.includes(` ${short} `)) return 1;
  const bx = bigrams(x);
  const by = bigrams(y);
  let inter = 0;
  let total = 0;
  for (const [g, c] of bx) {
    inter += Math.min(c, by.get(g) ?? 0);
    total += c;
  }
  for (const c of by.values()) total += c;
  return total === 0 ? 0 : (2 * inter) / total;
}
