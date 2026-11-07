/**
 * My identity on this device: loads it from the secret store on start,
 * creates it on first launch, and keeps the phrase only until the recovery
 * kit is confirmed. Secrets never go into React state; screens read the
 * phrase through `readPendingPhrase()` when they show it.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';
import { fromB64Url, openSharingKey, ready, type SharingCert } from '@triangulair/crypto';

import { OSM_FIXTURES } from '../config';
import { getSetting, setSetting } from '../data/deviceSettings';
import { rotateStoredSharingKey, type CertChange, type MasterKeySource, type RotationResult, type SharingCertRotation } from '../storage/certify';
import { checkStoredIdentity, createIdentity, parseDeviceKeys, parseIdentityRecord, primaryFromPhrase, type CreatedIdentity, type IdentityRecord } from './create';
import { openSecretStore, type SecretStore } from './secretStore';

export interface Profile {
  name: string;
  /** data: URI of a small square JPEG, or null. */
  avatar: string | null;
}

export type OnboardingStep = 'lock' | 'location' | 'import' | 'done';

export type IdentityState =
  | { kind: 'loading' }
  | { kind: 'none'; secretStore: SecretStore['kind'] }
  | { kind: 'error'; error: unknown }
  | {
      kind: 'ready';
      record: IdentityRecord;
      profile: Profile;
      secretStore: SecretStore['kind'];
      /** The phrase is still on this device, waiting for the recovery kit. */
      kitPending: boolean;
      onboarding: OnboardingStep;
    };

export interface IdentityApi extends SharingCertRotation {
  state: IdentityState;
  /** Starts creating the keys in the background (profile screen). Idempotent; resolves when they are ready. */
  prepare(): Promise<void>;
  /** Stores the prepared identity with the profile. */
  create(profile: Profile): Promise<void>;
  updateProfile(profile: Profile): void;
  setOnboarding(step: OnboardingStep): void;
  /** The phrase while the kit is pending, else null. */
  readPendingPhrase(): Promise<string | null>;
  /** The words were checked: forget the phrase on this device. */
  confirmKit(): Promise<void>;
  /** Primary device on/off. Turning it on needs the phrase (pending one, or typed). Throws "phrase-mismatch". */
  setPrimary(on: boolean, typedPhrase?: string): Promise<void>;
  secrets: SecretStore | null;
  /** Checks typed words against my identity (master key prompts). */
  checkPhrase(phrase: string): Promise<boolean>;
}

const IdentityContext = createContext<IdentityApi | null>(null);

const PROFILE_KEY = 'profile';
const ONBOARDING_KEY = 'onboarding';

function readProfile(): Profile {
  try {
    const o = JSON.parse(getSetting(PROFILE_KEY) ?? 'null') as Partial<Profile> | null;
    return { name: typeof o?.name === 'string' ? o.name : '', avatar: typeof o?.avatar === 'string' ? o.avatar : null };
  } catch {
    return { name: '', avatar: null };
  }
}

function readOnboarding(): OnboardingStep {
  const v = getSetting(ONBOARDING_KEY);
  return v === 'lock' || v === 'location' || v === 'import' ? v : 'done';
}

/** Web test builds in fixture mode: `?autostart=1[&name=…]` skips the first launch (screenshots, end-to-end tests). */
function autostartName(): string | null {
  if (Platform.OS !== 'web' || !OSM_FIXTURES || typeof window === 'undefined') return null;
  try {
    const q = new URLSearchParams(window.location.search);
    return q.get('autostart') === '1' ? (q.get('name') ?? 'Alex') : null;
  } catch {
    return null;
  }
}

async function persist(store: SecretStore, created: CreatedIdentity): Promise<void> {
  await store.set('device-keys', created.secrets.deviceKeys);
  await store.set('sharing-key', created.secrets.sharingKey);
  if (created.secrets.primaryIdentity) await store.set('primary-identity', created.secrets.primaryIdentity);
  await store.set('pending-phrase', created.phrase);
  // Written last: an interrupted first launch leaves no half identity behind.
  await store.set('identity', JSON.stringify(created.record));
}

