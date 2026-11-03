/**
 * Zone badge (spec "Zones" > Display): a square with rounded corners, same
 * size, colors, icon, border and multi-tag bands as pins, but without a tip,
 * to signal an area rather than a precise point. Same SVG on web and native.
 */
import { MAX_PIN_BANDS } from '../config';
import { computeBands } from '../pins/bands';
import { GREYED_OPACITY, ICON_HALO, type PinSpec } from '../pins/pinSvg';
import { GREYED_COLOR, UNTAGGED_COLOR } from '../theme/tags';

/** ViewBox 36x36: square 32x32 at (2,2), radius 8. Anchor: the centre. */
export const BADGE_VIEWBOX = { width: 36, height: 36 } as const;
const BOX = { x: 2, y: 2, size: 32, r: 8 };
const CLIP_ID = 'tl-badge-clip';

function esc(s: string): string {
  return s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);
}

export function badgeSvg(spec: PinSpec, size: { width: number; height: number } = BADGE_VIEWBOX): string {
  const bands = computeBands(spec.greyed ? [GREYED_COLOR] : spec.colors, {
    top: BOX.y,
    bottom: BOX.y + BOX.size,
    max: MAX_PIN_BANDS,
    fallback: UNTAGGED_COLOR,
  });
  const rects = bands
    .map((b, i) => {
      const y0 = i === 0 ? 0 : b.y0;
      const y1 = i === bands.length - 1 ? BADGE_VIEWBOX.height : b.y1;
      return `<rect x="0" y="${y0}" width="${BADGE_VIEWBOX.width}" height="${y1 - y0}" fill="${esc(b.color)}"/>`;
    })
    .join('');
  const opacity = spec.greyed ? GREYED_OPACITY : spec.faded ? 0.85 : 1;
  const halo = spec.faded ? 'rgba(31,41,55,0.6)' : ICON_HALO;
  const icon = esc(spec.iconPath);
  const rect = `x="${BOX.x}" y="${BOX.y}" width="${BOX.size}" height="${BOX.size}" rx="${BOX.r}"`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" ` +
    `viewBox="0 0 ${BADGE_VIEWBOX.width} ${BADGE_VIEWBOX.height}">` +
    `<defs><clipPath id="${CLIP_ID}"><rect ${rect}/></clipPath></defs>` +
    `<g opacity="${opacity}">` +
    `<g clip-path="url(#${CLIP_ID})"><rect width="36" height="36" fill="#FFFFFF"/>` +
    `<g opacity="${spec.faded ? 0.5 : 1}">${rects}</g></g>` +
    `<rect ${rect} fill="none" stroke="#FFFFFF" stroke-width="2.5"/>` +
    `<rect x="0.75" y="0.75" width="34.5" height="34.5" rx="9.2" fill="none" stroke="rgba(15,23,42,0.35)" stroke-width="1"/>` +
    `<g transform="translate(9 9) scale(0.75)">` +
    `<path d="${icon}" fill="none" stroke="${halo}" stroke-width="4" stroke-linejoin="round"/>` +
    `<path d="${icon}" fill="#FFFFFF"/>` +
    `</g></g></svg>`
  );
}
