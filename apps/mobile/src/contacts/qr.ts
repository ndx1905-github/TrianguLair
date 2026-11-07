/**
 * QR codes for invitation links, return links and safety codes: `qrcode-generator` (MIT, pure
 * JavaScript, no native code), drawn as one SVG path (QrCode.tsx), black on white with the
 * 4-module quiet zone that scanners need, also in dark mode.
 */
import qrcode from 'qrcode-generator';

export interface QrMatrix {
  /** Modules per side. */
  size: number;
  /** QR version (1–40): 21 modules for version 1, 4 more per version. */
  version: number;
  dark(row: number, col: number): boolean;
}

export type Ecc = 'L' | 'M' | 'Q' | 'H';

export function qrMatrix(text: string, ecc: Ecc = 'M'): QrMatrix {
  const q = qrcode(0, ecc);
  q.addData(text, 'Byte');
  q.make();
  const size = q.getModuleCount();
  return { size, version: (size - 17) / 4, dark: (r, c) => q.isDark(r, c) };
}

/** SVG path of the dark modules (one `h1v1h-1z` per run, merged horizontally), offset by the quiet zone. */
export function qrPath(m: QrMatrix, quiet = 4): string {
  const parts: string[] = [];
  for (let r = 0; r < m.size; r++) {
    let c = 0;
    while (c < m.size) {
      if (!m.dark(r, c)) {
        c++;
        continue;
      }
      let end = c + 1;
      while (end < m.size && m.dark(r, end)) end++;
      parts.push(`M${c + quiet} ${r + quiet}h${end - c}v1h-${end - c}z`);
      c = end;
    }
  }
  return parts.join('');
}
