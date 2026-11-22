import { describe, expect, it } from 'vitest';

import { pwaState } from './pwa';

describe('native PWA stub', () => {
  it('gives the same snapshot every time (useSyncExternalStore would loop forever otherwise)', () => {
    expect(pwaState()).toBe(pwaState());
    expect(pwaState()).toEqual({ registered: false, updateReady: false });
  });
});
