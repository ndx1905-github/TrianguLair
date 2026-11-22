// Checks a PWA export (CI and release): the manifest, the service worker and the files it
// precaches are there, and everything points at the expected base path.
//
//   node scripts/check-pwa.mjs dist-web                 (built for the root of a domain)
//   node scripts/check-pwa.mjs dist-web /triangulair    (built for a sub-path)
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = resolve(process.argv[2] ?? 'dist-web');
const base = (process.argv[3] ?? '').replace(/\/+$/, '');
const problems = [];
const check = (ok, message) => {
  if (!ok) problems.push(message);
};
const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : null);

const html = read('index.html');
check(html, 'index.html is missing');
if (html) {
  check(html.includes(`<link rel="manifest" href="${base}/manifest.webmanifest">`), 'index.html does not link the manifest');
  check(html.includes(`<link rel="apple-touch-icon" href="${base}/icons/apple-touch-icon.png">`), 'index.html has no apple-touch-icon');
  check(html.includes(`src="${base}/_expo/static/js/web/entry-`), `index.html does not load the app from ${base || '/'}`);
}

const manifestText = read('manifest.webmanifest');
check(manifestText, 'manifest.webmanifest is missing');
if (manifestText) {
  let m = null;
  try {
    m = JSON.parse(manifestText);
  } catch {
    check(false, 'manifest.webmanifest is not JSON');
  }
  if (m) {
    check(m.name === 'TrianguLair' && m.short_name, 'manifest: name');
    check(m.display === 'standalone', 'manifest: display');
    check(m.start_url === `${base}/` && m.scope === `${base}/`, `manifest: start_url and scope must be ${base}/`);
    for (const [sizes, purpose] of [['192x192', 'any'], ['512x512', 'any'], ['512x512', 'maskable']]) {
      const icon = (m.icons ?? []).find((i) => i.sizes === sizes && i.purpose === purpose);
      check(icon && existsSync(join(dir, icon.src.slice(base.length))), `manifest: ${sizes} ${purpose} icon missing`);
    }
  }
}

const sw = read('sw.js');
check(sw, 'sw.js is missing');
if (sw) {
  const cfg = /^const TL_PWA = (.*);$/m.exec(sw);
  check(cfg, 'sw.js has no TL_PWA configuration');
  if (cfg) {
    const c = JSON.parse(cfg[1]);
    check(c.base === base, `sw.js: base "${c.base}", expected "${base}"`);
    check(c.files.includes('index.html') && c.files.some((f) => f.startsWith('_expo/static/js/web/entry-')), 'sw.js: the shell is not precached');
    for (const f of c.files) check(existsSync(join(dir, f)), `sw.js precaches a missing file: ${f}`);
  }
}

if (problems.length) {
  for (const p of problems) console.error(`check-pwa: ${p}`);
  process.exit(1);
}
console.log(`check-pwa: ${dir} OK (base ${base || '/'})`);
