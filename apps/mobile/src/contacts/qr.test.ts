import { describe, expect, it } from 'vitest';

import { qrMatrix, qrPath } from './qr';

describe('QR codes', () => {
  it('an invitation link of 200 characters stays at version 10 or lower (level M)', () => {
    const link = 'https://example.org/i#' + 'A'.repeat(178);
    expect(link).toHaveLength(200);
    const m = qrMatrix(link, 'M');
    expect(m.version).toBeLessThanOrEqual(10);
    expect(m.size).toBe(17 + 4 * m.version);
  });

  it('a return link of about 600 characters still fits (level L)', () => {
    const m = qrMatrix('https://example.org/r#' + 'B'.repeat(600), 'L');
    expect(m.version).toBeLessThanOrEqual(20);
  });

  it('draws the finder patterns at the corners', () => {
    const m = qrMatrix('tlsafe1:abc');
    for (const [r, c] of [[0, 0], [0, m.size - 1], [m.size - 1, 0]] as const) expect(m.dark(r, c)).toBe(true);
    const d = qrPath(m);
    expect(d.startsWith('M4 4h7v1h-7z')).toBe(true); // first row of the top-left finder, 7 modules
  });
});
