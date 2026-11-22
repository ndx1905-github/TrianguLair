/**
 * The installable web app (PWA), web only (src/pwa/pwa.ts is the native stub): the service worker
 * (scripts/pwa.mjs writes `sw.js` into the export), the "update available" state, and the browser's
 * persistent storage. See docs/self-host-web.md.
 *
 * The service worker is registered only in builds made with EXPO_PUBLIC_TL_PWA=1
 * (`npm run export:web:pwa`), never by the development server or the default fixture build used
 * by most end-to-end tests.
 */
import type { BrowserStorage, PwaState } from './pwa';

export type { BrowserStorage, PwaState } from './pwa';

export const PWA_ENABLED = process.env.EXPO_PUBLIC_TL_PWA === '1';
/** expo-router's base path ("" at the root of a domain, "/triangulair" under a sub-path). */
const BASE = process.env.EXPO_BASE_URL ?? '';
/** Look for a new version this often while the app stays open (and when it comes back). */
const UPDATE_CHECK_MS = 60 * 60_000;

let state: PwaState = { registered: false, updateReady: false };
let waiting: ServiceWorker | null = null;
let started = false;
let reloading = false;
const listeners = new Set<() => void>();

function set(next: Partial<PwaState>): void {
  state = { ...state, ...next };
  for (const fn of listeners) fn();
}

export function pwaState(): PwaState {
  return state;
}

export function subscribePwa(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function track(reg: ServiceWorkerRegistration): void {
  const offer = (sw: ServiceWorker | null) => {
    // A waiting worker with a controller in place is an update; the first install has no controller.
    if (sw && navigator.serviceWorker.controller) {
      waiting = sw;
      set({ updateReady: true });
    }
  };
  offer(reg.waiting);
  reg.addEventListener('updatefound', () => {
    const sw = reg.installing;
    sw?.addEventListener('statechange', () => {
      if (sw.state === 'installed') offer(reg.waiting ?? sw);
    });
  });
}

/** Registers the service worker and asks for persistent storage (once, at startup). */
export function startPwa(): void {
  if (started || !PWA_ENABLED || typeof window === 'undefined' || typeof navigator === 'undefined') return;
  started = true;
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Only after the user chose "Reload": the first install's takeover changes nothing visible.
    if (reloading) window.location.reload();
  });
  const register = async () => {
    try {
      const reg = await navigator.serviceWorker.register(`${BASE}/sw.js`, { scope: `${BASE}/` });
      set({ registered: true });
      track(reg);
      const check = () => void reg.update().catch(() => {});
      setInterval(check, UPDATE_CHECK_MS);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
      });
    } catch (e) {
      // http:// (other than localhost), a private window, or the host refuses: the app works without.
      console.warn('Service worker not registered', e);
    }
  };
  if (document.readyState === 'complete') void register();
  else window.addEventListener('load', () => void register(), { once: true });
  void requestPersistence();
}

/**
 * Switches to the new version: `beforeReload` first (the app saves its database), then the waiting
 * service worker takes over and the page reloads.
 */
export async function applyUpdate(beforeReload?: () => Promise<void>): Promise<void> {
  try {
    await beforeReload?.();
  } catch {
    // Saving is best effort here: the database is also saved after every edit.
  }
  reloading = true;
  if (waiting) waiting.postMessage({ type: 'skip-waiting' });
  else window.location.reload();
}

function storageManager(): StorageManager | null {
  return typeof navigator !== 'undefined' && navigator.storage ? navigator.storage : null;
}

/**
 * Asks the browser to keep this site's data (IndexedDB: my places, keys) when space runs low.
 * Chrome decides by itself (granted for an installed app or a bookmarked, often used site); Safari
 * grants it to apps added to the Home Screen; Firefox may ask. null: not supported.
 */
export async function requestPersistence(): Promise<boolean | null> {
  const s = storageManager();
  if (!s?.persist) return null;
  try {
    if (s.persisted && (await s.persisted())) return true;
    return await s.persist();
  } catch {
    return null;
  }
}

export async function browserStorage(): Promise<BrowserStorage> {
  const s = storageManager();
  let persisted: boolean | null = null;
  let usage: number | null = null;
  let quota: number | null = null;
  try {
    if (s?.persisted) persisted = await s.persisted();
  } catch {
    persisted = null;
  }
  try {
    const e = s?.estimate ? await s.estimate() : null;
    usage = e?.usage ?? null;
    quota = e?.quota ?? null;
  } catch {
    // Unknown.
  }
  const standalone =
    (typeof window !== 'undefined' && window.matchMedia?.('(display-mode: standalone)').matches) ||
    (typeof navigator !== 'undefined' && (navigator as { standalone?: boolean }).standalone === true);
  return { supported: !!s?.persist, persisted, usage, quota, installed: !!standalone };
}
