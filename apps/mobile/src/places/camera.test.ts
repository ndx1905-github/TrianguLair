import { describe, expect, it } from 'vitest';

import { fitCamera } from './camera';
import { MOCK_PLACES } from './mockPlaces';

const fallback = { center: { lat: 1, lon: 2 }, zoom: 3 };

describe('fitCamera', () => {
  it('returns the fallback without places', () => {
    expect(fitCamera([], { width: 400, height: 400, maxZoom: 15, fallback })).toBe(fallback);
  });

  it('caps the zoom for a single place', () => {
    const cam = fitCamera([{ lat: 48.85, lon: 2.35 }], { width: 400, height: 400, maxZoom: 15, fallback });
    expect(cam.zoom).toBe(15);
    expect(cam.center.lat).toBeCloseTo(48.85, 6);
    expect(cam.center.lon).toBeCloseTo(2.35, 6);
  });

  it('a narrower area gives a lower zoom, centered on the places', () => {
    const phone = fitCamera(MOCK_PLACES, { width: 340, height: 440, maxZoom: 15, fallback });
    const tablet = fitCamera(MOCK_PLACES, { width: 700, height: 420, maxZoom: 15, fallback });
    expect(phone.zoom).toBeLessThan(tablet.zoom);
    expect(phone.zoom).toBeGreaterThan(10);
    expect(phone.center.lat).toBeGreaterThan(48.84);
    expect(phone.center.lat).toBeLessThan(48.9);
  });

  it('all places fit in the requested area', () => {
    const w = 340;
    const h = 440;
    const cam = fitCamera(MOCK_PLACES, { width: w, height: h, maxZoom: 15, fallback });
    const scale = 512 * 2 ** cam.zoom;
    const lonSpan = Math.max(...MOCK_PLACES.map((p) => p.lon)) - Math.min(...MOCK_PLACES.map((p) => p.lon));
    expect((lonSpan / 360) * scale).toBeLessThanOrEqual(w + 1);
  });
});
