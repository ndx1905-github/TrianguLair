import { describe, expect, it } from 'vitest';

import type { PlaceFacts } from '../places/model';
import { buildPin, pinClusterColor, pinLabel } from './build';
import { DOT_PX, dotLayout, MAX_PIN_DOTS, pinDots } from './dots';
import { PIN_VIEWBOX, pinLayout, pinSvg } from './pinSvg';

const colors: Record<string, string> = { lea: '#EF4444', ben: '#3B82F6', sam: '#16A34A', zoe: '#D97706', max: '#8B5CF6' };
const colorOf = (id: string) => colors[id] ?? '#000000';

describe('friends\' dots on pins', () => {
  it('one dot per friend shown, at most three, then "+n"', () => {
    expect(pinDots(undefined, colorOf)).toBeNull();
    expect(pinDots([], colorOf)).toBeNull();
    expect(pinDots(['lea'], colorOf)).toEqual({ colors: ['#EF4444'], more: 0 });
    expect(pinDots(['lea', 'ben', 'sam'], colorOf)).toEqual({ colors: ['#EF4444', '#3B82F6', '#16A34A'], more: 0 });
    expect(pinDots(['lea', 'ben', 'sam', 'zoe', 'max'], colorOf)).toEqual({ colors: ['#EF4444', '#3B82F6', '#16A34A'], more: 2 });
    expect(MAX_PIN_DOTS).toBe(3);
  });

  it('sit along the head\'s top right, apart, each about 9 px with its outline', () => {
    const l = dotLayout({ colors: ['#EF4444', '#3B82F6', '#16A34A'], more: 0 });
    expect(l.circles).toHaveLength(3);
    for (const c of l.circles) {
      expect(c.cx).toBeGreaterThan(20); // right of the head's axis
      expect(c.cy).toBeLessThan(36); // on the head, not on the tip
      expect((c.r + l.stroke / 2) * 2).toBeCloseTo(DOT_PX, 1);
    }
    // The first one at the top right, the next ones going down the right side, never overlapping.
    expect(l.circles[0]!.cy).toBeLessThan(l.circles[1]!.cy);
    for (let i = 1; i < l.circles.length; i++) {
      const a = l.circles[i - 1]!;
      const b = l.circles[i]!;
      expect(Math.hypot(a.cx - b.cx, a.cy - b.cy)).toBeGreaterThanOrEqual(DOT_PX);
    }
    expect(l.more).toBeNull();
  });

  it('keep their size in pixels on the smaller greyed pins, and leave room for "maybe closed"', () => {
    const one = { colors: ['#EF4444'], more: 0 };
    const small = dotLayout(one, { scale: 0.72 });
    // Drawn at 0.72: the same pixel size as at scale 1.
    expect((small.circles[0]!.r + small.stroke / 2) * 2 * 0.72).toBeCloseTo(DOT_PX, 1);
    const closed = dotLayout(one, { maybeClosed: true });
    const badge = { cx: 33, cy: 6, r: 6.3 };
    const c = closed.circles[0]!;
    expect(Math.hypot(c.cx - badge.cx, c.cy - badge.cy)).toBeGreaterThan(badge.r + c.r);
  });

  it('"+n" after three dots; the canvas grows to hold what sticks out', () => {
    const l = dotLayout({ colors: ['#EF4444', '#3B82F6', '#16A34A'], more: 4 });
    expect(l.more?.text).toBe('+4');
    expect(l.padRight).toBeGreaterThan(0);
    const layout = pinLayout({ dots: { colors: ['#EF4444', '#3B82F6', '#16A34A'], more: 4 } }, 1);
    expect(layout.width).toBe(PIN_VIEWBOX.width + l.padRight);
    // The tip stays on the coordinate: offset from the bottom centre of the larger canvas.
    expect(layout.offset[0]).toBeCloseTo(layout.width / 2 - 20);
    expect(layout.offset[1]).toBeCloseTo(layout.height - (49 + l.padTop));
    // No dots: the pin's own box, the tip 3 units above its bottom.
    expect(pinLayout({}, 1)).toMatchObject({ width: 40, height: 52, offset: [0, 3] });
    expect(pinLayout({}, 1.3).offset[1]).toBeCloseTo(3.9);
  });

  it('are drawn in the SVG with a white outline, escaped', () => {
    const svg = pinSvg({ colors: ['#EF4444'], iconPath: 'M0 0Z', faded: false, dots: { colors: ['#3B82F6', '"><x'], more: 2 } });
    expect(svg).toContain('class="tl-dots"');
    expect(svg).toContain('fill="#3B82F6" stroke="#FFFFFF"');
    expect(svg).toContain('>+2</text>');
    expect(svg).not.toContain('"><x');
    expect(pinSvg({ colors: ['#EF4444'], iconPath: 'M0 0Z', faded: false })).not.toContain('tl-dots');
  });
});

function facts(p: Partial<PlaceFacts>): PlaceFacts {
  return { id: 'p', name: 'Le Perchoir', lat: 48.86, lon: 2.38, category: null, mine: false, friends: true, tagIds: [], info: null, status: 'open', ...p };
}

describe('pins of friends\' places', () => {
  it('carry the dots of the friends shown, mine included; clusters keep the tag colour', () => {
    const pin = buildPin({ facts: facts({ friendIds: ['ben', 'lea'] }), match: 'match' }, { tagIds: [], criteria: [] }, [], new Map(), false, colorOf);
    expect(pin.dots).toEqual({ colors: ['#3B82F6', '#EF4444'], more: 0 });
    expect(pinClusterColor(pin)).toBe(pin.colors[0]);
    const mine = buildPin({ facts: facts({ mine: true, friendIds: ['lea'] }), match: 'match' }, { tagIds: [], criteria: [] }, [], new Map(), false, colorOf);
    expect(mine.dots?.colors).toEqual(['#EF4444']);
    expect(mine.faded).toBe(false);
    // Only mine: no dot; without colours (other callers): none either.
    expect(buildPin({ facts: facts({ mine: true }), match: 'match' }, { tagIds: [], criteria: [] }, [], new Map(), false, colorOf).dots).toBeUndefined();
    expect(buildPin({ facts: facts({ friendIds: ['lea'] }), match: 'match' }, { tagIds: [], criteria: [] }, [], new Map(), false).dots).toBeUndefined();
  });

  it('say whose maps they are on', () => {
    const names = (id: string) => ({ lea: 'Léa', ben: 'Ben' })[id] ?? id;
    const onMaps = (n: string[]) => `on the maps of ${n.join(' and ')}`;
    expect(pinLabel(facts({ friendIds: ['ben', 'lea'] }), names, onMaps)).toBe('Le Perchoir, on the maps of Ben and Léa');
    expect(pinLabel(facts({}), names, onMaps)).toBe('Le Perchoir');
  });
});
