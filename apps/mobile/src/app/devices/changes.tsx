/**
 * "Shows the changes made on the storage since the date of the theft, with the option to revert to
 * the previous state" (spec "Loss and theft", step 5; T-207): what my other devices changed in my
 * places, kept by this device at each sync (`journal.ts`), since a chosen date, optionally only from
 * the lost device; a change is reverted from the copy kept here, as a new edit that syncs.
 */
import { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';

import { DataGate } from '../../components/DataGate';
import { Button, Segmented } from '../../components/ui';
import { Card } from '../../contacts/ui';
import { changesSince, type ChangeLine } from '../../devices/journal';
import { ToggleRow } from '../../firstLaunch/ToggleRow';
import { useUiColors } from '../../hooks/useUiColors';
import { useI18n } from '../../i18n';
import { Muted, StorageScreen } from '../../storage/components';
import { useSync } from '../../sync/SyncProvider';

const RANGES = [1, 3, 7, 30, 120] as const;
const DAY = 86_400_000;

function ChangesScreen() {
  const { t, locale } = useI18n();
  const c = useUiColors();
  const params = useLocalSearchParams<{ device?: string }>();
  const sync = useSync();
  const lost = typeof params.device === 'string' ? params.device : null;
  const devices = sync.devices();
  const lostName = lost ? (devices.find((d) => d.cert.device === lost)?.name ?? '') : '';
  const [days, setDays] = useState<number>(7);
  const [onlyLost, setOnlyLost] = useState(!!lost);
  const [version, setVersion] = useState(0);
  const since = days === 1 ? new Date(new Date().setHours(0, 0, 0, 0)).getTime() : Date.now() - days * DAY;
  const lines = useMemo(
    () => changesSince(sync.journal(), since, onlyLost && lost ? [lost] : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sync, since, onlyLost, lost, version, sync.snapshot],
  );
  const nameOf = (id: string | null) => (id ? devices.find((d) => d.cert.device === id)?.name : undefined) || t('changes.unknownDevice');
  const when = (ms: number) => new Date(ms).toLocaleString(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const describe = (l: ChangeLine) =>
    l.kind === 'edited' ? t('changes.kind.edited', { fields: l.fields.map((f) => t(`changes.field.${f}`)).join(', ') }) : t(`changes.kind.${l.kind}`);

  return (
    <StorageScreen title={t('changes.title')} testID="changes-screen">
      <Muted>{t('changes.lead')}</Muted>
      <Muted>{t('changes.since')}</Muted>
      <Segmented options={RANGES.map((d) => ({ value: d as number, label: t(`changes.range.${d}`) }))} value={days} onChange={setDays} testID="changes-range" />
      {lost && <ToggleRow label={t('changes.onlyLost', { name: lostName })} value={onlyLost} onChange={setOnlyLost} testID="changes-only-lost" />}
      {lines.length === 0 && <Muted testID="changes-none">{t('changes.none')}</Muted>}
      {lines.map((l, i) => {
        const name = (l.change.after ?? l.change.before)?.name || t('changes.unnamedPlace');
        return (
          <Card key={`${l.entryAt}-${l.change.placeId}-${i}`} testID="change-row">
            <Text style={{ color: c.text, fontSize: 16, fontWeight: '700' }} maxFontSizeMultiplier={2}>
              {name}
            </Text>
            <Text style={{ color: c.text, fontSize: 15 }} maxFontSizeMultiplier={2} testID="change-kind">
              {describe(l)}
            </Text>
            <Muted>{t('changes.by', { device: nameOf(l.device), date: when(l.entryAt) })}</Muted>
            <View style={styles.row}>
              {l.reverted ? (
                <Muted testID="change-reverted">{t('changes.reverted')}</Muted>
              ) : l.revertible ? (
                <Button
                  kind="secondary"
                  label={t('changes.revert')}
                  onPress={() => {
                    try {
                      sync.revert(l.entryAt, l.change.placeId);
                    } finally {
                      setVersion((v) => v + 1);
                    }
                  }}
                  testID="change-revert"
                />
              ) : (
                <Muted>{l.kind === 'purged' ? t('changes.cannot') : t('changes.changedAgain')}</Muted>
              )}
            </View>
          </Card>
        );
      })}
      <Muted>{t('changes.history')}</Muted>
    </StorageScreen>
  );
}

export default function ChangesRoute() {
  return (
    <DataGate>
      <ChangesScreen />
    </DataGate>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
});
