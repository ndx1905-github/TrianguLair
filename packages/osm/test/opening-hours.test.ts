import { describe, expect, it } from 'vitest';
import {
  describeHappyHour,
  describeOpening,
  formatClock,
  happyHourStatus,
  isOpenAt,
  isPermanentlyOff,
  openIntervals,
  openingStatus,
  stripHolidayRules,
} from '../src/opening-hours.ts';

// Local times (TZ is pinned to Europe/Paris in vitest.config.ts).
// 2026-10-26 is a Monday; 2026-12-25 is a Friday (Christmas, a public holiday in France).
const at = (d: string, hm: string) => {
  const [y, mo, da] = d.split('-').map(Number) as [number, number, number];
  const [h, mi] = hm.split(':').map(Number) as [number, number];
  return new Date(y, mo - 1, da, h, mi);
};
const PARIS = { lat: 48.8566, lon: 2.3522, countryCode: 'FR' };

describe('openingStatus', () => {
  const resto = 'Tu-Su 12:00-14:30,19:00-22:30; PH off';

  it('open, with the closing time', () => {
    const s = openingStatus(resto, at('2026-10-27', '13:00'), PARIS);
    expect(s).toEqual({ state: 'open', closesAt: at('2026-10-27', '14:30') });
    expect(describeOpening(s, at('2026-10-27', '13:00'))).toBe('Open, closes at 2:30 pm');
  });

  it('closed, with the next opening (next day)', () => {
    const s = openingStatus(resto, at('2026-10-26', '13:00'), PARIS);
    expect(s).toEqual({ state: 'closed', opensAt: at('2026-10-27', '12:00') });
    expect(describeOpening(s, at('2026-10-26', '13:00'))).toBe('Closed, opens tomorrow at noon');
  });

  it('handles public holidays when the country is known', () => {
    expect(openingStatus(resto, at('2026-12-25', '13:00'), PARIS).state).toBe('closed');
    expect(openingStatus(resto, at('2026-12-24', '13:00'), PARIS).state).toBe('open');
  });

  it('without a country, ignores holiday rules and says so', () => {
    const s = openingStatus(resto, at('2026-12-25', '13:00'), {});
    expect(s).toMatchObject({ state: 'open', holidaysIgnored: true });
  });

  it('wraps past midnight', () => {
    const bar = 'Mo-Sa 17:00-02:00';
    const s = openingStatus(bar, at('2026-10-27', '01:00'));
    expect(s).toEqual({ state: 'open', closesAt: at('2026-10-27', '02:00') });
    expect(describeOpening(openingStatus(bar, at('2026-10-26', '23:00')), at('2026-10-26', '23:00'))).toBe(
      'Open, closes tomorrow at 2 am',
    );
  });

  it('24/7 has no closing time', () => {
    const s = openingStatus('24/7', at('2026-10-26', '03:00'));
    expect(s).toEqual({ state: 'open' });
    expect(describeOpening(s)).toBe('Open 24/7');
  });

  it('off: closed, never opens', () => {
    expect(openingStatus('off', at('2026-10-26', '12:00'))).toEqual({ state: 'closed' });
    expect(isPermanentlyOff('off')).toBe(true);
    expect(isPermanentlyOff('closed "until further notice"')).toBe(true);
    expect(isPermanentlyOff('Mo off')).toBe(false);
  });

  it('opens on another weekday', () => {
    const s = openingStatus('Tu-Sa 10:30-19:30', at('2026-10-25', '12:00'));
    expect(describeOpening(s, at('2026-10-25', '12:00'))).toBe('Closed, opens Tuesday at 10:30 am');
  });

  it('unknown ranges and comments', () => {
    const s = openingStatus('Mo-Fr 10:00+', at('2026-10-26', '12:00'));
    expect(s).toMatchObject({ state: 'unknown', reason: 'unknown' });
    // A comment alone makes the state unknown; "open" + comment is open.
    const c = openingStatus('Mo-Fr 10:00-18:00 "call first"', at('2026-10-26', '12:00'));
    expect(c).toMatchObject({ state: 'unknown', reason: 'unknown', comment: 'call first' });
    const o = openingStatus('Mo-Fr 10:00-18:00 open "call first"', at('2026-10-26', '12:00'));
    expect(o).toMatchObject({ state: 'open', comment: 'call first' });
  });

  it('falls back on unparseable or missing values without throwing', () => {
    expect(openingStatus('ouvert tous les jours sauf lundi', at('2026-10-26', '12:00'))).toEqual({
      state: 'unknown',
      reason: 'unparseable',
      raw: 'ouvert tous les jours sauf lundi',
    });
    expect(openingStatus(undefined)).toEqual({ state: 'unknown', reason: 'missing' });
    expect(openingStatus('  ')).toEqual({ state: 'unknown', reason: 'missing' });
    expect(describeOpening({ state: 'unknown', reason: 'unparseable' })).toBeNull();
  });

  it('sunset needs coordinates and works with them', () => {
    const v = 'Mo-Su 08:00-sunset';
    const s = openingStatus(v, at('2026-10-26', '12:00'), PARIS);
    expect(s.state).toBe('open');
    if (s.state === 'open') {
      // Sunset in Paris on 26 October is around 5:40 pm (CET).
      expect(s.closesAt!.getHours()).toBe(17);
      expect(s.closesAt!.getMinutes()).toBeGreaterThan(30);
    }
  });

  it('a country without coordinates still selects that country\'s holidays', () => {
    // 3 October is a public holiday in Germany, not in France.
    const v = 'Mo-Su 10:00-18:00; PH off';
    expect(openingStatus(v, at('2026-10-03', '12:00'), { countryCode: 'DE' }).state).toBe('closed');
    expect(openingStatus(v, at('2026-10-03', '12:00'), { countryCode: 'FR' }).state).toBe('open');
  });

  it('isOpenAt: true, false, null', () => {
    expect(isOpenAt('Mo-Fr 09:00-18:00', at('2026-10-26', '10:00'))).toBe(true);
    expect(isOpenAt('Mo-Fr 09:00-18:00', at('2026-10-26', '20:00'))).toBe(false);
    expect(isOpenAt('garbage!!', at('2026-10-26', '20:00'))).toBeNull();
    expect(isOpenAt(undefined, at('2026-10-26', '20:00'))).toBeNull();
  });

  it('openIntervals lists a day', () => {
    const iv = openIntervals('Tu-Su 12:00-14:30,19:00-22:30', at('2026-10-27', '00:00'), at('2026-10-28', '00:00'));
    expect(iv.map((i) => [i.from.getHours(), i.to.getHours()])).toEqual([
      [12, 14],
      [19, 22],
    ]);
  });
});

