import { defineConfig } from 'vitest/config';

// Unit tests for pure logic only (no React Native runtime needed).
export default defineConfig({
  // Keep the cache inside this app (otherwise Vite may pick the workspace root).
  cacheDir: 'node_modules/.vite',
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
