/**
 * Native stub of the installable web app (src/pwa/pwa.web.ts): the phone apps have no service
 * worker and their storage is not evicted by a browser.
 */
export interface PwaState {
  /** The service worker is registered (web PWA builds only). */
  registered: boolean;
  /** A new version is installed and waits for "Reload". */
  updateReady: boolean;
}

export interface BrowserStorage {
  /** The browser has `navigator.storage.persist()`. */
  supported: boolean;
  /** true: the browser keeps this site's data; false: it may clear it; null: unknown. */
  persisted: boolean | null;
  /** Bytes used and available to this site, when the browser says. */
  usage: number | null;
  quota: number | null;
  /** Opened from the Home Screen / as an installed app. */
  installed: boolean;
}

export const PWA_ENABLED = false;

export function pwaState(): PwaState {
  return { registered: false, updateReady: false };
}

export function subscribePwa(_fn: () => void): () => void {
  return () => {};
}

export function startPwa(): void {}

export async function applyUpdate(_beforeReload?: () => Promise<void>): Promise<void> {}

export async function requestPersistence(): Promise<boolean | null> {
  return null;
}

export async function browserStorage(): Promise<BrowserStorage> {
  return { supported: false, persisted: null, usage: null, quota: null, installed: false };
}
