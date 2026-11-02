/**
 * "Lists" on the place card: every list of mine with whether this place is
 * in it. Manual lists are ticked on and off; filter lists say why the place is
 * in or out ("Does not match: tags") and offer "Add by hand" / "Leave out" /
 * "Follow the filter" (the list's exceptions). Membership comes from the data
 * package (`listItems`); the reasons from the same rules (`explain`).
 */
import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import type { SaveRecord } from '@triangulair/data';

import { useData } from '../data/DataProvider';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import { reasonText } from '../lists/ListEditor';
import { cardListAction, draftFromList, explain, filterWithoutException, type CardListAction } from '../lists/listLogic';
import { useLists } from '../lists/useListData';
import { Button, SectionTitle } from './ui';

export function ListsSection({ placeId, save }: { placeId: string; save: SaveRecord }) {
  const c = useUiColors();
  const { t } = useI18n();
  const router = useRouter();
  const { repo, mutate, version } = useData();
  const lists = useLists();

  const rows = useMemo(() => {
    const place = repo.getPlace(placeId);
    if (!place) return [];
    const ctx = repo.filterContext();
    const subject = { save, place };
    return lists.map((l) => {
      const reason = explain(subject, draftFromList(l), ctx);
      return { list: l, inList: repo.listItems(l.id).includes(save.id), reason, action: cardListAction(l.kind, reason) };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, version, lists, placeId, save]);

  const run = (listId: string, action: CardListAction) => {
    const l = lists.find((x) => x.id === listId);
    if (!l || !action) return;
    mutate((s) => {
      if (action === 'add') s.addToList(listId, placeId);
      else if (action === 'remove') s.removeFromList(listId, placeId);
      else s.setListFilter(listId, filterWithoutException(l, placeId));
    });
  };

  return (
    <View testID="card-lists">
      <SectionTitle>{t('card.lists')}</SectionTitle>
      {save.sharing === 'private' && lists.length > 0 && (
        <Text style={[styles.note, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
          {t('card.listsPrivate')}
        </Text>
      )}
      {lists.length === 0 && (
        <Text style={[styles.note, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
          {t('card.listsNone')}
        </Text>
      )}
      <View style={{ gap: 8 }}>
        {rows.map(({ list, inList, reason, action }) => {
          const manual = list.kind === 'manual';
          const body = (
            <>
              <View style={[styles.check, { borderColor: inList ? c.accent : c.border, backgroundColor: inList ? c.accent : 'transparent' }]}>
                {inList ? (
                  <Text style={styles.tick} maxFontSizeMultiplier={1.4}>
                    ✓
                  </Text>
                ) : null}
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ color: c.text, fontSize: 15, fontWeight: '600' }} maxFontSizeMultiplier={2}>
                  {list.name}
                </Text>
                <Text style={{ color: c.textMuted, fontSize: 13 }} maxFontSizeMultiplier={2} testID={`card-list-why-${list.id}`}>
                  {manual ? t('card.listManual') : `${t('card.listFilter')} · ${reasonText(reason, t)}`}
                </Text>
              </View>
            </>
          );
          return (
            <View key={list.id} style={[styles.row, { borderColor: c.border }]} testID={`card-list-${list.name}`}>
              {manual && action ? (
                <Pressable
                  onPress={() => run(list.id, action)}
                  style={styles.rowMain}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: inList }}
                  accessibilityLabel={t(inList ? 'card.listInA11y' : 'card.listOutA11y', { name: list.name })}
                  testID={`card-list-toggle-${list.name}`}
                >
                  {body}
                </Pressable>
              ) : (
                <View style={styles.rowMain} accessible accessibilityLabel={`${t(inList ? 'card.listInA11y' : 'card.listOutA11y', { name: list.name })}. ${reasonText(reason, t)}`}>
                  {body}
                </View>
              )}
              {!manual && action && (
                <View style={styles.action}>
                  <Button
                    kind="secondary"
                    label={t(action === 'add' ? 'card.listAddByHand' : action === 'remove' ? 'card.listRemoveByHand' : 'card.listUndoException')}
                    onPress={() => run(list.id, action)}
                    testID={`card-list-action-${list.name}`}
                  />
                </View>
              )}
            </View>
          );
        })}
      </View>
      <View style={{ flexDirection: 'row', marginTop: 8 }}>
        <Button kind="secondary" label={t('card.listsNew')} onPress={() => router.push('/lists/edit')} testID="card-list-new" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  note: { fontSize: 14, marginBottom: 8 },
  row: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 8, gap: 6 },
  rowMain: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 40 },
  check: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  tick: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },
  action: { alignSelf: 'flex-start', marginLeft: 34 },
});
