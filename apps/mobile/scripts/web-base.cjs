/**
 * The base path of the web build (TL_WEB_BASE), shared by app.config.js and scripts/pwa.mjs.
 *
 * "" (unset, "/") serves the app at the root of a domain; "/triangulair" (also written
 * "triangulair" or "/triangulair/") serves it under https://cloud.example.org/triangulair/.
 * Returned without a trailing slash, as expo-router's `experiments.baseUrl` wants it.
 */
function webBase(raw = process.env.TL_WEB_BASE) {
  const s = String(raw ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!s) return '';
  if (!/^[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/.test(s) || s.split('/').some((p) => p === '.' || p === '..')) {
    throw new Error(`TL_WEB_BASE: "${raw}" is not a plain path such as /triangulair`);
  }
  return `/${s}`;
}

module.exports = { webBase };