export function IdentityProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<IdentityState>({ kind: 'loading' });
  const [secrets, setSecrets] = useState<SecretStore | null>(null);
  const prepared = useRef<Promise<CreatedIdentity> | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const store = await openSecretStore();
      await ready();
      let record = parseIdentityRecord(await store.get('identity'));
      if (!record) {
        const auto = autostartName();
        if (auto !== null) {
          const created = createIdentity({ primary: true });
          await persist(store, created);
          setSetting(PROFILE_KEY, JSON.stringify({ name: auto, avatar: null }));
          setSetting(ONBOARDING_KEY, 'done');
          setSetting('hint-add', 'seen');
          setSetting('protect-snoozed', String(Date.now()));
          record = created.record;
        }
      }
      if (cancelled) return;
      setSecrets(store);
      if (!record) {
        setState({ kind: 'none', secretStore: store.kind });
        return;
      }
      const [deviceKeys, sharingKey, primaryIdentity, pending] = await Promise.all([
        store.get('device-keys'),
        store.get('sharing-key'),
        store.get('primary-identity'),
        store.get('pending-phrase'),
      ]);
      if (!deviceKeys || !sharingKey) throw new Error('identity: device keys are missing');
      checkStoredIdentity(record, { deviceKeys, sharingKey, primaryIdentity });
      if (cancelled) return;
      setState({
        kind: 'ready',
        record: { ...record, primary: !!primaryIdentity },
        profile: readProfile(),
        secretStore: store.kind,
        kitPending: pending !== null,
        onboarding: readOnboarding(),
      });
    })().catch((error: unknown) => {
      console.error('Could not load the identity', error);
      if (!cancelled) setState({ kind: 'error', error });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const prepare = useCallback((): Promise<void> => {
    if (prepared.current) return prepared.current.then(() => undefined);
    // Next tick: the profile screen renders first, the keys are made meanwhile.
    prepared.current = ready().then(
      () => new Promise<CreatedIdentity>((resolve, reject) => setTimeout(() => {
        try {
          // Primary device by default: the first device keeps the master key, so adding the next
          // device by QR code (the spec's default way) works without typing the 12 words.
          resolve(createIdentity({ primary: true }));
        } catch (e) {
          reject(e);
        }
      }, 0)),
    );
    const p = prepared.current;
    p.catch(() => {
      if (prepared.current === p) prepared.current = null;
    });
    return p.then(() => undefined);
  }, []);

  const create = useCallback(
    async (profile: Profile) => {
      if (!secrets) throw new Error('identity: secret store not open');
      if (!prepared.current) void prepare().catch(() => {});
      const created = await prepared.current!;
      await persist(secrets, created);
      prepared.current = null;
      setSetting(PROFILE_KEY, JSON.stringify(profile));
      setSetting(ONBOARDING_KEY, 'lock');
      setState({ kind: 'ready', record: created.record, profile, secretStore: secrets.kind, kitPending: true, onboarding: 'lock' });
    },
    [secrets, prepare],
  );

  const updateRecord = useCallback(
    async (patch: Partial<IdentityRecord>, extra: Partial<Extract<IdentityState, { kind: 'ready' }>> = {}) => {
      const s = stateRef.current;
      if (!secrets || s.kind !== 'ready') return;
      const next: IdentityRecord = { ...s.record, ...patch };
      await secrets.set('identity', JSON.stringify(next));
      setState((cur) => (cur.kind === 'ready' ? { ...cur, ...extra, record: next } : cur));
    },
    [secrets],
  );

  const api = useMemo<IdentityApi>(
    () => ({
      state,
      secrets,
      prepare,
      create,
      updateProfile(profile) {
        setSetting(PROFILE_KEY, JSON.stringify(profile));
        setState((s) => (s.kind === 'ready' ? { ...s, profile } : s));
      },
      setOnboarding(step) {
        setSetting(ONBOARDING_KEY, step);
        setState((s) => (s.kind === 'ready' ? { ...s, onboarding: step } : s));
      },
      async readPendingPhrase() {
        return secrets ? secrets.get('pending-phrase') : null;
      },
      async confirmKit() {
        if (!secrets) return;
        await secrets.remove('pending-phrase');
        await updateRecord({ kitSavedAt: Date.now() }, { kitPending: false });
      },
      async setPrimary(on, typedPhrase) {
        if (!secrets || state.kind !== 'ready') return;
        if (!on) {
          await secrets.remove('primary-identity');
          await updateRecord({ primary: false });
          return;
        }
        const phrase = typedPhrase ?? (await secrets.get('pending-phrase'));
        if (!phrase) throw new Error('phrase-needed');
        await ready();
        await secrets.set('primary-identity', primaryFromPhrase(phrase, state.record.owner));
        await updateRecord({ primary: true });
      },
      async currentSharingCert(): Promise<SharingCert> {
        if (!secrets || state.kind !== 'ready') throw new Error('identity not ready');
        const [deviceKeys, sharingKey] = await Promise.all([secrets.get('device-keys'), secrets.get('sharing-key')]);
        if (!deviceKeys || !sharingKey) throw new Error('identity: device keys are missing');
        await ready();
        return openSharingKey(fromB64Url(sharingKey, 'sharingKey'), parseDeviceKeys(deviceKeys), { expectedOwner: state.record.owner }).cert;
      },
      async rotateSharingCert(change: CertChange, master: MasterKeySource): Promise<RotationResult> {
        if (!secrets || state.kind !== 'ready') throw new Error('identity not ready');
        const [deviceKeys, sharingKey, primaryIdentity] = await Promise.all([secrets.get('device-keys'), secrets.get('sharing-key'), secrets.get('primary-identity')]);
        if (!deviceKeys || !sharingKey) throw new Error('identity: device keys are missing');
        await ready();
        const result = rotateStoredSharingKey(state.record, { deviceKeys, sharingKey, primaryIdentity }, change, master);
        // Other devices and the recovery vault get the new key from the sync engine (T-204/T-206).
        await secrets.set('sharing-key', result.sealedForThisDevice);
        return result;
      },
      async checkPhrase(phrase: string): Promise<boolean> {
        if (state.kind !== 'ready') return false;
        await ready();
        try {
          primaryFromPhrase(phrase.trim().toLowerCase().split(/\s+/).join(' '), state.record.owner);
          return true;
        } catch {
          return false;
        }
      },
    }),
    [state, secrets, prepare, create, updateRecord],
  );

  return <IdentityContext.Provider value={api}>{children}</IdentityContext.Provider>;
}

export function useIdentity(): IdentityApi {
  const ctx = useContext(IdentityContext);
  if (!ctx) throw new Error('useIdentity() outside IdentityProvider');
  return ctx;
}

/** My identity record; only below a screen that checked the identity is ready. */
export function useReadyIdentity(): Extract<IdentityState, { kind: 'ready' }> {
  const { state } = useIdentity();
  if (state.kind !== 'ready') throw new Error('identity not ready');
  return state;
}
