/**
 * Settings: profile, recovery kit, storage (summary; Settings › Storage at /storage), app lock,
 * this device (primary device option) and appearance (theme, language).
 */
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DataGate } from '../components/DataGate';
import { ScreenHeader } from '../components/ScreenHeader';
import { Banner, Button, SectionTitle, Segmented } from '../components/ui';
import { CodeFields, codeProblem, type CodeDraft } from '../firstLaunch/CodeFields';
import { ProfileFields } from '../firstLaunch/ProfileFields';
import { ToggleRow } from '../firstLaunch/ToggleRow';
import { useLayout } from '../hooks/useLayout';
import { useThemeMode, useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import type { Locale } from '../i18n/core';
import { useIdentity, useReadyIdentity, type Profile } from '../identity/IdentityProvider';
import { useAppLock } from '../identity/LockGate';
import { keyFingerprint } from '../identity/kit';
import { LOCK_DELAYS_MS, STALE_SYNC_DAYS, parseClockMark, staleDaysLeft, type StaleSyncSettings } from '../identity/lock';
import { CLOCK_MARK_KEY, deviceName, setStaleSync, staleSync } from '../devices/local';
import { getSetting } from '../data/deviceSettings';
import { useMaybeSync } from '../sync/SyncProvider';
import { protocolOf } from '../storage/config';
import { useStorage } from '../storage/StorageProvider';
import { THEME_MODES, type ThemeMode } from '../theme/themeMode';
import { PhotoSettings } from '../photos/PhotoSettings';
import { MyContentSection } from '../privacy/SettingsSection';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 10 }}>
      <SectionTitle>{title}</SectionTitle>
      {children}
    </View>
  );
}

function Muted({ children, testID }: { children: React.ReactNode; testID?: string }) {
  const c = useUiColors();
  return (
    <Text style={{ color: c.textMuted, fontSize: 14 }} maxFontSizeMultiplier={2} testID={testID}>
      {children}
    </Text>
  );
}

