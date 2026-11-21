// Turns a web export (`expo export --platform web`) into an installable, offline-capable PWA.
//
//   TL_WEB_BASE=/triangulair node scripts/pwa.mjs dist
//
// TL_WEB_BASE must be the one the export was built with (app.config.js reads it too); unset for
// the root of a domain. In the export folder, this script:
// - writes manifest.webmanifest (name, icons from public/icons/, colours, standalone, start_url and
//   scope = the base path);
// - adds the manifest, icons and iOS meta tags to index.html;
// - writes sw.js from web/service-worker.js with the list of exported files (all content-hashed by
//   Expo, except index.html, the icons and the MapLibre worker) and a version derived from their
//   contents, so every build that changes a file gets a new cache;
// - copies index.html to <route>/index.html for every route without a parameter (/l, /i, /r,
//   /settings, /lists/follow…), so a plain static host (YunoHost "My webapp": try_files $uri $uri/)
//   opens a deep link without a server-side fallback. Routes with a parameter (/place/<id>) are
//   answered by the service worker once it is installed, and before that by the host's "not
//   found" page, which is the app too: 404.html (GitHub Pages, Netlify, Codeberg Pages…) and
//   error/404.html (YunoHost "My webapp").
//
// The app registers sw.js only when built with EXPO_PUBLIC_TL_PWA=1 (src/pwa/pwa.web.ts). See
// docs/self-host-web.md; `npm run export:web:pwa` runs the export and this script.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { webBase } = require('./web-base.cjs');

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(process.argv[2] ?? 'dist');
const base = webBase();

const NAME = 'TrianguLair';
const DESCRIPTION = 'Your favorite places, shared with your friends, end-to-end encrypted.';
// src/theme/colors.ts: light and dark backgrounds.
const LIGHT = '#F5F5F4';
const DARK = '#0B0F14';

function fail(message) {
  console.error(`pwa: ${message}`);
  process.exit(1);
}

if (!existsSync(join(dist, 'index.html'))) fail(`${dist}/index.html not found: run \`expo export --platform web\` first.`);

/** expo-router routes (src/app) as path segments: static ones, and the first segments of all. */
function routes() {
  const statics = [];
  const firsts = new Set();
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = entry.name;
      if (name.startsWith('_') || name.startsWith('+')) continue;
      if (entry.isDirectory()) {
        if (!prefix.length) firsts.add(name);
        walk(join(dir, name), [...prefix, name]);
        continue;
      }
      const m = /^(.+)\.(tsx|ts|jsx|js)$/.exec(name);
      if (!m || /\.(test|native|ios|android)$/.test(m[1])) continue;
      const route = m[1] === 'index' ? prefix : [...prefix, m[1]];
      if (route.length === 0) continue;
      if (!prefix.length) firsts.add(route[0]);
      if (route.every((s) => !s.includes('[') && !s.startsWith('('))) statics.push(route.join('/'));
    }
  };
  walk(join(appDir, 'src', 'app'), []);
  return { statics: statics.sort(), firsts: [...firsts].sort() };
}

