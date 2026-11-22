import { afterEach, describe, expect, it, vi } from 'vitest';

import { locate, toFix, within, zoomForFix, type LocationBackend, type RawFix } from './locate';

const PARIS: RawFix = { latitude: 48.85837, longitude: 2.29448, accuracy: 12, ageMs: 500 };
const OPTS = { freshMs: 120_000, timeoutMs: 1_000, staleMs: 86_400_000 };

/** A backend with a last known position per max age, and a scripted fresh fix. */
function fake(over: Partial<LocationBackend> = {}): LocationBackend & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    requestPermission: async () => {
      calls.push('permission');
      return 'granted';
    },
    servicesEnabled: async () => {
      calls.push('enabled');
      return true;
    },
    lastKnown: async (maxAgeMs) => {
      calls.push(`last:${maxAgeMs}`);
      return null;
    },
    current: async (timeoutMs) => {
      calls.push(`current:${timeoutMs}`);
      return PARIS;
    },
    ...over,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('toFix', () => {
  it('keeps a valid position', () => {
    expect(toFix(PARIS)).toEqual({ lat: 48.85837, lon: 2.29448, accuracyM: 12, ageMs: 500 });
  });

  it('accepts missing accuracy and age', () => {
    expect(toFix({ latitude: -33.86, longitude: 151.21, accuracy: null })).toEqual({ lat: -33.86, lon: 151.21, accuracyM: null, ageMs: null });
  });

  it('rejects what is not a position', () => {
    expect(toFix(null)).toBeNull();
    expect(toFix(undefined)).toBeNull();
    expect(toFix({})).toBeNull();
    expect(toFix({ latitude: '48.8', longitude: 2.3 })).toBeNull();
    expect(toFix({ latitude: Number.NaN, longitude: 2.3 })).toBeNull();
    expect(toFix({ latitude: 91, longitude: 2.3 })).toBeNull();
    expect(toFix({ latitude: 48.8, longitude: -180.5 })).toBeNull();
  });

  it('drops a negative accuracy or age', () => {
    expect(toFix({ latitude: 1, longitude: 2, accuracy: -1, ageMs: -5 })).toEqual({ lat: 1, lon: 2, accuracyM: null, ageMs: null });
  });
});

describe('locate', () => {
  it('uses a recent last known position without waiting for a fix', async () => {
    const b = fake({ lastKnown: async (ms) => (ms === OPTS.freshMs ? PARIS : null) });
    const r = await locate(b, OPTS);
    expect(r).toEqual({ ok: true, fix: toFix(PARIS), stale: false });
    expect(b.calls).toEqual(['permission']);
  });

  it('asks for a fresh fix when nothing recent is known', async () => {
    const b = fake();
    const r = await locate(b, OPTS);
    expect(r).toMatchObject({ ok: true, stale: false, fix: { lat: 48.85837, lon: 2.29448 } });
    expect(b.calls).toEqual(['permission', `last:${OPTS.freshMs}`, 'enabled', `current:${OPTS.timeoutMs}`]);
  });

  it('falls back to an older last known position when no fix comes', async () => {
    const old = { ...PARIS, ageMs: 3_600_000 };
    const b = fake({ current: async () => null, lastKnown: async (ms) => (ms === OPTS.staleMs ? old : null) });
    expect(await locate(b, OPTS)).toEqual({ ok: true, fix: toFix(old), stale: true });
  });

  it('reports a refused permission, and asks nothing else', async () => {
    const b = fake({ requestPermission: async () => 'denied' });
    expect(await locate(b, OPTS)).toEqual({ ok: false, reason: 'denied' });
    expect(b.calls).toEqual([]);
  });

  it('reports location turned off', async () => {
    const b = fake({ servicesEnabled: async () => false });
    expect(await locate(b, OPTS)).toEqual({ ok: false, reason: 'disabled' });
    expect(b.calls).not.toContain(`current:${OPTS.timeoutMs}`);
  });

  it('reports no position at all', async () => {
    const b = fake({ current: async () => null });
    expect(await locate(b, OPTS)).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('is unavailable when the platform has no location support', async () => {
    const b = fake({
      requestPermission: () => Promise.reject(new Error('The TlLocation native module is not in this build')),
    });
    expect(await locate(b, OPTS)).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('survives a backend that throws or returns garbage', async () => {
    const b = fake({
      lastKnown: () => Promise.reject(new Error('SecurityException')),
      servicesEnabled: () => Promise.reject(new Error('no manager')),
      current: async () => ({ latitude: 'x', longitude: 2 }),
    });
    expect(await locate(b, OPTS)).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('gives up on a fresh fix that never comes (e.g. a hanging platform call)', async () => {
    vi.useFakeTimers();
    const b = fake({ current: () => new Promise<RawFix | null>(() => {}) });
    const p = locate(b, OPTS);
    await vi.advanceTimersByTimeAsync(OPTS.timeoutMs + 10_000);
    expect(await p).toEqual({ ok: false, reason: 'unavailable' });
  });
});

describe('within', () => {
  it('returns the value, or the fallback on error, synchronous throw or timeout', async () => {
    expect(await within(async () => 1, 100, 0)).toBe(1);
    expect(await within(() => Promise.reject(new Error('x')), 100, 0)).toBe(0);
    expect(
      await within(
        () => {
          throw new Error('sync');
        },
        100,
        0,
      ),
    ).toBe(0);
    vi.useFakeTimers();
    const p = within(() => new Promise<number>(() => {}), 100, -1);
    await vi.advanceTimersByTimeAsync(150);
    expect(await p).toBe(-1);
  });
});

describe('zoomForFix', () => {
  it('zooms to the street, wider for a coarse fix, and never zooms out', () => {
    expect(zoomForFix({ lat: 0, lon: 0, accuracyM: 15, ageMs: 0 }, 5)).toBe(16);
    expect(zoomForFix({ lat: 0, lon: 0, accuracyM: null, ageMs: 0 }, null)).toBe(16);
    expect(zoomForFix({ lat: 0, lon: 0, accuracyM: 3000, ageMs: 0 }, 5)).toBe(13);
    expect(zoomForFix({ lat: 0, lon: 0, accuracyM: 15, ageMs: 0 }, 18)).toBe(18);
  });
});
