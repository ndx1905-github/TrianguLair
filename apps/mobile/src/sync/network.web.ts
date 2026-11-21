/** Web (test build): the browser's `online` / `offline` events, as before. */
import type { WatchNetwork } from './netState';

const browserOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false;

export const watchNetwork: WatchNetwork = (onChange) => {
  onChange(browserOnline());
  if (typeof window === 'undefined') return () => {};
  const net = () => onChange(browserOnline());
  window.addEventListener('online', net);
  window.addEventListener('offline', net);
  return () => {
    window.removeEventListener('online', net);
    window.removeEventListener('offline', net);
  };
};