function SettingsScreen() {
  const c = useUiColors();
  const insets = useSafeAreaInsets();
  const { gutter } = useLayout();
  const router = useRouter();
  const tr = useI18n();
  const { t, locale } = tr;
  const identity = useReadyIdentity();
  const { updateProfile, setPrimary } = useIdentity();
  const lock = useAppLock();
  const theme = useThemeMode();
  const storage = useStorage();
  const sync = useMaybeSync();
  const [stale, setStaleState] = useState<StaleSyncSettings | null>(() => staleSync());
  const changeStale = (s: StaleSyncSettings | null) => {
    setStaleSync(s);
    setStaleState(s);
  };

  const [profile, setProfile] = useState<Profile>(identity.profile);
  useEffect(() => setProfile(identity.profile), [identity.profile]);
  const profileChanged = profile.name !== identity.profile.name || profile.avatar !== identity.profile.avatar;

  const [codeOpen, setCodeOpen] = useState(false);
  const [code, setCode] = useState<CodeDraft>({ code: '', again: '' });
  const [codeTried, setCodeTried] = useState(false);
  const [codeSaved, setCodeSaved] = useState(false);

  const [primaryPhrase, setPrimaryPhrase] = useState('');
  const [primaryAsk, setPrimaryAsk] = useState(false);
  const [primaryError, setPrimaryError] = useState(false);

  const saveCode = async () => {
    setCodeTried(true);
    if (codeProblem(code)) return;
    await lock.setCode(code.code);
    setCode({ code: '', again: '' });
    setCodeOpen(false);
    setCodeTried(false);
    setCodeSaved(true);
  };

  const togglePrimary = async (on: boolean) => {
    setPrimaryError(false);
    if (!on) return setPrimary(false);
    try {
      await setPrimary(true);
    } catch {
      setPrimaryAsk(true); // the phrase is no longer on the device: type it
    }
  };
  const confirmPrimary = async () => {
    try {
      await setPrimary(true, primaryPhrase);
      setPrimaryAsk(false);
      setPrimaryPhrase('');
    } catch {
      setPrimaryError(true);
    }
  };

  const date = (ms: number) => new Date(ms).toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' });
  const deviceMethodOk = lock.security === 'passcode' || lock.security === 'biometric';

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ScreenHeader title={t('settings.title')} onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
      <ScrollView
        contentContainerStyle={{ paddingLeft: gutter + insets.left, paddingRight: gutter + insets.right, paddingBottom: insets.bottom + 32, alignItems: 'center' }}
        keyboardShouldPersistTaps="handled"
        testID="settings"
      >
        <View style={styles.column}>
          <Section title={t('settings.profile')}>
            <ProfileFields value={profile} onChange={setProfile} />
            {profileChanged && <Button label={t('common.save')} onPress={() => updateProfile({ name: profile.name.trim(), avatar: profile.avatar })} testID="profile-save" />}
          </Section>

          <Section title={t('settings.kit')}>
            {identity.kitPending ? (
              <>
                <Muted>{t('settings.kitPending')}</Muted>
                <Button label={t('protect.kit')} onPress={() => router.push('/kit')} testID="settings-kit" />
              </>
            ) : (
              <Muted testID="settings-kit-saved">
                {identity.record.kitSavedAt ? t('kit.saved', { date: date(identity.record.kitSavedAt) }) : t('kit.gone')}
              </Muted>
            )}
          </Section>

          <Section title={t('settings.storage')}>
            {storage.state.current ? (
              <>
                <Muted testID="settings-storage-current">{t('settings.storageConnected', { protocol: t(`storage.protocol.${protocolOf(storage.state.current)}`) })}</Muted>
                <Muted>{storage.state.current.readUrl}</Muted>
              </>
            ) : (
              <>
                <Muted>{t('settings.storageLocal')}</Muted>
                <Muted>{t('kit.localOnlyNote')}</Muted>
              </>
            )}
            <Button kind="secondary" label={t('settings.storageOpen')} onPress={() => router.push('/storage')} testID="settings-storage" />
            <Muted>{t('sync.settingsHelp')}</Muted>
            <Button kind="secondary" label={t('sync.settingsRow')} onPress={() => router.push('/sync')} testID="settings-sync" />
          </Section>

          <Section title={t('settings.friends')}>
            <Muted>{t('settings.friendsHelp')}</Muted>
            <Button label={t('inviting.title')} onPress={() => router.push('/invite')} testID="settings-invite" />
            <Button kind="secondary" label={t('contacts.open')} onPress={() => router.push('/contacts')} testID="settings-contacts" />
          </Section>

          <Section title={t('settings.lock')}>
            {lock.security === 'none' && !lock.settings.enabled && <Banner tone="warning">{t('settings.lockNoScreenLock')}</Banner>}
            <ToggleRow
              label={t('settings.lockOn')}
              value={lock.settings.enabled}
              onChange={(enabled) => {
                lock.setSettings({ ...lock.settings, enabled });
                if (enabled && lock.settings.method === 'code' && !lock.hasCode) setCodeOpen(true);
              }}
              testID="settings-lock"
            />
            {lock.settings.enabled && (
              <>
                {deviceMethodOk && (
                  <>
                    <Muted>{t('settings.lockMethod')}</Muted>
                    <Segmented
                      options={[
                        { value: 'device' as const, label: t('settings.lockMethodDevice') },
                        { value: 'code' as const, label: t('settings.lockMethodCode') },
                      ]}
                      value={lock.settings.method}
                      onChange={(method) => {
                        lock.setSettings({ ...lock.settings, method });
                        if (method === 'code' && !lock.hasCode) setCodeOpen(true);
                      }}
                      testID="settings-lock-method"
                    />
                  </>
                )}
                {lock.settings.method === 'code' && !lock.hasCode && <Banner tone="warning">{t('settings.lockNeedsCode')}</Banner>}
                <Muted>{t('settings.lockDelay')}</Muted>
                <Segmented
                  options={LOCK_DELAYS_MS.map((ms) => ({ value: ms as number, label: t(`settings.delay.${ms}`) }))}
                  value={lock.settings.delayMs}
                  onChange={(delayMs) => lock.setSettings({ ...lock.settings, delayMs })}
                  testID="settings-lock-delay"
                />
              </>
            )}
            {(lock.settings.method === 'code' || !deviceMethodOk) &&
              (codeOpen ? (
                <>
                  <CodeFields value={code} onChange={setCode} showErrors={codeTried} />
                  <View style={styles.row}>
                    <Button label={t('common.save')} onPress={() => void saveCode()} testID="code-save" />
                    <Button kind="secondary" label={t('common.cancel')} onPress={() => setCodeOpen(false)} />
                  </View>
                </>
              ) : (
                <Button
                  kind="secondary"
                  label={lock.hasCode ? t('settings.lockChangeCode') : t('settings.lockSetCode')}
                  onPress={() => {
                    setCodeSaved(false);
                    setCodeOpen(true);
                  }}
                  testID="code-open"
                />
              ))}
            {codeSaved && <Muted>{t('settings.lockCodeSaved')}</Muted>}
            <Muted>{t('settings.staleTitle')}</Muted>
            <Segmented
              options={[{ value: 0, label: t('settings.staleOff') }, ...STALE_SYNC_DAYS.map((d) => ({ value: d as number, label: t('settings.staleDays', { count: d }) }))]}
              value={stale?.days ?? 0}
              onChange={(days: number) => changeStale(days ? { days, wipe: stale?.wipe ?? false, since: stale?.since ?? Date.now() } : null)}
              testID="settings-stale"
            />
            {stale && (
              <>
                <ToggleRow label={t('settings.staleWipe')} value={stale.wipe} onChange={(wipe) => changeStale({ ...stale, wipe })} testID="settings-stale-wipe" />
                <Muted testID="settings-stale-left">{t('settings.staleLeft', { count: staleDaysLeft(stale, sync?.snapshot?.lastOwnSuccess ?? null, Date.now(), parseClockMark(getSetting(CLOCK_MARK_KEY))) })}</Muted>
              </>
            )}
            <Muted>{t('settings.staleHelp')}</Muted>
          </Section>

          <Section title={t('settings.device')}>
            <Muted testID="settings-device-name">{t('settings.deviceName', { name: deviceName() })}</Muted>
            <Muted>{t('settings.deviceAdded', { date: date(identity.record.createdAt) })}</Muted>
            <Muted testID="settings-owner">{t('settings.ownerKey', { fingerprint: keyFingerprint(identity.record.owner) })}</Muted>
            <Muted>{t('settings.deviceKey', { fingerprint: keyFingerprint(identity.record.deviceId) })}</Muted>
            <ToggleRow
              label={t('settings.primary')}
              help={identity.record.primary ? t('settings.primaryHelp') : t('settings.primaryOffHelp')}
              value={identity.record.primary}
              onChange={(on) => void togglePrimary(on)}
              testID="settings-primary"
            />
            {primaryAsk && !identity.record.primary && (
              <View style={{ gap: 8 }}>
                <Muted>{t('settings.primaryNeedsPhrase')}</Muted>
                <TextInput
                  value={primaryPhrase}
                  onChangeText={setPrimaryPhrase}
                  autoCapitalize="none"
                  autoCorrect={false}
                  spellCheck={false}
                  autoComplete="off"
                  multiline
                  style={[styles.input, { color: c.text, borderColor: primaryError ? c.danger : c.border, backgroundColor: c.surface }]}
                  accessibilityLabel={t('settings.primaryPhrase')}
                  maxFontSizeMultiplier={2}
                />
                {primaryError && (
                  <Text style={{ color: c.danger }} maxFontSizeMultiplier={2}>
                    {t('settings.primaryMismatch')}
                  </Text>
                )}
                <Button label={t('settings.primaryConfirm')} onPress={() => void confirmPrimary()} disabled={primaryPhrase.trim().split(/\s+/).length !== 12} />
              </View>
            )}
            <Muted testID="settings-secrets">{t(`settings.secrets.${identity.secretStore}`)}</Muted>
            <Muted>{t('settings.devicesHelp')}</Muted>
            <Button kind="secondary" label={t('settings.devices')} onPress={() => router.push('/devices')} testID="settings-devices" />
          </Section>

          <PhotoSettings />
          <MyContentSection />

          <Section title={t('settings.appearance')}>
            <Muted>{t('settings.theme')}</Muted>
            <Segmented
              options={THEME_MODES.map((m) => ({ value: m, label: t(`theme.${m}`) }))}
              value={theme.mode}
              onChange={(m: ThemeMode) => theme.setMode(m)}
              testID="settings-theme"
            />
            <Muted>{t('settings.language')}</Muted>
            <Segmented
              options={(['auto', 'en', 'fr'] as const).map((l) => ({ value: l, label: t(`settings.lang.${l}`) }))}
              value={tr.chosen ?? 'auto'}
              onChange={(l) => tr.choose(l === 'auto' ? null : (l as Locale))}
              testID="settings-language"
            />
          </Section>
        </View>
      </ScrollView>
    </View>
  );
}

export default function SettingsRoute() {
  return (
    <DataGate>
      <SettingsScreen />
    </DataGate>
  );
}

const styles = StyleSheet.create({
  column: { width: '100%', maxWidth: 640, gap: 8 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, fontSize: 16, minHeight: 72, textAlignVertical: 'top' },
});
