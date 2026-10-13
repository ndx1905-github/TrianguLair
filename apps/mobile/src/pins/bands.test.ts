import { describe, expect, it } from 'vitest';

import { computeBands, uniqueColors } from './bands';
import { pinSvg } from './pinSvg';

const opts = { top: 3, bottom: 35, max: 3, fallback: '#999999' };

describe('computeBands', () => {
  it('single color fills the whole body', () => {
    expect(computeBands(['#f00'], opts)).toEqual([{ color: '#f00', y0: 3, y1: 35 }]);
  });

  it('two colors split the body in equal halves, in order', () => {
    expect(computeBands(['#f00', '#0f0'], opts)).toEqual([
      { color: '#f00', y0: 3, y1: 19 },
      { color: '#0f0', y0: 19, y1: 35 },
    ]);
  });

  it('three colors: contiguous, equal, centered on the body', () => {
    const b = computeBands(['#a', '#b', '#c'], opts);
    expect(b).toHaveLength(3);
    expect(b[0]!.y0).toBe(3);
    expect(b[2]!.y1).toBe(35);
    expect(b[0]!.y1).toBeCloseTo(b[1]!.y0);
    expect(b[1]!.y1).toBeCloseTo(b[2]!.y0);
    for (const band of b) expect(band.y1 - band.y0).toBeCloseTo(32 / 3);
    // Middle band is centered on the body center.
    expect((b[1]!.y0 + b[1]!.y1) / 2).toBeCloseTo(19);
  });

  it('caps at max bands, keeping the first tags', () => {
    const b = computeBands(['#1', '#2', '#3', '#4'], opts);
    expect(b.map((x) => x.color)).toEqual(['#1', '#2', '#3']);
  });

  it('dedupes identical colors (case-insensitive)', () => {
    expect(uniqueColors(['#AAA', '#aaa', '#bbb'])).toEqual(['#AAA', '#bbb']);
    expect(computeBands(['#AAA', '#aaa'], opts)).toHaveLength(1);
  });

  it('uses the fallback color when there is none', () => {
    expect(computeBands([], opts)).toEqual([{ color: '#999999', y0: 3, y1: 35 }]);
  });

  it('rejects an empty body', () => {
    expect(() => computeBands(['#f00'], { ...opts, bottom: 3 })).toThrow();
  });
});

describe('pinSvg', () => {
  it('draws one rect per band and a white icon', () => {
    const svg = pinSvg({ colors: ['#EF4444', '#3B82F6'], iconPath: 'M0 0H24V24Z', faded: false });
    expect(svg.match(/fill="#EF4444"/g)).toHaveLength(1);
    expect(svg.match(/fill="#3B82F6"/g)).toHaveLength(1);
    expect(svg).toContain('<path d="M0 0H24V24Z" fill="#FFFFFF"/>');
  });

  it('faded pins are translucent', () => {
    const normal = pinSvg({ colors: ['#EF4444'], iconPath: 'M0 0Z', faded: false });
    const faded = pinSvg({ colors: ['#EF4444'], iconPath: 'M0 0Z', faded: true });
    expect(normal).toContain('<g opacity="1">');
    expect(faded).toContain('<g opacity="0.5">');
  });
});
