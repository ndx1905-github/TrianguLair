/**
 * The friends' dots of a pin (spec "Pins" > "Whose map"): one small dot per friend shown who saved
 * the place, in that friend's colour, along the top right of the pin's head; at most three, then a
 * "+n". Pure, unit-tested: which dots, and where they go in the pin's viewBox (40 x 52, head centred
 * on (20, 19), radius 16).
 */

/** At most this many dots on a pin; the others are counted in "+n". */
export const MAX_PIN_DOTS = 3;

export interface PinDots {
  /** One colour per dot, in the friends' order. */
  colors: string[];
  /** Friends not drawn as a dot ("+n"); 0 = none. */
  more: number;
}

/** The dots of a place saved by these friends (those shown), or null when there is none. */
export function pinDots(friendIds: readonly string[] | undefined, colorOf: (id: string) => string, max = MAX_PIN_DOTS): PinDots | null {
  if (!friendIds || friendIds.length === 0) return null;
  const n = Math.max(1, Math.floor(max));
  const shown = friendIds.slice(0, n);
  return { colors: shown.map(colorOf), more: friendIds.length - shown.length };
}

/** Dot diameter in pixels, white outline included, at the pin's normal size. */
export const DOT_PX = 9;
const HEAD = { cx: 20, cy: 19, r: 16 };
/** The "maybe closed" badge (pinSvg): centre and outer radius. */
const CLOSED = { cx: 33, cy: 6, r: 6.3 };

export interface DotCircle {
  cx: number;
  cy: number;
  /** Fill radius (the white outline is drawn around it). */
  r: number;
  color: string;
}

export interface DotLayout {
  circles: DotCircle[];
  /** "+n": a white rounded label after the dots. */
  more: { cx: number; cy: number; w: number; h: number; text: string; fontSize: number } | null;
  /** White outline width. */
  stroke: number;
  /** Room the dots need beyond the pin's viewBox, on the right and above (viewBox units). */
  padRight: number;
  padTop: number;
}

const rad = (deg: number) => (deg * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

function onHead(angle: number): { x: number; y: number } {
  return { x: HEAD.cx + HEAD.r * Math.sin(rad(angle)), y: HEAD.cy - HEAD.r * Math.cos(rad(angle)) };
}

/** Angle (from the top, clockwise) a disc of radius `half` takes on the head's outline, each side. */
function halfAngle(half: number): number {
  return deg(Math.asin(Math.min(1, half / HEAD.r)));
}

/**
 * Where the dots go. `scale` is the pin's drawn scale (1 = 40 x 52 px): on smaller pins (outside the
 * filter) the dots keep their size in pixels, so they stay legible; on the selected pin they grow
 * with it. With the "maybe closed" badge at the top right, they start below it.
 */
export function dotLayout(dots: PinDots, opts: { scale?: number; maybeClosed?: boolean } = {}): DotLayout {
  const k = Math.max(1, 1 / (opts.scale ?? 1));
  const stroke = 1.5 * k;
  const outer = (DOT_PX / 2) * k;
  const r = outer - stroke / 2;
  const gap = 0.8 * k;
  let angle = opts.maybeClosed ? 45 + halfAngle(CLOSED.r + gap) + halfAngle(outer) : 40;
  const circles: DotCircle[] = [];
  let minY = 0;
  let maxX = 0;
  for (let i = 0; i < dots.colors.length; i++) {
    if (i > 0) angle += 2 * halfAngle(outer + gap / 2);
    const p = onHead(angle);
    circles.push({ cx: round(p.x), cy: round(p.y), r: round(r), color: dots.colors[i]! });
    minY = Math.min(minY, p.y - outer);
    maxX = Math.max(maxX, p.x + outer);
  }
  let more: DotLayout['more'] = null;
  if (dots.more > 0) {
    const text = `+${dots.more}`;
    const fontSize = 7 * k;
    const h = 2 * outer;
    const w = Math.max(h, fontSize * 0.62 * text.length + 3 * k);
    // Next to the last dot, along the outline.
    angle += halfAngle(outer + gap / 2) + halfAngle(w / 2 + gap / 2);
    const p = onHead(angle);
    // Kept to the right of the head's axis, so it never covers the tip.
    const cx = Math.max(p.x, HEAD.cx + w / 2);
    more = { cx: round(cx), cy: round(p.y), w: round(w), h: round(h), text, fontSize: round(fontSize) };
    minY = Math.min(minY, p.y - h / 2);
    maxX = Math.max(maxX, cx + w / 2);
  }
  return {
    circles,
    more,
    stroke: round(stroke),
    padRight: maxX > 40 ? round(maxX - 40 + 0.5) : 0,
    padTop: minY < 0 ? round(-minY + 0.5) : 0,
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
