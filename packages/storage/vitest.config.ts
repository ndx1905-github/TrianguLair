import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20000,
    hookTimeout: 20000,
    // Keep the module cache inside this package (default is <workspace root>/node_modules).
    fsModuleCachePath: 'node_modules/.vitest-cache',
  },
});
