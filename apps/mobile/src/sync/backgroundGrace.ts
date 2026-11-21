/**
 * The app's entry to the grace period (see `grace.ts`): the local Expo module `BackgroundGrace`
 * (`modules/background-grace`, iOS only). Android has no such module: an Android process keeps running for a while
 * after its activity stops, and the pass usually ends in time; web has no background at all.
 */
import { requireOptionalNativeModule } from 'expo';

import { withGrace, type GraceNative, type GraceOutcome } from './grace';

let native: GraceNative | null | undefined;

function graceModule(): GraceNative | null {
  if (native === undefined) {
    try {
      native = requireOptionalNativeModule<GraceNative>('BackgroundGrace');
    } catch {
      native = null;
    }
  }
  return native;
}

/** Runs the last pass within the grace period the system allows. */
export function inBackgroundGrace(work: () => Promise<unknown>): Promise<GraceOutcome> {
  return withGrace(graceModule(), 'triangulair-last-sync', work);
}
