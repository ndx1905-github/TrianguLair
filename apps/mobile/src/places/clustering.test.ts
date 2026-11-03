import { describe, expect, it } from 'vitest';

import { clusterPins, expansionZoom, majorityColor } from './clustering';
import { clusterBubbleSize, clusterColors } from '../components/map/cluster';

const pt = (id: string, lat: number, lon: number, color: string | null = '#EF4444') => ({ id, lat, lon, color });
const PARIS = [pt('a', 48.8600, 2.3500), pt('b', 48.8601, 2.3502, '#3B82F6'), pt('c', 48.8602, 2.3501, '#3B82F6'), pt('far', 48.9, 2.45)];

describe('clusterPins', () => {
  it('groups close pins when zoomed out, keeps far ones single', () => {
    const r = clusterPins(PARIS, { zoom: 12 });
    expect(r.clusters).toHaveLength(1);
    expect(r.clusters[0]!.count).toBe(3);
    expect(r.clusters[0]!.memberIds.sort()).toEqual(['a', 'b', 'c']);
    expect(r.singles.map((s) => s.id)).toEqual(['far']);
  });

  it('every pin ends up exactly once', () => {
    const many = Array.from({ length: 300 }, (_, i) => pt(`p${i}`, 48.8 + ((i * 7919) % 100) / 1000, 2.3 + ((i * 104729) % 100) / 1000));
    for (const zoom of [8, 11, 13, 14.9]) {
      const r = clusterPins(many, { zoom });
      const ids = [...r.singles.map((s) => s.id), ...r.clusters.flatMap((c) => c.memberIds)];
      expect(ids.length).toBe(many.length);
      expect(new Set(ids).size).toBe(many.length);
    }
  });

  it('no clustering at street level', () => {
    expect(clusterPins(PARIS, { zoom: 15 }).clusters).toHaveLength(0);
  });

  it('cluster color: majority of matching members; grey (null) when none matches', () => {
    expect(clusterPins(PARIS, { zoom: 12 }).clusters[0]!.color).toBe('#3B82F6');
    const greyed = PARIS.map((p) => ({ ...p, color: null }));
    expect(clusterPins(greyed, { zoom: 12 }).clusters[0]!.color).toBeNull();
    expect(majorityColor(['#A', null, '#B', '#B'])).toBe('#B');
    expect(majorityColor(['#A', '#B'])).toBe('#A');
  });

  it('is stable whatever the input order', () => {
    const a = clusterPins(PARIS, { zoom: 12 });
    const b = clusterPins([...PARIS].reverse(), { zoom: 12 });
    expect(b.clusters.map((c) => c.id)).toEqual(a.clusters.map((c) => c.id));
  });

  it('tapping a cluster zooms in by at least two levels', () => {
    const c = clusterPins(PARIS, { zoom: 12 }).clusters[0]!;
    const z = expansionZoom(c, 12, { width: 390, height: 844 });
    expect(z).toBeGreaterThanOrEqual(14);
    expect(z).toBeLessThanOrEqual(18);
  });
});

describe('cluster bubble', () => {
  it('grows with the count within bounds; dark text on yellow', () => {
    expect(clusterBubbleSize(2)).toBeGreaterThanOrEqual(36);
    expect(clusterBubbleSize(10_000)).toBeLessThanOrEqual(56);
    expect(clusterColors('#FACC15').text).toBe('#1F2937');
    expect(clusterColors('#EF4444').text).toBe('#FFFFFF');
    expect(clusterColors(null).fill).toBe('#9CA3AF');
  });
});
