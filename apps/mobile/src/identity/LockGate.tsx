/**
 * App lock gate (spec "Protections on the device"). The screens stay mounted
 * under the lock (folding, a draft in progress… nothing is lost); an opaque
 * cover hides them when locked and while the app is switching away (so the
 * system's app switcher snapshot shows nothing).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '../components/ui';
import { getSetting, setSetting } from '../data/deviceSettings';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import { useIdentity } from './IdentityProvider';
import {
  defaultLockSettings,
  hashCode,
  isValidCode,
  lockoutMs,
  parseLockSettings,
  shouldLockOnReturn,
  verifyCode,
  type DeviceSecurity,
  type LockSettings,
} from './lock';

export interface AppLockApi {
  settings: LockSettings;
  /** Whether an app code is set. */
  hasCode: boolean;
  security: DeviceSecurity;
  setSettings(s: LockSettings): void;
  setCode(code: string): Promise<void>;
  /** The lock as it applies (a code method without a code does not lock). */
  active: boolean;
}

const LockContext = createContext<AppLockApi | null>(null);

async function detectSecurity(): Promise<DeviceSecurity> {
  if (Platform.OS === 'web') return 'unknown';
  try {
    const level = await LocalAuthentication.getEnrolledLevelAsync();
    if (level === LocalAuthentication.SecurityLevel.NONE) return 'none';
    if (level === LocalAuthentication.SecurityLevel.SECRET) return 'passcode';
    return 'biometric';
  } catch {
    return 'unknown';
  }
}

export function LockProvider({ children }: { children: ReactNode }) {
  const { secrets, state } = useIdentity();
  const [security, setSecurity] = useState<DeviceSecurity>('unknown');
  const [settings, setSettingsState] = useState<LockSettings | null>(() => parseLockSettings(getSetting('lock')));
  const [hasCode, setHasCode] = useState(false);
  const [locked, setLocked] = useState(false);
  const [covered, setCovered] = useState(false);
  const [checked, setChecked] = useState(false);
  const backgroundSince = useRef<number | null>(null);

  useEffect(() => {
    void detectSecurity().then(setSecurity);
  }, []);
  useEffect(() => {
    if (!secrets) return;
    void secrets.get('lock-code').then((c) => {
      setHasCode(c !== null);
      setChecked(true);
    });
  }, [secrets]);

  const effective = settings ?? defaultLockSettings(security);
  const active = effective.enabled && (effective.method === 'device' || hasCode) && state.kind === 'ready';

  // Locked on start once we know whether a code exists.
  const startDone = useRef(false);
  useEffect(() => {
    if (startDone.current || !checked || state.kind !== 'ready') return;
    startDone.current = true;
    if (active) setLocked(true);
  }, [checked, active, state.kind]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') {
        if (active && shouldLockOnReturn(effective, backgroundSince.current, Date.now())) setLocked(true);
        backgroundSince.current = null;
        setCovered(false);
      } else {
        if (backgroundSince.current === null) backgroundSince.current = Date.now();
        if (active && Platform.OS !== 'web') setCovered(true);
      }
    });
    return () => sub.remove();
  }, [active, effective]);

  const api = useMemo<AppLockApi>(
    () => ({
      settings: effective,
      hasCode,
      security,
      active,
      setSettings(s) {
        setSetting('lock', JSON.stringify(s));
        setSettingsState(s);
      },
      async setCode(code) {
        if (!secrets || !isValidCode(code)) throw new Error('invalid code');
        await secrets.set('lock-code', await hashCode(code));
        setHasCode(true);
      },
    }),
    [effective, hasCode, security, active, secrets],
  );

  return (
    <LockContext.Provider value={api}>
      <View style={{ flex: 1 }} importantForAccessibility={locked ? 'no-hide-descendants' : 'auto'} accessibilityElementsHidden={locked}>
        {children}
      </View>
      {(locked || covered) && <LockScreen method={effective.method} coverOnly={!locked} onUnlock={() => setLocked(false)} />}
    </LockContext.Provider>
  );
}

