import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Keep the module cache inside this package (default is <workspace root>/node_modules).
    fsModuleCachePath: 'node_modules/.vitest-cache',
  },
});
