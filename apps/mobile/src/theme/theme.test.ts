import { describe, expect, it } from 'vitest';

import { computeLayout, sizeClassOf } from './layout';
import { PALETTE, TAGS, TAG_IDS } from './tags';
import { nextThemeMode, resolveDark } from './themeMode';

describe('theme mode', () => {
  it('auto follows the system scheme', () => {
    expect(resolveDark('auto', 'dark')).toBe(true);
    expect(resolveDark('auto', 'light')).toBe(false);
    expect(resolveDark('auto', null)).toBe(false);
  });

  it('manual choice overrides the system', () => {
    expect(resolveDark('light', 'dark')).toBe(false);
    expect(resolveDark('dark', 'light')).toBe(true);
  });

  it('cycles auto -> light -> dark -> auto', () => {
    expect(nextThemeMode('auto')).toBe('light');
    expect(nextThemeMode('light')).toBe('dark');
    expect(nextThemeMode('dark')).toBe('auto');
  });
});

describe('layout', () => {
  it('size classes follow Material breakpoints', () => {
    expect(sizeClassOf(320)).toBe('compact');
    expect(sizeClassOf(599)).toBe('compact');
    expect(sizeClassOf(600)).toBe('medium');
    expect(sizeClassOf(840)).toBe('expanded');
  });

  it('phones (incl. iPhone SE and Display Zoom) use a full-width bottom sheet', () => {
    for (const [w, h] of [
      [320, 568],
      [375, 667],
      [430, 932],
    ] as const) {
      const l = computeLayout(w, h);
      expect(l.wide).toBe(false);
      expect(l.sheetWidth).toBe(w);
    }
  });

  it('tablets and unfolded foldables use a side panel', () => {
    // iPad portrait, iPad landscape, Galaxy Z Fold unfolded, Pixel Fold unfolded.
    for (const [w, h] of [
      [768, 1024],
      [1180, 820],
      [884, 1104],
      [841, 701],
    ] as const) {
      const l = computeLayout(w, h);
      expect(l.wide).toBe(true);
      expect(l.sheetWidth).toBeLessThan(w / 2);
      // Filter panel and side panel never overlap.
      expect(l.filterMaxWidth + l.sheetWidth + l.gutter * 2).toBeLessThanOrEqual(w);
    }
  });

  it('a tall medium-width window keeps the bottom sheet', () => {
    expect(computeLayout(620, 1200).wide).toBe(false);
  });

  it('gutter stays within bounds', () => {
    expect(computeLayout(280, 600).gutter).toBe(10);
    expect(computeLayout(2000, 1200).gutter).toBe(24);
  });
});

describe('tag palette', () => {
  it('about ten distinct tag colors, all from the spec palette', () => {
    const colors = TAG_IDS.map((t) => TAGS[t].color);
    expect(colors.length).toBeGreaterThanOrEqual(8);
    expect(new Set(colors).size).toBe(colors.length);
    const palette = new Set<string>(Object.values(PALETTE));
    for (const c of colors) expect(palette.has(c)).toBe(true);
  });
});
