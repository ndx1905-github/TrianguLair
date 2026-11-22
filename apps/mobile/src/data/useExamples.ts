/**
 * The example places (src/data/demo.ts): are they there, delete them, add them ("Show me with
 * examples" on the first launch). Adding them never touches my document; deleting them removes
 * the example friend from my cache and the 0.9.0-beta.1 seed from my document.
 */
import { useCallback, useMemo, useState } from 'react';

import type { useI18n } from '../i18n';
import { useData, type DataState } from './DataProvider';
import { ALL_FRIENDS, getSelection, setSelection } from '../sync/friendsSelection';
import { DEMO_FRIEND, deleteExamples, hasExamples, seedExamples } from './demo';
import { EXAMPLES_BANNER_KEY, EXAMPLES_WANTED_KEY, exampleOptions } from './examples';
import { getSetting, setSetting } from './deviceSettings';

/** Adds the examples now (store open) and remembers the request otherwise. */
export function requestExamples(data: DataState | null, t: ReturnType<typeof useI18n>['t']): void {
  setSetting(EXAMPLES_WANTED_KEY, '1');
  if (!data) return;
  seedExamples(data.store, exampleOptions(t));
  setSetting(EXAMPLES_WANTED_KEY, 'done');
  data.refresh();
}

export function useExamples() {
  const data = useData();
  const { store, version, mutate } = data;
  const present = useMemo(() => hasExamples(store), [store, version]);
  const [bannerHidden, setBannerHidden] = useState(() => getSetting(EXAMPLES_BANNER_KEY) === 'hidden');
  const remove = useCallback(() => {
    const n = mutate((s) => deleteExamples(s));
    // "See their places" of the example friend left the friends panel on them alone: back to all.
    const sel = getSelection();
    if (sel.mode === 'some' && sel.ids.includes(DEMO_FRIEND.id)) {
      const ids = sel.ids.filter((id) => id !== DEMO_FRIEND.id);
      setSelection(ids.length ? { mode: 'some', ids, me: sel.me } : ALL_FRIENDS);
    }
    return n;
  }, [mutate]);
  const hideBanner = useCallback(() => {
    setSetting(EXAMPLES_BANNER_KEY, 'hidden');
    setBannerHidden(true);
  }, []);
  return { present, bannerHidden, remove, hideBanner };
}
