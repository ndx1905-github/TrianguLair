/**
 * Trash (gap #8, spec "Editing and deleting"): places, zones, tags and lists I deleted, kept 30 days and synchronized
 * across my devices. Each one can be restored or deleted forever (confirmed); "Empty the trash" removes them all.
 * Items older than 30 days are purged at launch (DataProvider). Friends never see the trash: a deleted item left
 * their cache at their next sync.
 */
import { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { DataGate } from '../components/DataGate';
import { Banner, Button } from '../components/ui';
import { Card, Strong } from '../contacts/ui';
import { useData } from '../data/DataProvider';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import { Muted, StorageScreen } from '../storage/components';
import { deleteForever, emptyTrash, restoreItem, trashItems, type TrashItem } from '../trash/model';

const keyOf = (it: TrashItem) => `${it.ref.kind}:${it.ref.id}`;

function TrashRow({ item, onRestore, onDelete }: { item: TrashItem; onRestore: () => void; onDelete: () => void }) {
  const c = useUiColors();
  const { t, locale } = useI18n();
  const [confirm, setConfirm] = useState(false);
  const name = item.name || t('trash.unnamed');
  const date = new Date(item.deletedAt).toLocaleDateString(locale, { day: 'numeric', month: 'long' });
  return (
    <View style={[styles.row, { borderColor: c.border, backgroundColor: c.surface }]} testID={`trash-item-${item.ref.id}`}>
      <View style={{ gap: 2 }}>
        <Text style={{ color: c.textMuted, fontSize: 12, fontWeight: '700', textTransform: 'uppercase' }} maxFontSizeMultiplier={2}>
          {t(`trash.kind.${item.kind}`)}
        </Text>
        <Text style={{ color: c.text, fontSize: 16, fontWeight: '600' }} maxFontSizeMultiplier={2}>
          {name}
        </Text>
        <Muted>{t('trash.deletedOn', { date })}</Muted>
        <Muted testID="trash-days-left">{item.daysLeft > 0 ? t('trash.daysLeft', { count: item.daysLeft }) : t('trash.purgedSoon')}</Muted>
      </View>
      {confirm ? (
        <Card testID="trash-delete-confirm">
          <Strong>{t('trash.deleteConfirm', { name })}</Strong>
          <Muted>{t('trash.deleteHelp')}</Muted>
          <View style={styles.actions}>
            <Button kind="danger" label={t('trash.deleteForever')} onPress={onDelete} testID="trash-delete-go" />
            <Button kind="secondary" label={t('common.cancel')} onPress={() => setConfirm(false)} />
          </View>
        </Card>
      ) : (
        <View style={styles.actions}>
          <Button label={t('trash.restore')} onPress={onRestore} testID="trash-restore" accessibilityLabel={t('trash.restoreA11y', { name })} />
          <Button kind="secondary" label={t('trash.deleteForever')} onPress={() => setConfirm(true)} testID="trash-delete" accessibilityLabel={t('trash.deleteA11y', { name })} />
        </View>
      )}
    </View>
  );
}

function TrashScreen() {
  const { t } = useI18n();
  const { repo, version, mutate } = useData();
  const items = useMemo(() => trashItems(repo, Date.now()), [repo, version]);
  const [done, setDone] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);

  return (
    <StorageScreen title={t('trash.title')} testID="trash-screen">
      <Muted>{t('trash.help')}</Muted>
      {done && <Banner testID="trash-done">{done}</Banner>}
      {items.length === 0 ? (
        <Muted testID="trash-empty">{t('trash.empty')}</Muted>
      ) : (
        <>
          {items.map((it) => (
            <TrashRow
              key={keyOf(it)}
              item={it}
              onRestore={() => {
                mutate((s) => restoreItem(s, it));
                setDone(t('trash.restored', { name: it.name || t('trash.unnamed') }));
              }}
              onDelete={() => {
                mutate((s) => deleteForever(s, it));
                setDone(t('trash.deleted', { name: it.name || t('trash.unnamed') }));
              }}
            />
          ))}
          {confirmAll ? (
            <Card testID="trash-empty-confirm">
              <Strong>{t('trash.emptyConfirm', { count: items.length })}</Strong>
              <Muted>{t('trash.deleteHelp')}</Muted>
              <View style={styles.actions}>
                <Button
                  kind="danger"
                  label={t('trash.emptyGo')}
                  onPress={() => {
                    const n = mutate((s) => emptyTrash(s, items));
                    setConfirmAll(false);
                    setDone(t('trash.emptied', { count: n }));
                  }}
                  testID="trash-empty-go"
                />
                <Button kind="secondary" label={t('common.cancel')} onPress={() => setConfirmAll(false)} />
              </View>
            </Card>
          ) : (
            <Button kind="danger" label={t('trash.emptyAll')} onPress={() => setConfirmAll(true)} testID="trash-empty-all" />
          )}
        </>
      )}
    </StorageScreen>
  );
}

export default function TrashRoute() {
  return (
    <DataGate>
      <TrashScreen />
    </DataGate>
  );
}

const styles = StyleSheet.create({
  row: { gap: 10, padding: 12, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
