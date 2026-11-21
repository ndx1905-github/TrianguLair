/**
 * Blocked people (gap #6, spec "Moderation"): who I blocked, with "Unblock". Unblocking does not bring anything
 * back: they are no longer refused, and a new invitation is needed to share again.
 */
import { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { DataGate } from '../components/DataGate';
import { Banner, Button } from '../components/ui';
import { shortKey } from '../contacts/ui';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import { Muted, StorageScreen } from '../storage/components';
import { useSync } from '../sync/SyncProvider';

function BlockedScreen() {
  const c = useUiColors();
  const { t, locale } = useI18n();
  const sync = useSync();
  const [done, setDone] = useState<string | null>(null);
  const people = useMemo(() => sync.blocked(), [sync.snapshot, done]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <StorageScreen title={t('blocked.title')} testID="blocked-screen">
      <Muted>{t('blocked.help')}</Muted>
      {done && <Banner testID="blocked-done">{done}</Banner>}
      {people.length === 0 && <Muted testID="blocked-empty">{t('blocked.empty')}</Muted>}
      {people.map((p) => {
        const label = p.name || shortKey(p.owner);
        return (
          <View key={p.owner} style={[styles.row, { borderColor: c.border, backgroundColor: c.surface }]} testID={`blocked-${label}`}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ color: c.text, fontSize: 16, fontWeight: '600' }} maxFontSizeMultiplier={2}>
                {label}
              </Text>
              <Muted>{t('blocked.since', { date: new Date(p.at).toLocaleDateString(locale, { day: 'numeric', month: 'long' }) })}</Muted>
            </View>
            <Button
              kind="secondary"
              label={t('blocked.unblock')}
              onPress={() => void sync.unblock(p.owner).then(() => setDone(t('blocked.unblocked', { name: label })))}
              testID="blocked-unblock"
            />
          </View>
        );
      })}
    </StorageScreen>
  );
}

export default function BlockedRoute() {
  return (
    <DataGate>
      <BlockedScreen />
    </DataGate>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10, padding: 12, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
});
