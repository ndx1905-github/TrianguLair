/** Cluster bubble appearance, shared by the web and native maps. Pure. */
import { GREYED_COLOR } from '../../theme/tags';

/** Diameter in points: grows slowly with the count, touch target >= 36. */
export function clusterBubbleSize(count: number): number {
  return Math.round(Math.min(56, 34 + Math.log10(Math.max(2, count)) * 14));
}

function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0;
  const n = parseInt(m[1]!, 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

/** Fill = majority tag color (grey when none matches); dark text on light fills (yellow). */
export function clusterColors(color: string | null): { fill: string; text: string } {
  const fill = color ?? GREYED_COLOR;
  return { fill, text: luminance(fill) > 0.5 ? '#1F2937' : '#FFFFFF' };
}