export function useAppLock(): AppLockApi {
  const ctx = useContext(LockContext);
  if (!ctx) throw new Error('useAppLock() outside LockProvider');
  return ctx;
}

function LockScreen({ method, coverOnly, onUnlock }: { method: LockSettings['method']; coverOnly: boolean; onUnlock: () => void }) {
  const c = useUiColors();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const { secrets } = useIdentity();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const failures = Number(getSetting('lock-failures') ?? '0') || 0;
  const lastFailure = Number(getSetting('lock-failed-at') ?? '0') || 0;
  const waitMs = Math.max(0, lastFailure + lockoutMs(failures) - now);

  useEffect(() => {
    if (waitMs <= 0) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [waitMs]);

  const askDevice = useCallback(async () => {
    try {
      const r = await LocalAuthentication.authenticateAsync({ promptMessage: t('lock.prompt'), cancelLabel: t('common.cancel') });
      if (r.success) onUnlock();
      else setError(t('lock.failed'));
    } catch {
      setError(t('lock.failed'));
    }
  }, [onUnlock, t]);

  useEffect(() => {
    if (!coverOnly && method === 'device') void askDevice();
  }, [coverOnly, method, askDevice]);

  const tryCode = async () => {
    if (waitMs > 0 || !secrets) return;
    if (await verifyCode(code, await secrets.get('lock-code'))) {
      setSetting('lock-failures', '0');
      setCode('');
      onUnlock();
      return;
    }
    setSetting('lock-failures', String(failures + 1));
    setSetting('lock-failed-at', String(Date.now()));
    setNow(Date.now());
    setCode('');
    setError(t('lock.wrongCode'));
  };

  return (
    <View
      style={[StyleSheet.absoluteFill, styles.root, { backgroundColor: c.background, paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}
      testID={coverOnly ? 'privacy-cover' : 'lock-screen'}
      accessibilityViewIsModal
    >
      <Text style={[styles.title, { color: c.text }]} accessibilityRole="header" maxFontSizeMultiplier={2}>
        {t('lock.title')}
      </Text>
      {!coverOnly && (
        <View style={styles.body}>
          {method === 'code' ? (
            <>
              <TextInput
                value={code}
                onChangeText={(v) => setCode(v.replace(/\D/g, ''))}
                onSubmitEditing={() => void tryCode()}
                secureTextEntry
                keyboardType="number-pad"
                autoFocus
                maxLength={12}
                placeholder={t('lock.codePlaceholder')}
                placeholderTextColor={c.textMuted}
                style={[styles.input, { color: c.text, borderColor: c.border, backgroundColor: c.surface }]}
                accessibilityLabel={t('lock.codePlaceholder')}
                maxFontSizeMultiplier={2}
                testID="lock-code"
              />
              <Button label={t('lock.unlock')} onPress={() => void tryCode()} disabled={waitMs > 0 || code.length < 4} testID="lock-unlock" />
            </>
          ) : (
            <Button label={t('lock.unlock')} onPress={() => void askDevice()} testID="lock-unlock" />
          )}
          {waitMs > 0 ? (
            <Text style={{ color: c.textMuted, textAlign: 'center' }} maxFontSizeMultiplier={2}>
              {t('lock.wait', { seconds: Math.ceil(waitMs / 1000) })}
            </Text>
          ) : error ? (
            <Text style={{ color: c.danger, textAlign: 'center' }} maxFontSizeMultiplier={2} accessibilityLiveRegion="polite">
              {error}
            </Text>
          ) : null}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { alignItems: 'center', paddingHorizontal: 24, zIndex: 1000, elevation: 1000 },
  title: { fontSize: 22, fontWeight: '700', textAlign: 'center', marginTop: 40 },
  body: { width: '100%', maxWidth: 360, gap: 12, marginTop: 24 },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, fontSize: 20, letterSpacing: 4, textAlign: 'center', minHeight: 48 },
});
