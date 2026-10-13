/**
 * Color bands of a multi-tag pin: the pin body (round head) is split into up
 * to `max` horizontal bands of equal height, stacked top to bottom in tag
 * order and centered on the head. Pure logic, unit-tested.
 */
export interface Band {
  color: string;
  /** Top edge (inclusive), in pin viewBox units. */
  y0: number;
  /** Bottom edge, in pin viewBox units. */
  y1: number;
}

export interface BandOptions {
  /** Top of the pin body in viewBox units. */
  top: number;
  /** Bottom of the pin body in viewBox units. */
  bottom: number;
  /** Max number of bands (extra colors are dropped). */
  max: number;
  /** Color used when there is no color at all. */
  fallback: string;
}

/** Remove duplicate colors (two tags may share a color), keep order. */
export function uniqueColors(colors: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of colors) {
    const k = c.trim().toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(c);
    }
  }
  return out;
}

export function computeBands(colors: readonly string[], opts: BandOptions): Band[] {
  const { top, bottom, max, fallback } = opts;
  if (!(bottom > top)) throw new Error('computeBands: bottom must be > top');
  const list = uniqueColors(colors).slice(0, Math.max(1, Math.floor(max)));
  if (list.length === 0) list.push(fallback);
  const h = (bottom - top) / list.length;
  return list.map((color, i) => ({
    color,
    y0: top + i * h,
    // Last band ends exactly on `bottom` (avoid float drift).
    y1: i === list.length - 1 ? bottom : top + (i + 1) * h,
  }));
}