function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else out.push(relative(dir, p).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

const { statics, firsts } = routes();
/** "Not found" pages that are the app (see above). */
const NOT_FOUND_PAGES = ['404.html', 'error/404.html'];
const routeCopies = new Set([...statics.map((r) => `${r}/index.html`), ...NOT_FOUND_PAGES]);

// 1. index.html: check the base path, add the head tags.
const indexPath = join(dist, 'index.html');
let html = readFileSync(indexPath, 'utf8');
const entry = /<script src="([^"]*)\/_expo\/static\/js\/web\/entry-[^"]+"/.exec(html);
if (!entry) fail('index.html has no Expo entry script.');
if (entry[1] !== base) {
  fail(`the export was built for the base path "${entry[1] || '/'}" but TL_WEB_BASE is "${base || '/'}". Use the same value for both.`);
}
const head = [
  `<link rel="manifest" href="${base}/manifest.webmanifest">`,
  `<meta name="description" content="${DESCRIPTION}">`,
  `<meta name="application-name" content="${NAME}">`,
  `<meta name="theme-color" media="(prefers-color-scheme: light)" content="${LIGHT}">`,
  `<meta name="theme-color" media="(prefers-color-scheme: dark)" content="${DARK}">`,
  `<link rel="icon" type="image/png" sizes="32x32" href="${base}/icons/favicon-32.png">`,
  `<link rel="icon" type="image/svg+xml" href="${base}/icons/icon.svg">`,
  // iOS: home-screen icon and title, full-screen launch (Safari › Share › Add to Home Screen).
  `<link rel="apple-touch-icon" href="${base}/icons/apple-touch-icon.png">`,
  `<meta name="apple-mobile-web-app-capable" content="yes">`,
  `<meta name="mobile-web-app-capable" content="yes">`,
  `<meta name="apple-mobile-web-app-title" content="${NAME}">`,
  `<meta name="apple-mobile-web-app-status-bar-style" content="default">`,
  `<meta name="format-detection" content="telephone=no">`,
];
if (!html.includes('rel="manifest"')) {
  html = html.replace('</head>', `${head.join('\n')}\n</head>`);
  writeFileSync(indexPath, html);
}

// 2. The manifest.
const appVersion = JSON.parse(readFileSync(join(appDir, 'app.json'), 'utf8')).expo.version;
const manifest = {
  id: `${base}/`,
  name: NAME,
  short_name: NAME,
  description: DESCRIPTION,
  lang: 'en',
  dir: 'ltr',
  start_url: `${base}/`,
  scope: `${base}/`,
  display: 'standalone',
  orientation: 'any',
  background_color: LIGHT,
  theme_color: LIGHT,
  categories: ['travel', 'lifestyle', 'navigation'],
  icons: [
    { src: `${base}/icons/icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: `${base}/icons/icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: `${base}/icons/maskable-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    { src: `${base}/icons/icon.svg`, sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
  ],
};
for (const icon of manifest.icons) {
  if (!existsSync(join(dist, icon.src.slice(base.length + 1)))) fail(`${icon.src} is missing from the export (public/icons/).`);
}
writeFileSync(join(dist, 'manifest.webmanifest'), `${JSON.stringify(manifest, null, 2)}\n`);

// 3. The service worker: every exported file but itself, the route copies, source maps and Expo's metadata.
const files = listFiles(dist).filter(
  (f) => f !== 'sw.js' && f !== 'metadata.json' && !f.endsWith('.map') && !routeCopies.has(f) && !f.split('/').some((s) => s.startsWith('.')),
);
const digest = createHash('sha256');
let bytes = 0;
for (const f of files) {
  const content = readFileSync(join(dist, f));
  bytes += content.length;
  digest.update(`${f}\0${createHash('sha256').update(content).digest('hex')}\n`);
}
const version = `${appVersion}-${digest.digest('hex').slice(0, 12)}`;
const config = { version, base, files, routes: firsts };
const template = readFileSync(join(appDir, 'web', 'service-worker.js'), 'utf8');
writeFileSync(join(dist, 'sw.js'), `const TL_PWA = ${JSON.stringify(config)};\n${template}`);

// 4. A copy of index.html per static route, for hosts without a fallback page.
for (const route of statics) {
  const target = join(dist, route, 'index.html');
  const dir = dirname(target);
  if (existsSync(dir) && !statSync(dir).isDirectory()) continue;
  mkdirSync(dir, { recursive: true });
  writeFileSync(target, html);
}
for (const page of NOT_FOUND_PAGES) {
  mkdirSync(dirname(join(dist, page)), { recursive: true });
  writeFileSync(join(dist, page), html);
}

console.log(
  `pwa: ${base || '/'} · version ${version} · ${files.length} files precached (${(bytes / 1e6).toFixed(1)} MB) · ${statics.length} route pages`,
);
