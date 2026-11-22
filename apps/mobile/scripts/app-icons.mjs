// Draws every app icon from one design: the phone apps' icons (assets/) and the web app's
// icons (public/icons/: PWA manifest, apple-touch-icon, favicon).
//
// Design: a white map pin (the map's own pin shape, src/pins/pinSvg.ts) on a blue gradient,
// with a triangle in its head whose corners are three coloured places: TrianguLair's
// triangulation between friends. The PNGs are committed; run this again only when the
// design changes:
//
//   node scripts/app-icons.mjs        (needs rsvg-convert: apt install librsvg2-bin)
//
// assets/ (app.json):
// - icon.png (1024): full-bleed square; iOS rounds the corners itself;
// - adaptive-foreground.png / adaptive-background.png (1024): Android adaptive icon; the
//   pin stays inside the central 66 % circle that every launcher mask keeps;
// - adaptive-monochrome.png (1024): Android 13 themed icon (one colour, the triangle cut out).
// public/icons/:
// - icon.svg, icon-192.png, icon-512.png: rounded square, transparent corners;
// - maskable-512.png: full-bleed, pin inside the 80 % safe zone;
// - apple-touch-icon.png (180 px): full-bleed;
// - favicon-32.png.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const web = join(root, 'public', 'icons');
const assets = join(root, 'assets');

// src/pins/pinSvg.ts, viewBox 40 x 52 (tip at y = 49).
const PIN_PATH = 'M20 49C17 42 4 32 4 19A16 16 0 1 1 36 19C36 32 23 42 20 49Z';
export const COLORS = {
  top: '#3B82F6', // gradient, src/theme/tags.ts blue
  bottom: '#1E3A8A',
  triangle: '#1E40AF',
  places: ['#FB7185', '#2DD4BF', '#FBBF24'], // top, left, right corners
};

const gradient = `<defs><linearGradient id="g" x1="0" y1="0" x2="0.4" y2="1"><stop offset="0" stop-color="${COLORS.top}"/><stop offset="1" stop-color="${COLORS.bottom}"/></linearGradient></defs>`;

/** The pin, 40 x 52 units; `mono` draws it in one colour with the triangle cut out. */
function pin(mono) {
  const tri = 'M20 9.5L29 25H11Z';
  if (mono) {
    return (
      `<mask id="m"><rect x="-10" y="-10" width="60" height="70" fill="#fff"/>` +
      `<path d="${tri}" fill="#000" stroke="#000" stroke-width="2.5" stroke-linejoin="round"/></mask>` +
      `<path d="${PIN_PATH}" fill="#fff" mask="url(#m)"/>`
    );
  }
  const [a, b, c] = COLORS.places;
  return (
    `<path d="${PIN_PATH}" fill="#FFFFFF"/>` +
    `<path d="${tri}" fill="${COLORS.triangle}" stroke="${COLORS.triangle}" stroke-width="2.5" stroke-linejoin="round"/>` +
    `<circle cx="20" cy="10" r="2.6" fill="${a}"/><circle cx="11.2" cy="24.6" r="2.6" fill="${b}"/>` +
    `<circle cx="28.8" cy="24.6" r="2.6" fill="${c}"/>`
  );
}

/**
 * One icon, `size` px. `height` = the pin's height as a share of the size (pin centred on
 * its 4..49 extent); `bg`: 'rounded' | 'full' | 'none'.
 */
function icon({ size, height, bg, mono = false }) {
  const s = (size * height) / 45; // the pin spans y = 4..49
  const tx = size / 2 - 20 * s;
  const ty = size / 2 - 26.5 * s;
  const back =
    bg === 'rounded'
      ? `${gradient}<rect x="${size * 0.03}" y="${size * 0.03}" width="${size * 0.94}" height="${size * 0.94}" rx="${size * 0.21}" fill="url(#g)"/>`
      : bg === 'full'
        ? `${gradient}<rect width="${size}" height="${size}" fill="url(#g)"/>`
        : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    back +
    `<g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${s.toFixed(4)})">${pin(mono)}</g></svg>\n`
  );
}

function write(dir, name, svg, px) {
  const file = join(dir, name);
  if (name.endsWith('.svg')) return writeFileSync(file, svg);
  const tmp = `${file}.svg`;
  writeFileSync(tmp, svg);
  execFileSync('rsvg-convert', ['-w', String(px), '-h', String(px), '-o', file, tmp]);
  rmSync(tmp);
}

mkdirSync(web, { recursive: true });
mkdirSync(assets, { recursive: true });

// Phone apps.
write(assets, 'icon.png', icon({ size: 1024, height: 0.68, bg: 'full' }), 1024);
write(assets, 'adaptive-foreground.png', icon({ size: 1024, height: 0.58, bg: 'none' }), 1024);
write(assets, 'adaptive-background.png', icon({ size: 1024, height: 0, bg: 'full' }).replace(/<g transform.*<\/g>/, ''), 1024);
write(assets, 'adaptive-monochrome.png', icon({ size: 1024, height: 0.58, bg: 'none', mono: true }), 1024);

// Web app.
const rounded = icon({ size: 512, height: 0.7, bg: 'rounded' });
write(web, 'icon.svg', rounded);
write(web, 'icon-192.png', rounded, 192);
write(web, 'icon-512.png', rounded, 512);
write(web, 'favicon-32.png', icon({ size: 512, height: 0.8, bg: 'rounded' }), 32);
write(web, 'maskable-512.png', icon({ size: 512, height: 0.6, bg: 'full' }), 512);
write(web, 'apple-touch-icon.png', icon({ size: 512, height: 0.72, bg: 'full' }), 180);

console.log(`Icons written to ${assets} and ${web}`);
