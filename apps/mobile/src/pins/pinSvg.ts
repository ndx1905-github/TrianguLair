import { MAX_PIN_BANDS } from '../config';
import { UNTAGGED_COLOR } from '../theme/tags';
import { computeBands } from './bands';

/**
 * Teardrop pin as an SVG string. The same markup is used on web (inline SVG in
 * a MapLibre GL marker element) and on native (react-native-svg `SvgXml`
 * inside a MapLibre RN `Marker`), so both platforms render identical pins.
 *
 * ViewBox 40x52: round head centered at (20,19) r=16, tip at (20,49).
 */
export const PIN_VIEWBOX = { width: 40, height: 52 } as const;
/** Anchor: the tip, as a fraction of the viewBox (x, y). */
export const PIN_ANCHOR = { x: 0.5, y: 49 / 52 } as const;

const HEAD = { cx: 20, cy: 19, r: 16 };
const PIN_PATH =
  'M20 49C17 42 4 32 4 19A16 16 0 1 1 36 19C36 32 23 42 20 49Z';
const CLIP_ID = 'tl-pin-clip'; // Same shape for every pin: duplicate ids are harmless on web.

export interface PinSpec {
  /** Tag colors in order (first = primary). */
  colors: readonly string[];
  /** SVG path (24x24 viewBox) of the icon, drawn white with a dark halo. */
  iconPath: string;
  /** Place known only through friends: lighter / translucent pin. */
  faded: boolean;
}

function esc(s: string): string {
  return s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);
}

export function pinSvg(spec: PinSpec, size = { width: 40, height: 52 }): string {
  const bands = computeBands(spec.colors, {
    top: HEAD.cy - HEAD.r,
    bottom: HEAD.cy + HEAD.r,
    max: MAX_PIN_BANDS,
    fallback: UNTAGGED_COLOR,
  });
  // First band also covers anything above the head, last band covers the tail.
  const rects = bands
    .map((b, i) => {
      const y0 = i === 0 ? 0 : b.y0;
      const y1 = i === bands.length - 1 ? PIN_VIEWBOX.height : b.y1;
      return `<rect x="0" y="${y0}" width="${PIN_VIEWBOX.width}" height="${y1 - y0}" fill="${esc(b.color)}"/>`;
    })
    .join('');

  const bandOpacity = spec.faded ? 0.5 : 1;
  const pinOpacity = spec.faded ? 0.85 : 1;
  const halo = spec.faded ? 'rgba(15,23,42,0.55)' : 'rgba(15,23,42,0.85)';
  const icon = esc(spec.iconPath);
  // Icon: 24 units scaled to 18px, centered on the head.
  const iconTransform = `translate(${HEAD.cx - 9} ${HEAD.cy - 9}) scale(0.75)`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" ` +
    `viewBox="0 0 ${PIN_VIEWBOX.width} ${PIN_VIEWBOX.height}">` +
    `<defs><clipPath id="${CLIP_ID}"><path d="${PIN_PATH}"/></clipPath></defs>` +
    `<g opacity="${pinOpacity}">` +
    `<ellipse cx="20" cy="50" rx="5" ry="1.6" fill="rgba(0,0,0,0.25)"/>` +
    `<g clip-path="url(#${CLIP_ID})">` +
    `<rect x="0" y="0" width="${PIN_VIEWBOX.width}" height="${PIN_VIEWBOX.height}" fill="#FFFFFF"/>` +
    `<g opacity="${bandOpacity}">${rects}</g>` +
    `</g>` +
    `<path d="${PIN_PATH}" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linejoin="round"/>` +
    `<path d="${PIN_PATH}" fill="none" stroke="rgba(15,23,42,0.25)" stroke-width="0.6"/>` +
    `<g transform="${iconTransform}">` +
    `<path d="${icon}" fill="none" stroke="${halo}" stroke-width="3.4" stroke-linejoin="round"/>` +
    `<path d="${icon}" fill="#FFFFFF"/>` +
    `</g>` +
    `</g></svg>`
  );
}
