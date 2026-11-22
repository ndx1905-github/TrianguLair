/**
 * The app's entry to the position: `locateMe()`, once, when asked (first launch, "center on me").
 * Metro picks `backend.android.ts` on Android and `backend.ts` on iOS and web.
 */
import { backend } from './backend';
import { locate, type LocateResult } from './locate';

export type { Fix, LocateFailure, LocateResult } from './locate';
export { zoomForFix } from './locate';

export function locateMe(): Promise<LocateResult> {
  return locate(backend);
}
