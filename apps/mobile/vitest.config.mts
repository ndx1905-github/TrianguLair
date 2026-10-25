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
      // Their runtime dependencies come from this app's node_modules.
      { find: /^@automerge\/automerge$/, replacement: here('./node_modules/@automerge/automerge/dist/cjs/fullfat_node.cjs') },
      { find: /^opening_hours$/, replacement: here('./node_modules/opening_hours/build/opening_hours.esm.mjs') },
    ],
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
