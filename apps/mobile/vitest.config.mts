import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Unit tests for pure logic only (no React Native runtime needed).
export default defineConfig({
  // Keep the cache inside this app (otherwise Vite may pick the workspace root).
  cacheDir: 'node_modules/.vite',
  resolve: {
    alias: [
      // Workspace packages, from their sources (same as Metro and tsconfig).
      { find: /^@triangulair\/data$/, replacement: here('../../packages/data/src/index.ts') },
      { find: /^@triangulair\/osm$/, replacement: here('../../packages/osm/src/index.ts') },
      { find: /^@triangulair\/import$/, replacement: here('../../packages/import/src/index.ts') },
      { find: /^@triangulair\/crypto$/, replacement: here('../../packages/crypto/src/index.ts') },
      { find: /^@triangulair\/storage$/, replacement: here('../../packages/storage/src/index.ts') },
      { find: /^aws4fetch$/, replacement: here('./node_modules/aws4fetch/dist/aws4fetch.esm.mjs') },
      // Their runtime dependencies come from this app's node_modules.
      { find: /^yjs$/, replacement: here('./node_modules/yjs/dist/yjs.mjs') },
      { find: /^libsodium-wrappers-sumo$/, replacement: here('./node_modules/libsodium-wrappers-sumo/dist/modules-sumo/libsodium-wrappers.js') },
      { find: /^@scure\/bip39\/wordlists\/english\.js$/, replacement: here('./node_modules/@scure/bip39/wordlists/english.js') },
      { find: /^@scure\/bip39$/, replacement: here('./node_modules/@scure/bip39/index.js') },
      { find: /^fflate$/, replacement: here('./node_modules/fflate/esm/browser.js') },
      { find: /^opening_hours$/, replacement: here('./node_modules/opening_hours/build/opening_hours.esm.mjs') },
    ],
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
