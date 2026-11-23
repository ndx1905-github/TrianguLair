/**
 * Monthly closed-place check while the app is open (T-113): a run when the
 * map opens, when the app returns to the foreground, and from time to time
 * while it stays open (a browser tab left open for days) — at most every few
 * hours — aborted as soon as the app leaves the foreground. Never in the
 * background (spec "Synchronization and background"). Each run checks the
 * places due (last check over a month old, never-checked first), so every
 * saved OSM place is checked again about once a month. Places newly found
 * "maybe closed" go to What's new (`events.ts`); then the grouped notice, at
 * most once a month.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { useData } from '../data/DataProvider';
import { getSetting, setSetting } from '../data/deviceSettings';
import { osmClient } from '../osm/client';
import { classifyOsmError } from '../osm/errors';
import { LAST_NOTICE_KEY, noticeFor, RUN_EVERY_MS } from './glue';
import { runDueChecks } from './run';

export interface ClosureNoticeState {
  places: { id: string; name: string }[];
}

const LAST_RUN_KEY = 'closure-last-run';
/** While the app stays in the foreground, look again this often (a run still waits RUN_EVERY_MS). */
const TICK_MS = 3600_000;

export function useClosureCheck(): { notice: ClosureNoticeState | null; dismiss: () => void } {
  const { repo, mutate } = useData();
  const [notice, setNotice] = useState<ClosureNoticeState | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  const repoRef = useRef(repo);
  repoRef.current = repo;
  const mutateRef = useRef(mutate);
  mutateRef.current = mutate;

  const evaluateNotice = useCallback(() => {
    const now = new Date();
    const maybe = repoRef.current
      .queryPlaces({ source: 'mine', limit: 100_000 })
      .filter((h) => h.status === 'maybe_closed')
      .map((h) => ({ id: h.id, name: h.name }));
    const n = noticeFor(maybe, getSetting(LAST_NOTICE_KEY), now);
    if (n) {
      setSetting(LAST_NOTICE_KEY, now.toISOString());
      setNotice(n);
    }
  }, []);

  const run = useCallback(async () => {
    const last = Number(getSetting(LAST_RUN_KEY) ?? 0);
    if (ctrl.current || (Number.isFinite(last) && Date.now() - last < RUN_EVERY_MS)) {
      evaluateNotice();
      return;
    }
    const c = new AbortController();
    ctrl.current = c;
    try {
      await runDueChecks(repoRef.current, osmClient(), mutateRef.current, c.signal);
      if (!c.signal.aborted) setSetting(LAST_RUN_KEY, String(Date.now()));
    } catch (e) {
      // Offline or services busy: try again next time the app opens.
      if (classifyOsmError(e) !== 'aborted') console.warn('closed-place check skipped', e);
    } finally {
      if (ctrl.current === c) ctrl.current = null;
    }
    if (!c.signal.aborted) evaluateNotice();
  }, [evaluateNotice]);

  useEffect(() => {
    void run();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void run();
      else {
        ctrl.current?.abort();
        ctrl.current = null;
      }
    });
    const tick = setInterval(() => {
      if (AppState.currentState === 'active') void run();
    }, TICK_MS);
    return () => {
      clearInterval(tick);
      sub.remove();
      ctrl.current?.abort();
      ctrl.current = null;
    };
  }, [run]);

  return { notice, dismiss: useCallback(() => setNotice(null), []) };
}
