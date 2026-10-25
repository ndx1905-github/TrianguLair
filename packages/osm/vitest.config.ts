import { defineConfig } from 'vitest/config';

// Opening hours are evaluated in the device's local time zone; pin it so the
// tests give the same results everywhere.
process.env.TZ = 'Europe/Paris';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    env: { TZ: 'Europe/Paris' },
    // Keep the module cache inside this package (default is <workspace root>/node_modules).
    fsModuleCachePath: 'node_modules/.vitest-cache',
  },
});
