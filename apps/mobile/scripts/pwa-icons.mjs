// Draws the web app icons (PWA manifest, apple-touch-icon, favicon) into public/icons/.
//
// The app has no separate logo: the icon is the first-launch mark (src/firstLaunch/Hero.tsx),
// three map pins in a triangle (restaurant, museum, park), drawn with the map's own pin shape
// (src/pins/pinSvg.ts). The PNGs are committed; run this again only when the mark changes:
//
//   node scripts/pwa-icons.mjs        (needs rsvg-convert: apt install librsvg2-bin)
//
// - icon.svg, icon-192.png, icon-512.png: "any" purpose, rounded square, transparent corners;
// - maskable-512.png: full-bleed background, the pins inside the central 60 % (safe zone);
// - apple-touch-icon.png (180 px): full-bleed, iOS rounds the corners itself;
// - favicon-32.png.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

// src/pins/pinSvg.ts (viewBox 40x52) and src/theme/icons.ts (24x24, Material Design Icons).
const PIN_PATH = 'M20 49C17 42 4 32 4 19A16 16 0 1 1 36 19C36 32 23 42 20 49Z';
const ICONS = {
  restaurant:
    'M11,9H9V2H7V9H5V2H3V9C3,11.12 4.66,12.84 6.75,12.97V22H9.25V12.97C11.34,12.84 13,11.12 13,9V2H11V9M16,6V14H18.5V22H21V2C18.24,2 16,4.24 16,6Z',
  museum: 'M11.5,1L2,6V8H21V6M16,10V17H19V10M2,22H21V19H2M10,10V17H13V10M4,10V17H7V10H4Z',
  park: 'M11,21V16.74C10.53,16.91 10.03,17 9.5,17C7,17 5,15 5,12.5C5,11.23 5.5,10.09 6.36,9.27C6.13,8.73 6,8.13 6,7.5C6,5 8,3 10.5,3C12.06,3 13.44,3.8 14.25,5C14.33,5 14.41,5 14.5,5A5.5,5.5 0 0,1 20,10.5A5.5,5.5 0 0,1 14.5,16C14,16 13.5,15.93 13,15.79V21H11Z',
};
// src/theme/tags.ts PALETTE; background: src/theme/colors.ts (light background).
const PINS = [
  { color: '#EF4444', icon: ICONS.restaurant, x: 0, y: 26 },
  { color: '#3B82F6', icon: ICONS.museum, x: 52, y: 0 },
  { color: '#16A34A', icon: ICONS.park, x: 104, y: 26 },
];
const BACKGROUND = '#F5F5F4';
// Hero.tsx: 148 x 84 box, pins drawn 44 x 57 (scale 1.1 of the 40 x 52 viewBox).
const MARK = { width: 148, height: 84, pinScale: 44 / 40 };

function pin(p, i) {
  return (
    `<g transform="translate(${p.x} ${p.y}) scale(${MARK.pinScale})">` +
    `<clipPath id="c${i}"><path d="${PIN_PATH}"/></clipPath>` +
    `<ellipse cx="20" cy="50" rx="5" ry="1.6" fill="rgba(0,0,0,0.25)"/>` +
    `<rect width="40" height="52" fill="${p.color}" clip-path="url(#c${i})"/>` +
    `<path d="${PIN_PATH}" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linejoin="round"/>` +
    `<path d="${PIN_PATH}" fill="none" stroke="rgba(15,23,42,0.25)" stroke-width="0.6"/>` +
    `<g transform="translate(11 10) scale(0.75)">` +
    `<path d="${p.icon}" fill="none" stroke="#1F2937" stroke-width="4" stroke-linejoin="round"/>` +
    `<path d="${p.icon}" fill="#FFFFFF"/>` +
    `</g></g>`
  );
}

/** The mark centred in a 512 x 512 icon, `fill` = share of the width it takes. */
function icon({ rounded, fill }) {
  const size = 512;
  const scale = (size * fill) / MARK.width;
  const h = MARK.height * scale + 6 * scale; // the tips' shadow
  const tx = (size - MARK.width * scale) / 2;
  const ty = (size - h) / 2;
  const bg = rounded
    ? `<rect x="16" y="16" width="480" height="480" rx="108" fill="${BACKGROUND}"/>`
    : `<rect width="512" height="512" fill="${BACKGROUND}"/>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    bg +
    `<g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${scale.toFixed(4)})">${PINS.map(pin).join('')}</g>` +
    `</svg>\n`
  );
}

function png(svgFile, pngFile, px) {
  execFileSync('rsvg-convert', ['-w', String(px), '-h', String(px), '-o', join(out, pngFile), join(out, svgFile)]);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'icon.svg'), icon({ rounded: true, fill: 0.74 }));
// Maskable: the safe zone is a circle of 80 % of the width; the mark's corners stay inside it.
writeFileSync(join(out, 'maskable.svg'), icon({ rounded: false, fill: 0.6 }));
writeFileSync(join(out, 'apple.svg'), icon({ rounded: false, fill: 0.7 }));
png('icon.svg', 'icon-192.png', 192);
png('icon.svg', 'icon-512.png', 512);
png('icon.svg', 'favicon-32.png', 32);
png('maskable.svg', 'maskable-512.png', 512);
png('apple.svg', 'apple-touch-icon.png', 180);
// Only icon.svg is served (favicon); the other two are intermediate.
rmSync(join(out, 'maskable.svg'));
rmSync(join(out, 'apple.svg'));
console.log(`Icons written to ${out}`);
