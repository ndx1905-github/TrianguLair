import { describe, expect, it } from 'vitest';
import { generateRecoveryPhrase, identityFromPhrase, ready } from '../src/index';

describe('ready()', () => {
  it('is idempotent and everything works after it', async () => {
    await ready();
    await ready();
    expect(identityFromPhrase(generateRecoveryPhrase()).owner).toMatch(/^ed25519:/);
  });
});
