/**
 * The photos service of the sync engine (T-111b) for the screens, and the image of one photo as a
 * data URI (fetched when needed: a friend's full photo is downloaded only when it is shown).
 */
import { useEffect, useState } from 'react';
import type { Photos } from '@triangulair/sync';

import { useMaybeSync } from '../sync/SyncProvider';
import { dataUri } from './model';

export function usePhotosService(): Photos | null {
  const sync = useMaybeSync();
  const ctl = sync?.controller() ?? null;
  const [svc, setSvc] = useState<Photos | null>(null);
  useEffect(() => {
    let alive = true;
    if (!ctl) return;
    void ctl
      .photos()
      .then((p) => alive && setSvc(p))
      .catch(() => alive && setSvc(null));
    return () => {
      alive = false;
    };
  }, [ctl, sync?.snapshot?.ready]);
  return svc;
}

export type ImageState = { kind: 'loading' } | { kind: 'ready'; uri: string } | { kind: 'missing' } | { kind: 'error' };

/** `key` changes when the photo may have become available (a sync pass, an upload). */
export function usePhotoImage(svc: Photos | null, mediaId: string | null, which: 'thumb' | 'full', key: unknown = 0): ImageState {
  const [state, setState] = useState<ImageState>({ kind: 'loading' });
  useEffect(() => {
    let alive = true;
    if (!svc || !mediaId) return;
    setState((s) => (s.kind === 'ready' ? s : { kind: 'loading' }));
    (which === 'full' ? svc.full(mediaId) : svc.thumbnail(mediaId))
      .then((img) => {
        if (!alive) return;
        setState(img ? { kind: 'ready', uri: dataUri(img.bytes, img.mime) } : { kind: 'missing' });
      })
      .catch(() => alive && setState({ kind: 'error' }));
    return () => {
      alive = false;
    };
  }, [svc, mediaId, which, key]);
  return state;
}
