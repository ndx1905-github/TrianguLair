import { beforeEach, describe, expect, it } from 'vitest';

import {
  BaseMapFallback,
  TILE_FAILURES_BEFORE_FALLBACK,
  baseMapFor,
  baseMapNoteKey,
  baseMapStatus,
  blankStyle,
  resetBaseMapSession,
  styleChain,
  subscribeBaseMapStatus,
} from './baseMap';

const PRIMARY = 'https://tiles.openfreemap.org/styles/positron';
const MIRROR = 'https://tiles.example.org/styles/positron';
const spec = baseMapFor(false, { primary: PRIMARY, fallbacks: [MIRROR] });
const tile = { sourceId: 'openmaptiles', tile: {} };

beforeEach(() => resetBaseMapSession());

describe('base map fallback (spec "Error cases", map tiles unavailable)', () => {
  it('tries the configured address, each fallback, then a built-in blank style', () => {
    expect(styleChain(spec)).toEqual([PRIMARY, MIRROR, blankStyle(false)]);
    expect(baseMapFor(true, { primary: PRIMARY, fallbacks: [' ', PRIMARY, MIRROR] }).urls).toEqual([PRIMARY, MIRROR]);
    expect(blankStyle(true).layers[0]!.paint['background-color']).not.toBe(blankStyle(false).layers[0]!.paint['background-color']);
  });

  it('the default list: the configured style, nothing hardcoded beyond the config module', () => {
    const light = baseMapFor(false);
    expect(light.urls[0]).toBe('https://tiles.openfreemap.org/styles/positron');
    expect(baseMapFor(true).urls[0]).toBe('https://tiles.openfreemap.org/styles/dark');
  });

  it('a style that cannot be loaded switches to the next address, down to the blank style', () => {
    const fb = new BaseMapFallback(spec);
    expect(fb.current()).toBe(PRIMARY);
    expect(fb.status()).toBe('primary');
    expect(fb.error({})).toBe(true);
    expect(fb.current()).toBe(MIRROR);
    expect(fb.status()).toBe('fallback');
    expect(fb.styleError()).toBe(true);
    expect(fb.current()).toEqual(blankStyle(false));
    expect(fb.status()).toBe('unavailable');
    // Nothing after the blank style.
    expect(fb.styleError()).toBe(false);
  });

  it('as long as tiles load (from the network or the cache), a few failed tiles do not switch', () => {
    const fb = new BaseMapFallback(spec);
    fb.styleLoad();
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < TILE_FAILURES_BEFORE_FALLBACK - 1; i++) expect(fb.error(tile)).toBe(false);
      fb.tileLoad();
    }
    expect(fb.current()).toBe(PRIMARY);
  });

  it('a run of failed tiles with none loaded switches; a failed TileJSON switches at once', () => {
    const fb = new BaseMapFallback(spec);
    fb.styleLoad();
    for (let i = 1; i < TILE_FAILURES_BEFORE_FALLBACK; i++) expect(fb.error(tile)).toBe(false);
    expect(fb.error(tile)).toBe(true);
    expect(fb.current()).toBe(MIRROR);
    fb.styleLoad();
    expect(fb.error({ sourceId: 'openmaptiles' })).toBe(true);
    expect(fb.status()).toBe('unavailable');
  });

  it('ignores the app\'s own sources, sprite or glyph errors after the style loaded, and late errors of the previous style', () => {
    const fb = new BaseMapFallback(spec);
    // Before the style loaded: a source error belongs to the previous style.
    expect(fb.error({ sourceId: 'openmaptiles' })).toBe(false);
    fb.styleLoad();
    expect(fb.error({})).toBe(false);
    for (let i = 0; i < 10; i++) expect(fb.error({ sourceId: 'tl-shapes', tile: {} }, ['tl-shapes'])).toBe(false);
    expect(fb.current()).toBe(PRIMARY);
  });

  it('the address reached is remembered for the session: the next map starts from it', () => {
    const first = new BaseMapFallback(spec);
    first.styleError();
    const next = new BaseMapFallback(spec);
    expect(next.current()).toBe(MIRROR);
    // The other theme has its own list.
    expect(new BaseMapFallback(baseMapFor(true, { primary: PRIMARY, fallbacks: [MIRROR] })).current()).toBe(PRIMARY);
  });

  it('the note: nothing on the configured address, "Map possibly less detailed" on a fallback, unavailable after the last one', () => {
    const seen: string[] = [];
    const off = subscribeBaseMapStatus((s) => seen.push(s));
    const fb = new BaseMapFallback(spec);
    expect(baseMapNoteKey(baseMapStatus())).toBeNull();
    fb.styleError();
    expect(baseMapNoteKey(baseMapStatus())).toBe('map.tiles.fallback');
    fb.styleError();
    expect(baseMapNoteKey(baseMapStatus())).toBe('map.tiles.unavailable');
    off();
    expect(seen).toEqual(['fallback', 'unavailable']);
  });

  it('without any fallback address, a failure goes straight to the blank style', () => {
    const fb = new BaseMapFallback(baseMapFor(false, { primary: PRIMARY, fallbacks: [] }));
    expect(fb.styleError()).toBe(true);
    expect(fb.status()).toBe('unavailable');
  });
});
