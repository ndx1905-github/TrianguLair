/**
 * The bottom bar of the list's "Select" mode (beta feedback: delete or edit many places at once):
 * "Delete (N)", "Add to a list", "Tag", "Status". Each runs one `DataStore.bulkEdit`, a single
 * change of my document, so the sync publishes it once. Only my saves are edited: friends' places
 * in the selection are skipped, and every panel says so.
 *
 * Delete asks first, with the count, then goes to the trash (restorable for 30 days) and offers
 * the usual "Undo" (TrashUndo); the other actions end with a short notice.
 */
import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { BulkEdit, SaveStatus } from '@triangulair/data';

import { useData } from '../data/DataProvider';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import type { AppTag } from '../places/model';
import { useAppState } from '../state/AppState';
import { Button, Pill, Segmented } from './ui';

type Panel = 'none' | 'delete' | 'list' | 'tag' | 'status';

const STATUSES: (SaveStatus | null)[] = ['to_try', 'tried', 'favorite', null];

export function BulkBar({
  mine,
  friends,
  tags,
  nameOf,
  onDone,
  bottomInset,
}: {
  /** My saves among the selection (place ids). */
  mine: string[];
  /** Friends' places among the selection (skipped). */
  friends: number;
  tags: AppTag[];
  nameOf: (placeId: string) => string;
  /** After an action: leave the select mode, with an optional notice for the list. */
  onDone: (notice: string | null) => void;
  bottomInset: number;
}) {
  const c = useUiColors();
  const { t } = useI18n();
  const { repo, version, mutate } = useData();
  const { setTrashed } = useAppState();
  const [panel, setPanel] = useState<Panel>('none');
  const [tagMode, setTagMode] = useState<'add' | 'remove'>('add');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const lists = useMemo(() => repo.lists().filter((l) => l.deletedAt == null), [repo, version]);
  const n = mine.length;
  const disabled = n === 0;

  const run = (edit: BulkEdit) => mutate((s) => s.bulkEdit(mine, edit));
  const changedNotice = (count: number) => t('bulk.updated', { count });

  const skippedNote =
    friends > 0 ? (
      <Text style={[styles.note, { color: c.textMuted }]} maxFontSizeMultiplier={2} testID="bulk-skipped">
        {t('bulk.friendsSkipped', { count: friends })}
      </Text>
    ) : null;

  const toggle = (p: Panel) => setPanel((cur) => (cur === p ? 'none' : p));

  return (
    <View style={[styles.bar, { backgroundColor: c.surface, borderColor: c.border, paddingBottom: bottomInset + 10 }]} testID="bulk-bar">
      {panel === 'delete' && (
        <View style={styles.panel} testID="bulk-delete-confirm">
          <Text style={[styles.title, { color: c.text }]} maxFontSizeMultiplier={2}>
            {t('bulk.deleteConfirm', { count: n })}
          </Text>
          {skippedNote}
          <View style={styles.row}>
            <Button kind="secondary" label={t('common.cancel')} onPress={() => setPanel('none')} testID="bulk-delete-cancel" />
            <Button
              kind="danger"
              label={t('bulk.deleteYes', { count: n })}
              onPress={() => {
                const r = run({ kind: 'delete' });
                const first = r.changed[0];
                if (first) setTrashed({ placeId: first, name: nameOf(first), placeIds: r.changed });
                onDone(null);
              }}
              testID="bulk-delete-yes"
            />
          </View>
        </View>
      )}
      {panel === 'list' && (
        <View style={styles.panel} testID="bulk-list-panel">
          <Text style={[styles.title, { color: c.text }]} maxFontSizeMultiplier={2}>
            {t('bulk.listTitle', { count: n })}
          </Text>
          {skippedNote}
          {lists.length === 0 ? (
            <Text style={[styles.note, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
              {t('bulk.noLists')}
            </Text>
          ) : (
            <ScrollView style={styles.choices} contentContainerStyle={styles.wrap}>
              {lists.map((l) => (
                <Pill
                  key={l.id}
                  label={l.name}
                  onPress={() => {
                    const r = run({ kind: 'addToList', listId: l.id });
                    onDone(t('bulk.addedToList', { count: r.changed.length, name: l.name }));
                  }}
                  testID={`bulk-list-${l.name}`}
                />
              ))}
            </ScrollView>
          )}
        </View>
      )}
      {panel === 'tag' && (
        <View style={styles.panel} testID="bulk-tag-panel">
          <Segmented
            options={[
              { value: 'add', label: t('bulk.tagAdd') },
              { value: 'remove', label: t('bulk.tagRemove') },
            ]}
            value={tagMode}
            onChange={setTagMode}
            testID="bulk-tag-mode"
          />
          {skippedNote}
          <ScrollView style={styles.choices} contentContainerStyle={styles.wrap}>
            {tags.map((tag) => (
              <Pill
                key={tag.id}
                label={tag.name}
                color={tag.color}
                onPress={() => {
                  const r = run({ kind: tagMode === 'add' ? 'addTag' : 'removeTag', tagId: tag.id });
                  onDone(t(tagMode === 'add' ? 'bulk.tagAdded' : 'bulk.tagRemoved', { count: r.changed.length, name: tag.name }));
                }}
                testID={`bulk-tag-${tag.name}`}
              />
            ))}
          </ScrollView>
        </View>
      )}
      {panel === 'status' && (
        <View style={styles.panel} testID="bulk-status-panel">
          <Text style={[styles.title, { color: c.text }]} maxFontSizeMultiplier={2}>
            {t('bulk.statusTitle', { count: n })}
          </Text>
          {skippedNote}
          <View style={styles.wrap}>
            {STATUSES.map((s) => (
              <Pill
                key={s ?? 'none'}
                label={t(`status.${s ?? 'none'}`)}
                onPress={() => onDone(changedNotice(run({ kind: 'status', status: s }).changed.length))}
                testID={`bulk-status-${s ?? 'none'}`}
              />
            ))}
          </View>
        </View>
      )}
      <View style={styles.actions}>
        <Button kind="danger" label={t('bulk.delete', { count: n })} onPress={() => toggle('delete')} disabled={disabled} testID="bulk-delete" />
        <Button kind="secondary" label={t('bulk.toList')} onPress={() => toggle('list')} disabled={disabled} testID="bulk-to-list" />
        <Button kind="secondary" label={t('bulk.tag')} onPress={() => toggle('tag')} disabled={disabled} testID="bulk-tag" />
        <Button kind="secondary" label={t('bulk.status')} onPress={() => toggle('status')} disabled={disabled} testID="bulk-status" />
      </View>
      {disabled && friends > 0 ? skippedNote : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingTop: 10, gap: 10 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center' },
  panel: { gap: 8 },
  title: { fontSize: 15, fontWeight: '700' },
  note: { fontSize: 13 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choices: { maxHeight: 180 },
});
