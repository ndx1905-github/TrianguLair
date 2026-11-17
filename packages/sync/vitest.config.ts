import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // One libsodium instance for the crypto package and sign.ts (as in the app): `ready()` covers both.
    alias: [{ find: /^libsodium-wrappers-sumo$/, replacement: fileURLToPath(new URL('../crypto/node_modules/libsodium-wrappers-sumo/dist/modules-sumo/libsodium-wrappers.js', import.meta.url)) }],
  },
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Keep the module cache inside this package (default is <workspace root>/node_modules).
    fsModuleCachePath: 'node_modules/.vitest-cache',
  },
});
