/**
 * Copying a kit field: the clipboard is cleared one minute later (spec
 * "Recovery kit"). Timers do not run while the app is suspended, so the
 * deadline is also checked when the app comes back to the foreground.
 *
 * The clipboard is cleared without reading it first (reading it shows a
 * paste prompt on iOS): something copied elsewhere within that minute is
 * cleared too. The system clipboard history (Android, some keyboards) is out
 * of the app's reach.
 */
import { AppState } from 'react-native';
import * as Clipboard from 'expo-clipboard';

import { KIT_CLIPBOARD_CLEAR_MS } from './kit';

let deadline: number | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let listening = false;
const listeners = new Set<() => void>();

async function clearNow(): Promise<void> {
  deadline = null;
  if (timer) clearTimeout(timer);
  timer = null;
  try {
    await Clipboard.setStringAsync('');
  } catch {
    // Nothing more can be done.
  }
  for (const l of listeners) l();
}

function listen() {
  if (listening) return;
  listening = true;
  AppState.addEventListener('change', (s) => {
    if (s === 'active' && deadline !== null && Date.now() >= deadline) void clearNow();
  });
}

/** Copies `value` and clears the clipboard after KIT_CLIPBOARD_CLEAR_MS. */
export async function copySecret(value: string): Promise<boolean> {
  listen();
  const ok = await Clipboard.setStringAsync(value).catch(() => false);
  if (!ok) return false;
  deadline = Date.now() + KIT_CLIPBOARD_CLEAR_MS;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void clearNow(), KIT_CLIPBOARD_CLEAR_MS);
  return true;
}

/** Called after the clipboard was cleared (to say so). Returns an unsubscribe function. */
export function onClipboardCleared(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