describe('happy hours', () => {
  const hh = 'Mo-Sa 17:00-20:00';

  it('in progress: "Happy hour until 8 pm"', () => {
    const s = happyHourStatus(hh, at('2026-10-26', '18:15'));
    expect(s).toEqual({ state: 'active', until: at('2026-10-26', '20:00') });
    expect(describeHappyHour(s, at('2026-10-26', '18:15'))).toBe('Happy hour until 8 pm');
  });

  it('not in progress', () => {
    const s = happyHourStatus(hh, at('2026-10-26', '21:00'));
    expect(s).toEqual({ state: 'inactive', startsAt: at('2026-10-27', '17:00') });
    expect(describeHappyHour(s)).toBeNull();
  });

  it('missing', () => {
    expect(happyHourStatus(undefined)).toEqual({ state: 'unknown', reason: 'missing' });
  });
});

describe('helpers', () => {
  it('stripHolidayRules', () => {
    expect(stripHolidayRules('Mo-Fr 10:00-18:00; PH off')).toBe('Mo-Fr 10:00-18:00');
    expect(stripHolidayRules('Mo-Fr,PH 10:00-12:00; SH off')).toBe('Mo-Fr 10:00-12:00');
    expect(stripHolidayRules('PH off')).toBeNull();
  });

  it('formatClock', () => {
    expect(formatClock(at('2026-10-26', '20:00'))).toBe('8 pm');
    expect(formatClock(at('2026-10-26', '08:30'))).toBe('8:30 am');
    expect(formatClock(at('2026-10-26', '00:00'))).toBe('midnight');
    expect(formatClock(at('2026-10-26', '20:00'), 'fr')).toBe('20:00');
  });
});
