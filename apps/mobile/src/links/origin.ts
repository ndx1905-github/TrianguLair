/**
 * Address of the links this device hands out (invitations /i#, answers /r#, lists /l#, devices
 * /d#). The keys are after "#", which browsers never send, but the page served at that address
 * could read them: it must be a site the user trusts, typically where they host the web app.
 *
 * Asked at first launch (profile step) and changeable in Settings; stored on this device only
 * (`link-origin`). Nothing about it is written in the code or the build. Until it is set:
 * - the web app uses its own address (with its sub-path);
 * - the phone apps use the reserved placeholder example.org (RFC 2606: no one can own it), or
 *   EXPO_PUBLIC_LINK_ORIGIN for a local build.
 */
import { getSetting, setSetting } from '../data/deviceSettings';

export const LINK_ORIGIN_SETTING = 'link-origin';
export const PLACEHOLDER_ORIGIN = 'https://example.org';

function webOrigin(): string | null {
  const loc = (globalThis as { location?: { protocol?: string; origin?: string } }).location;
  if (!loc?.origin || (loc.protocol !== 'https:' && loc.protocol !== 'http:')) return null;
  return loc.origin + (process.env.EXPO_BASE_URL ?? '');
}

/** The address suggested before the user chose one. */
export function defaultLinkOrigin(): string {
  return (process.env.EXPO_PUBLIC_LINK_ORIGIN || webOrigin() || PLACEHOLDER_ORIGIN).replace(/\/+$/, '');
}

function stored(): string | null {
  try {
    return getSetting(LINK_ORIGIN_SETTING);
  } catch {
    return null; // settings not open yet (tests, very early render)
  }
}

/** The address in use: the user's choice, else the default. No trailing slash. */
export function linkOrigin(): string {
  return stored() || defaultLinkOrigin();
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
