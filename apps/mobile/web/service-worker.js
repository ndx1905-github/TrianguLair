/*
 * TrianguLair service worker (web build only). Template: scripts/pwa.mjs writes it to <export>/sw.js
 * after `expo export`, with `TL_PWA` (below) filled in: the build's version, the list of exported
 * files and the app's first-level routes. See docs/self-host-web.md.
 *
 * What it does, and nothing more:
 * - precaches the exported app shell (index.html, the hashed JavaScript and CSS bundles, the
 *   fonts, icons and the MapLibre worker) in one cache per build, and deletes the caches of older
 *   builds of the same app (same scope) once the new one is active;
 * - answers the app's own files from that cache (they are content-hashed, so never stale);
 * - navigations to the app's routes: network first (the server's index.html), the cached shell when
 *   the network fails, takes too long, or the server has no file for that route (a reload of
 *   /place/<id> on a static host);
 * - a new build waits until the page asks it to take over ("update available, reload").
 *
 * It never answers or stores anything else: requests to another origin (WebDAV, S3, the map tiles
 * and styles, OpenStreetMap services, photos) and same-origin requests outside the app's files
 * (a Nextcloud on the same domain) go to the network untouched, and are never cached here. The map
 * tiles keep only the browser's own HTTP cache, as without a service worker.
 */
/* global TL_PWA */
'use strict';

const CACHE_PREFIX = 'triangulair-shell';
const SCOPE = new URL(self.registration.scope); // ends with "/"
// One app per scope: a root build and a /triangulair/ build on one origin keep their own caches.
const CACHE_GROUP = `${CACHE_PREFIX} ${SCOPE.pathname} `;
const CACHE = CACHE_GROUP + TL_PWA.version;
const SHELL_URL = new URL('index.html', SCOPE).href;
/** Absolute URLs (without query) of the precached files. */
const PRECACHE = new Set(TL_PWA.files.map((f) => new URL(f, SCOPE).href));
const ROUTES = new Set(TL_PWA.routes);
/** A navigation slower than this gets the cached shell (the page then talks to the network itself). */
const NAVIGATION_TIMEOUT_MS = 6000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // `reload`: bypass the HTTP cache, so a half-updated server never mixes two builds.
      cache.addAll([...PRECACHE].map((url) => new Request(url, { cache: 'reload' }))),
    ),
  );
  // No skipWaiting here: an update waits for the page's "Reload" (see the message handler). The
  // very first install has nothing to wait for and activates at once.
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith(CACHE_GROUP) && name !== CACHE) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  const type = event.data && event.data.type;
  if (type === 'skip-waiting') self.skipWaiting();
  else if (type === 'version' && event.ports && event.ports[0]) event.ports[0].postMessage({ version: TL_PWA.version });
});

/** Is this same-origin navigation one of the app's pages (and not, e.g., a Nextcloud on the same domain)? */
function isAppPage(url) {
  if (!url.pathname.startsWith(SCOPE.pathname)) return false;
  const rest = url.pathname.slice(SCOPE.pathname.length);
  if (rest === '' || rest === 'index.html') return true;
  return ROUTES.has(rest.split('/')[0]);
}

async function cachedShell() {
  const cache = await caches.open(CACHE);
  return cache.match(SHELL_URL);
}

async function navigate(request) {
  const network = fetch(request);
  network.catch(() => {}); // when the shell was served first, a later failure is not an error
  let timer;
  const slow = new Promise((resolve) => {
    timer = setTimeout(resolve, NAVIGATION_TIMEOUT_MS, 'slow');
  });
  try {
    const first = await Promise.race([network, slow]);
    if (first === 'slow') {
      const shell = await cachedShell();
      if (shell) return shell;
      return await network;
    }
    // A static host without a fallback page answers 404 for /place/<id>: the app handles the route.
    if (first.status === 404 || first.status === 410) {
      const shell = await cachedShell();
      if (shell) return shell;
    }
    return first;
  } catch (e) {
    const shell = await cachedShell();
    if (shell) return shell;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function precached(request, key) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(key);
  return hit || fetch(request);
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // storage, map tiles, OSM: never touched
  if (request.mode === 'navigate') {
    if (isAppPage(url)) event.respondWith(navigate(request));
    return;
  }
  // The app's own files only, matched without the query (the MapLibre worker has `?v=<version>`).
  const key = url.origin + url.pathname;
  if (PRECACHE.has(key)) event.respondWith(precached(request, key));
});
