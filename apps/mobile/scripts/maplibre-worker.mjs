// Copies MapLibre GL JS's worker into public/ (web map, src/components/map/Map.web.tsx).
//
// maplibre-gl 6 is ESM only and loads its worker from a file of its own
// (`maplibre-gl-worker.mjs`) instead of an inlined blob. Metro bundles the
// library but not the worker, so the worker is served as a static file: Expo
// serves public/ in development and copies it into the web export. The copy is
// generated (git-ignored) and made again on every install and web export, so it
// always matches the installed maplibre-gl.
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(appDir, 'package.json'));
const src = join(dirname(require.resolve('maplibre-gl/package.json')), 'dist/maplibre-gl-worker.mjs');
mkdirSync(join(appDir, 'public'), { recursive: true });
copyFileSync(src, join(appDir, 'public/maplibre-gl-worker.mjs'));
