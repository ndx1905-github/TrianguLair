/**
 * Settings › Devices (spec "Adding a device": "Each device appears in the settings (name, date
 * added), and can be removed"; T-206, T-207): my devices as listed in the recovery vault (every
 * device of mine sees the same list), this device and the primary one marked, rename, remove,
 * declare one lost, and the identity change when the primary device itself is gone.
 */
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useRouter, type Href } from 'expo-router';

import { DataGate } from '../../components/DataGate';
import { Button } from '../../components/ui';
import { Card } from '../../contacts/ui';
import { setDeviceName } from '../../devices/local';
import { useUiColors } from '../../hooks/useUiColors';
import { useI18n } from '../../i18n';
import { useReadyIdentity } from '../../identity/IdentityProvider';
import { Field, Muted, Section, StorageScreen } from '../../storage/components';
import { useStorage } from '../../storage/StorageProvider';
import { StorageNeeded } from '../../storage/useStorageForSharing';
import { useSync } from '../../sync/SyncProvider';

function Badge({ label, testID }: { label: string; testID?: string }) {
  const c = useUiColors();
  return (
    <View style={[styles.badge, { borderColor: c.accent, backgroundColor: c.selectedBg }]} testID={testID}>
      <Text style={{ color: c.text, fontSize: 12, fontWeight: '700' }} maxFontSizeMultiplier={2}>
        {label}
      </Text>
    </View>
  );
}

function DevicesScreen() {
  const { t, locale } = useI18n();
  const c = useUiColors();
  const router = useRouter();
  const identity = useReadyIdentity();
  const storage = useStorage();
  const sync = useSync();
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const date = (ms: number) => new Date(ms).toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' });
  void sync.snapshot; // redraw after each pass
  const me = identity.record.deviceId;
  const devices = sync.devices();
  const live = devices.filter((d) => d.removed === undefined);
  const removed = devices.filter((d) => d.removed !== undefined);
  const hasStorage = !!storage.state.current && storage.state.current.kind !== 'https';

  const save = async (id: string) => {
    const n = name.trim();
    if (!n) return;
    if (id === me) setDeviceName(n);
    await sync.renameDevice(id, n);
    setEditing(null);
  };

  return (
    <StorageScreen title={t('devices.title')} testID="devices-screen">
      <Muted>{t('devices.help')}</Muted>
      {!hasStorage ? (
        <StorageNeeded reason="devices" returnTo="/devices" />
      ) : (
        <>
          {devices.length === 0 && <Muted testID="devices-none">{t('devices.none')}</Muted>}
          {live.map((d) => {
            const id = d.cert.device;
            const mine = id === me;
            const shown = d.name || t('devices.unnamed');
            return (
              <Card key={id} testID={`device-${mine ? 'me' : 'other'}`}>
                <View style={styles.head}>
                  <Text style={{ color: c.text, fontSize: 17, fontWeight: '700', flexShrink: 1 }} maxFontSizeMultiplier={2} testID="device-row-name">
                    {shown}
                  </Text>
                  {mine && <Badge label={t('devices.thisDevice')} testID="device-badge-me" />}
                  {d.primary && <Badge label={t('devices.primary')} testID="device-badge-primary" />}
                </View>
                {d.added > 0 && <Muted>{t('devices.added', { date: date(d.added) })}</Muted>}
                {editing === id ? (
                  <>
                    <Field label={t('devices.nameLabel')} value={name} onChange={setName} testID="device-rename-input" />
                    <View style={styles.row}>
                      <Button label={t('devices.save')} onPress={() => void save(id)} disabled={!name.trim()} testID="device-rename-save" />
                      <Button kind="secondary" label={t('common.cancel')} onPress={() => setEditing(null)} />
                    </View>
                  </>
                ) : (
                  <View style={styles.row}>
                    <Button
                      kind="secondary"
                      label={t('devices.rename')}
                      onPress={() => {
                        setName(shown);
                        setEditing(id);
                      }}
                      testID="device-rename"
                    />
                    {!mine && (
                      <>
                        <Button kind="secondary" label={t('devices.remove')} onPress={() => router.push(`/devices/lost?device=${encodeURIComponent(id)}&mode=remove` as Href)} testID="device-remove" />
                        <Button kind="danger" label={t('devices.declare')} onPress={() => router.push(`/devices/lost?device=${encodeURIComponent(id)}` as Href)} testID="device-declare" />
                      </>
                    )}
                  </View>
                )}
              </Card>
            );
          })}
          {removed.map((d) => (
            <View key={d.cert.device} style={{ gap: 2 }} testID="device-removed-row">
              <Text style={{ color: c.textMuted, fontSize: 15, textDecorationLine: 'line-through' }} maxFontSizeMultiplier={2}>
                {d.name || t('devices.unnamed')}
              </Text>
              <Muted>{d.removed ? t('devices.removed', { date: date(d.removed) }) : t('devices.removedUndated')}</Muted>
            </View>
          ))}
          <View style={styles.row}>
            <Button label={t('devices.add')} onPress={() => router.push('/devices/add')} testID="devices-add" />
            <Button kind="secondary" label={t('devices.changes')} onPress={() => router.push('/devices/changes')} testID="devices-changes" />
          </View>
          <Section title={t('devices.lost')}>
            <Button kind="danger" label={t('devices.lost')} onPress={() => router.push('/devices/lost')} testID="devices-lost" />
            <Muted>{t('devices.primaryLostHelp')}</Muted>
            <Button kind="secondary" label={t('devices.primaryLost')} onPress={() => router.push('/devices/identity')} testID="devices-identity" />
          </Section>
        </>
      )}
    </StorageScreen>
  );
}

export default function DevicesRoute() {
  return (
    <DataGate>
      <DevicesScreen />
    </DataGate>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  badge: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
});
