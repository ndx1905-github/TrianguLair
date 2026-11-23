/**
 * Address of the links this device hands out (invitations /i#, answers /r#, lists /l#, devices
 * /d#). The keys are after "#", which browsers never send, but the page served at that address
 * could read them: it must be a site the user trusts, typically where they host the web app.
 *
 * - The web app always uses its own address (where it is served, with its sub-path): the page
 *   that opens the links is the one handing them out. Nothing to ask.
 * - The phone apps are served by no site. They learn the address when this phone is added from
 *   the web app (the device link is at the web app's address), or from Settings › Friends; it is
 *   stored on the device only (`link-origin`). Until then: EXPO_PUBLIC_LINK_ORIGIN for a local
 *   build, else the reserved placeholder example.org (RFC 2606: no one can own it).
 * Nothing about the host is written in the code or the build.
 */
import { getSetting, setSetting } from '../data/deviceSettings';

export const LINK_ORIGIN_SETTING = 'link-origin';
export const PLACEHOLDER_ORIGIN = 'https://example.org';

function webOrigin(): string | null {
  const loc = (globalThis as { location?: { protocol?: string; origin?: string } }).location;
  if (!loc?.origin || (loc.protocol !== 'https:' && loc.protocol !== 'http:')) return null;
  return loc.origin + (process.env.EXPO_BASE_URL ?? '');
}

/** Whether the address can be set by the user (phone apps); the web app uses its own. */
// (No react-native import: this module is shared with plain Node tests. Phones have no `document`.)
export const LINK_ORIGIN_EDITABLE = typeof document === 'undefined';

function fallbackOrigin(): string {
  return (process.env.EXPO_PUBLIC_LINK_ORIGIN || PLACEHOLDER_ORIGIN).replace(/\/+$/, '');
}

function stored(): string | null {
  try {
    return getSetting(LINK_ORIGIN_SETTING);
  } catch {
    return null; // settings not open yet (tests, very early render)
  }
}

/** The address in use. No trailing slash. */
export function linkOrigin(): string {
  if (!LINK_ORIGIN_EDITABLE) return (webOrigin() ?? fallbackOrigin()).replace(/\/+$/, '');
  return stored() || fallbackOrigin();
}

/** Whether links still use the placeholder, which friends without the app cannot open. */
export function linkOriginIsPlaceholder(): boolean {
  return new URL(linkOrigin()).hostname === 'example.org';
}

/**
 * Normalizes what the user typed ("cloud.example.net/triangulair/" → "https://cloud.example.net/triangulair"),
 * or null when it is not a usable address: https only (http for a local address while testing),
 * no query, fragment or credentials.
 */
export function parseLinkOrigin(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
  if (u.search || u.hash || u.username || u.password || !u.hostname.includes('.') && !local) return null;
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

/** Saves the address (already parsed); an empty value goes back to the default. */
export function saveLinkOrigin(origin: string | null): void {
  setSetting(LINK_ORIGIN_SETTING, origin ?? '');
}

/**
 * A phone added from the web app learns its address from the device link
 * ("https://<web app>[/<sub-path>]/d#…"), unless the user already chose one.
 */
export function adoptLinkOriginFrom(deviceLinkText: string): void {
  if (!LINK_ORIGIN_EDITABLE || stored()) return;
  const m = /(https:\/\/[^\s#]+?)\/d#/.exec(deviceLinkText.trim());
  const origin = m ? parseLinkOrigin(m[1]!) : null;
  if (origin && new URL(origin).hostname !== 'example.org') saveLinkOrigin(origin);
}
