import { describe, expect, it } from 'vitest';

import { PWA_ENABLED, pwaState } from './pwa';

describe('native PWA stub', () => {
  it('returns the same snapshot every time (useSyncExternalStore would loop forever otherwise)', () => {
    expect(PWA_ENABLED).toBe(false);
    expect(pwaState()).toBe(pwaState());
    expect(pwaState()).toEqual({ registered: false, updateReady: false });
  });
});
