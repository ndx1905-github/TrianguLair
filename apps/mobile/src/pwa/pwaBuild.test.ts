/**
 * The PWA build step (scripts/pwa.mjs, scripts/web-base.cjs) on a small fake export: base path
 * checks, manifest, head tags, the service worker's file list and version, route copies.
 * The real export is covered by e2e/pwa.spec.ts.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const appDir = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(import.meta.url);
const { webBase } = require('../../scripts/web-base.cjs') as { webBase: (raw?: string) => string };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fake `expo export` output built for `base`. */
function fakeExport(base: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'tl-pwa-'));
  dirs.push(dir);
  mkdirSync(join(dir, '_expo/static/js/web'), { recursive: true });
  mkdirSync(join(dir, 'icons'), { recursive: true });
  writeFileSync(
    join(dir, 'index.html'),
    `<!DOCTYPE html><html><head><title>TrianguLair</title></head><body><div id="root"></div><script src="${base}/_expo/static/js/web/entry-0123abcd.js" defer></script></body></html>`,
  );
  writeFileSync(join(dir, '_expo/static/js/web/entry-0123abcd.js'), 'console.log(1)');
  writeFileSync(join(dir, '_expo/static/js/web/entry-0123abcd.js.map'), '{}');
  writeFileSync(join(dir, 'metadata.json'), '{}');
  writeFileSync(join(dir, 'maplibre-gl-worker.mjs'), 'self.onmessage = () => {}');
  for (const f of ['icon-192.png', 'icon-512.png', 'maskable-512.png', 'icon.svg', 'apple-touch-icon.png', 'favicon-32.png']) {
    writeFileSync(join(dir, 'icons', f), f);
  }
  return dir;
}

function run(dir: string, base: string): string {
  return execFileSync(process.execPath, [join(appDir, 'scripts/pwa.mjs'), dir], {
    cwd: appDir,
    env: { ...process.env, TL_WEB_BASE: base },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function swConfig(dir: string): { version: string; base: string; files: string[]; routes: string[] } {
  const src = readFileSync(join(dir, 'sw.js'), 'utf8');
  const m = /^const TL_PWA = (.*);$/m.exec(src);
  expect(m).toBeTruthy();
  return JSON.parse(m![1]!);
}

describe('TL_WEB_BASE', () => {
  it('normalises the base path', () => {
    expect(webBase('')).toBe('');
    expect(webBase('/')).toBe('');
    expect(webBase(undefined)).toBe('');
    expect(webBase('triangulair')).toBe('/triangulair');
    expect(webBase('/triangulair/')).toBe('/triangulair');
    expect(webBase('/apps/triangulair')).toBe('/apps/triangulair');
  });
  it('refuses anything but a plain path', () => {
    for (const bad of ['https://x.org/a', '/a b', '/../a', '/a?x', '/a#b', '/a/./b']) expect(() => webBase(bad)).toThrow();
  });
});

describe('scripts/pwa.mjs', () => {
  it.each(['', '/triangulair'])('builds the manifest, tags, service worker and route pages for base "%s"', (base) => {
    const dir = fakeExport(base);
    run(dir, base);

    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.webmanifest'), 'utf8'));
    expect(manifest).toMatchObject({ start_url: `${base}/`, scope: `${base}/`, display: 'standalone', name: 'TrianguLair' });
    expect(manifest.icons.map((i: { purpose: string; sizes: string }) => `${i.sizes} ${i.purpose}`)).toEqual(['192x192 any', '512x512 any', '512x512 maskable', 'any any']);
    for (const i of manifest.icons) expect(i.src.startsWith(`${base}/icons/`)).toBe(true);

    const html = readFileSync(join(dir, 'index.html'), 'utf8');
    expect(html).toContain(`<link rel="manifest" href="${base}/manifest.webmanifest">`);
    expect(html).toContain(`<link rel="apple-touch-icon" href="${base}/icons/apple-touch-icon.png">`);
    expect(html).toContain('<meta name="apple-mobile-web-app-capable" content="yes">');

    const sw = swConfig(dir);
    expect(sw.base).toBe(base);
    expect(sw.files).toContain('index.html');
    expect(sw.files).toContain('manifest.webmanifest');
    expect(sw.files).toContain('maplibre-gl-worker.mjs');
    expect(sw.files).toContain('_expo/static/js/web/entry-0123abcd.js');
    // Never source maps, Expo's metadata, the service worker itself, or the route copies.
    expect(sw.files.filter((f) => f.endsWith('.map') || f === 'metadata.json' || f === 'sw.js' || f === 'l/index.html')).toEqual([]);
    expect(sw.routes).toEqual(expect.arrayContaining(['l', 'i', 'r', 'lists', 'place', 'settings']));
    expect(sw.routes).not.toContain('index');

    // Deep links and other routes without a parameter open on a plain static host.
    for (const r of ['l', 'i', 'r', 'settings', 'lists/follow', 'lists/followed', 'invite']) {
      expect(readFileSync(join(dir, r, 'index.html'), 'utf8'), r).toBe(html);
    }
    expect(existsSync(join(dir, 'place', '[id]'))).toBe(false);
  });

  it('is idempotent, and the version follows the content', () => {
    const dir = fakeExport('');
    run(dir, '');
    const first = swConfig(dir);
    const html = readFileSync(join(dir, 'index.html'), 'utf8');
    run(dir, '');
    expect(swConfig(dir)).toEqual(first);
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toBe(html);
    writeFileSync(join(dir, 'maplibre-gl-worker.mjs'), 'self.onmessage = () => { /* new */ }');
    run(dir, '');
    expect(swConfig(dir).version).not.toBe(first.version);
  });

  it('refuses an export built for another base path', () => {
    const dir = fakeExport('/triangulair');
    expect(() => run(dir, '')).toThrow(/base path/);
    const root = fakeExport('');
    expect(() => run(root, '/triangulair')).toThrow(/base path/);
  });
});
