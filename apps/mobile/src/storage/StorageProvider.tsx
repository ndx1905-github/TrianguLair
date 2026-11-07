/**
 * My storage settings for the screens and, later, the sync engine (`access`, see interfaces.ts).
 * The whole state (with credentials) is one secret-store entry; nothing goes to plain settings.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { useIdentity } from '../identity/IdentityProvider';
import type { MasterKeySource, RotationResult } from './certify';
import type { StorageConfig } from './config';
import { readAdapter, writeAdapter } from './adapters';
import { storageMoveHooks, type OpenInvitationSummary, type StorageAccess } from './interfaces';
import { REDIRECT_KEEP_MS } from './migration';
import { LOCAL_ONLY, afterMove, parseStorageState, recoverPendingMove, serializeStorageState, type StorageState } from './state';

export interface SwitchResult {
  rotation: RotationResult;
  /** Invitations the new certificate cancelled (from the sync engine; none before it exists). */
  cancelled: OpenInvitationSummary[];
  /** The index (and redirect) were published now; false: the sync engine does it on its next run. */
  published: boolean;
}

export interface StorageApi {
  loaded: boolean;
  state: StorageState;
  /**
   * Makes `to` my storage: certifies its read address (rotation + 1, master key), records the
   * old storage as a redirect, then asks the sync engine to publish. Used for the first storage too.
   */
  switchTo(to: StorageConfig, master: MasterKeySource): Promise<SwitchResult>;
  /** New credentials or probe result for the current storage, same read address (no new certificate). */
  updateCurrent(config: StorageConfig): Promise<void>;
  markTested(at: number): Promise<void>;
  /** Forget a previous storage (after its redirect period). */
  forgetPrevious(readUrl: string): Promise<void>;
  /** The wizard's tested config waiting for the move screen (memory only). */
  draft: StorageConfig | null;
  setDraft(c: StorageConfig | null): void;
  access: StorageAccess;
}

const StorageContext = createContext<StorageApi | null>(null);

export function StorageProvider({ children }: { children: ReactNode }) {
  const identity = useIdentity();
  const { secrets } = identity;
  const ready = identity.state.kind === 'ready';
  const [state, setState] = useState<StorageState>(LOCAL_ONLY);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState<StorageConfig | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const identityRef = useRef(identity);
  identityRef.current = identity;

  const save = useCallback(
    async (next: StorageState) => {
      if (!secrets) throw new Error('storage: secret store not open');
      await secrets.set('storage', serializeStorageState(next));
      stateRef.current = next;
      setState(next);
    },
    [secrets],
  );

  useEffect(() => {
    if (!secrets || !ready) return;
    let cancelled = false;
    (async () => {
      let s = parseStorageState(await secrets.get('storage'));
      if (s.pendingMove) {
        const cert = await identityRef.current.currentSharingCert().catch(() => null);
        s = recoverPendingMove(s, cert?.location, Date.now(), REDIRECT_KEEP_MS);
        await secrets.set('storage', serializeStorageState(s));
      }
      if (cancelled) return;
      stateRef.current = s;
      setState(s);
      setLoaded(true);
    })().catch((e: unknown) => {
      console.error('Could not load the storage settings', e);
      if (!cancelled) setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [secrets, ready]);

  const switchTo = useCallback(
    async (to: StorageConfig, master: MasterKeySource): Promise<SwitchResult> => {
      const before = stateRef.current;
      // 1. Remember the move first: a crash after the certificate is finished on the next start.
      await save({ ...before, pendingMove: { to, startedAt: Date.now() } });
      let rotation: RotationResult;
      try {
        rotation = await identityRef.current.rotateSharingCert({ location: to.readUrl }, master);
      } catch (e) {
        await save({ ...before, pendingMove: null });
        throw e;
      }
      // 2. The new address is certified: switch.
      const next = afterMove(stateRef.current, to, Date.now(), REDIRECT_KEEP_MS);
      await save(next);
      // 3. Publish the index with the new certificate here and as the redirect at the old storages.
      const hooks = storageMoveHooks();
      let published = false;
      let cancelled: OpenInvitationSummary[] = [];
      if (hooks) {
        cancelled = await hooks.openInvitations(rotation.previous).catch(() => []);
        try {
          await hooks.publishAfterMove({ cert: rotation.cert, to: writeAdapter(to), redirects: next.previous.map((p) => writeAdapter(p.config)) });
          await save({ ...stateRef.current, republishPending: false });
          published = true;
        } catch (e) {
          console.warn('Publishing after the move failed; the sync engine retries', e);
        }
      }
      return { rotation, cancelled, published };
    },
    [save],
  );

  const api = useMemo<StorageApi>(() => {
    const access: StorageAccess = {
      config: () => stateRef.current.current,
      writeAdapter: () => (stateRef.current.current ? writeAdapter(stateRef.current.current) : null),
      readAdapter: () => (stateRef.current.current ? readAdapter(stateRef.current.current) : null),
      readAddress: () => stateRef.current.current?.readUrl ?? null,
      redirects: () => stateRef.current.previous.map((p) => ({ config: p.config, adapter: writeAdapter(p.config), keepUntil: p.keepUntil })),
      republishPending: () => stateRef.current.republishPending,
      markRepublished: () => save({ ...stateRef.current, republishPending: false }),
    };
    return {
      loaded,
      state,
      switchTo,
      async updateCurrent(config) {
        const cur = stateRef.current.current;
        if (!cur || cur.readUrl !== config.readUrl) throw new Error('storage: the read address changed, use switchTo');
        await save({ ...stateRef.current, current: config, lastTestAt: Date.now() });
      },
      async markTested(at) {
        await save({ ...stateRef.current, lastTestAt: at });
      },
      async forgetPrevious(readUrl) {
        await save({ ...stateRef.current, previous: stateRef.current.previous.filter((p) => p.config.readUrl !== readUrl) });
      },
      draft,
      setDraft,
      access,
    };
  }, [loaded, state, switchTo, save, draft]);

  return <StorageContext.Provider value={api}>{children}</StorageContext.Provider>;
}

export function useStorage(): StorageApi {
  const ctx = useContext(StorageContext);
  if (!ctx) throw new Error('useStorage() outside StorageProvider');
  return ctx;
}
