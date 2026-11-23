/**
 * Downloading the photos an app keeps on its own server (Mapstr, Pin Drop), when the import
 * preview asks for it: the fetcher handed to `applyImport` (`fetchPhoto`). No cookie and no
 * referrer are sent; the photo is then processed like a picked one (shrunk, thumbnail, metadata
 * removed) by the caller. The URLs are used here only, never stored.
 *
 * On the phone, `fetch` has no cross-origin rule. In a browser, the app's server usually does not
 * allow other sites to read its images: the request fails with a `TypeError` before any answer,
 * reported as `PhotoDownloadBlockedError` so the import stops trying and says the photos can be
 * downloaded from the phone app.
 */
import { PhotoDownloadBlockedError } from '@triangulair/import';

/** Largest download accepted (the original photo; it is shrunk afterwards). */
export const MAX_DOWNLOAD_BYTES = 40 * 1024 * 1024;

/** `web`: running in a browser (`Platform.OS === 'web'`; passed in so this stays testable without React Native). */
export async function fetchRemotePhoto(url: string, signal: AbortSignal, web: boolean, f: typeof fetch = fetch): Promise<Uint8Array> {
  if (!/^https:\/\//i.test(url)) throw new Error('not an https URL');
  let res: Response;
  try {
    res = await f(url, { signal, credentials: 'omit', ...(web && { mode: 'cors' as const, referrerPolicy: 'no-referrer' as const }) });
  } catch (e) {
    if (web && !signal.aborted && e instanceof TypeError) throw new PhotoDownloadBlockedError(e.message);
    throw e;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const length = Number(res.headers.get('content-length') ?? 0);
  if (length > MAX_DOWNLOAD_BYTES) throw new Error('too large');
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_DOWNLOAD_BYTES) throw new Error('empty or too large');
  return bytes;
}
