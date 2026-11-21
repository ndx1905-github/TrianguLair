/**
 * The last pass after the app leaves the foreground (gap #5, spec "Synchronization and background": "the app finishes
 * the synchronization in progress and sends pending changes, within the short grace period the system allows").
 *
 * iOS suspends an app a few seconds after it moves to the background unless it asks for a grace period
 * (`beginBackgroundTask`, about 30 s on current systems; `modules/background-grace`, a local Expo module). This file is
 * the pure part: it asks for the grace period, runs the pass, and always ends the grace period, at the latest when the
 * system says time is up (then the pass is left as it is: the sync engine writes packs first and the index last, so
 * an interrupted pass is resumed at the next launch and loses nothing). Nothing periodic is ever scheduled.
 */

/** The native side (iOS only; null elsewhere). */
export interface GraceNative {
  /** A grace period's id, or 0 when the system refuses one. */
  begin(name: string): Promise<number>;
  end(id: number): Promise<void>;
  /** `listener` is called when the system ends the grace period early. */
  addListener(event: 'onExpire', listener: (e: { id: number }) => void): { remove(): void };
}

export type GraceOutcome = 'done' | 'expired' | 'no-grace';

/**
 * Runs `work` inside a grace period. Resolves when the work ends or the grace period expires, whichever comes first;
 * the work is not cancelled (if the app comes back in time, it simply goes on).
 */
export async function withGrace(native: GraceNative | null, name: string, work: () => Promise<unknown>): Promise<GraceOutcome> {
  if (!native) {
    await work().catch(() => {});
    return 'no-grace';
  }
  let id = 0;
  try {
    id = await native.begin(name);
  } catch {
    id = 0;
  }
  if (!id) {
    await work().catch(() => {});
    return 'no-grace';
  }
  let sub: { remove(): void } | null = null;
  const expired = new Promise<GraceOutcome>((resolve) => {
    sub = native.addListener('onExpire', (e) => {
      if (e.id === id) resolve('expired');
    });
  });
  try {
    return await Promise.race([work().then(
      () => 'done' as const,
      () => 'done' as const,
    ), expired]);
  } finally {
    (sub as { remove(): void } | null)?.remove();
    await native.end(id).catch(() => {});
  }
}
