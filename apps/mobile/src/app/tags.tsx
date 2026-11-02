import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DataGate } from '../components/DataGate';
import { ScreenHeader } from '../components/ScreenHeader';
import { TagEditor, type TagDraft } from '../components/TagEditor';
import { TagIcon } from '../components/TagIcon';
import { Banner, Button, Pill, SectionTitle } from '../components/ui';
import { useData } from '../data/DataProvider';
import { useFriendTags, useTags } from '../data/usePlaces';
import { useLayout } from '../hooks/useLayout';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import type { FriendTagEntry } from '../tags/friendTags';
import { buildTagTree, placeCounts } from '../tags/tree';
import { isIconName } from '../theme/tags';
import { UNTAGGED_COLOR } from '../theme/tags';

type Editing = { kind: 'edit'; id: string } | { kind: 'new'; parentId: string | null } | null;

/**
 * Tag management (T-108): my tags as a tree with their color, icon, number of
 * places, linked OSM categories and linked friends' tags; create / edit /
 * delete (to the trash, with undo). Then "My friends' tags": each one keeps
 * its author's color until I link it to one of mine or adopt it.
 */
function TagsScreen() {
  const c = useUiColors();
  const tr = useI18n();
  const { t } = tr;
  const router = useRouter();
  const params = useLocalSearchParams<{ edit?: string }>();
  const insets = useSafeAreaInsets();
  const { wide, gutter, width } = useLayout();
  const { repo, mutate, version } = useData();
  const { tags, byId } = useTags();
  const friend = useFriendTags();
  const [editing, setEditing] = useState<Editing>(() => (params.edit && byId.has(params.edit) ? { kind: 'edit', id: params.edit } : null));
  const [deleted, setDeleted] = useState<{ id: string; name: string } | null>(null);
  const [linking, setLinking] = useState<string | null>(null);

  const tree = useMemo(() => buildTagTree(tags), [tags]);
  const counts = useMemo(
    () => placeCounts(tags, repo.queryPlaces({ source: 'mine', limit: 100_000 }).map((h) => h.mine?.tagIds ?? [])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [repo, version, tags],
  );
  const linkedCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of friend.entries) if (e.match?.via === 'manual') m.set(e.match.tagId, (m.get(e.match.tagId) ?? 0) + 1);
    return m;
  }, [friend]);

  const save = (draft: TagDraft) => {
    mutate((s) => {
      if (editing?.kind === 'edit') {
        const cur = byId.get(editing.id)!;
        s.updateTag(editing.id, {
          name: draft.name,
          color: draft.color,
          icon: draft.icon,
          osmCategories: draft.osmCategories,
          ...(draft.parentId !== cur.parentId ? { parentId: draft.parentId } : {}),
        });
      } else {
        s.createTag({ name: draft.name, parentId: draft.parentId, color: draft.color, icon: draft.icon, osmCategories: draft.osmCategories });
      }
    });
    setEditing(null);
  };
  const remove = (id: string) => {
    const name = byId.get(id)?.name ?? '';
    mutate((s) => s.deleteTag(id));
    setDeleted({ id, name });
    setEditing(null);
  };
  const adopt = (e: FriendTagEntry) => {
    mutate((s) =>
      s.change((tx) => {
        const id = tx.createTag({ name: e.name, color: e.color ?? UNTAGGED_COLOR, icon: isIconName(e.icon) ? e.icon : 'fallback' });
        tx.setTagMapping(e.personId, e.name, id);
      }),
    );
  };
  const link = (e: FriendTagEntry, myTagId: string | null) => {
    mutate((s) => s.setTagMapping(e.personId, e.name, myTagId));
    setLinking(null);
  };

  const editor =
    editing !== null ? (
      <TagEditor
        key={editing.kind === 'edit' ? editing.id : `new-${editing.parentId ?? ''}`}
        tag={editing.kind === 'edit' ? (byId.get(editing.id) ?? null) : null}
        initialParentId={editing.kind === 'new' ? editing.parentId : null}
        tags={tags}
        onSave={save}
        onCancel={() => setEditing(null)}
        {...(editing.kind === 'edit' ? { onDelete: () => remove(editing.id) } : {})}
      />
    ) : null;

  const list = (
    <View>
      {deleted && (
        <View style={styles.undo}>
          <Banner>{t('tags.deleted', { name: deleted.name })}</Banner>
          <Button
            kind="secondary"
            label={t('tags.undo')}
            onPress={() => {
              mutate((s) => s.restoreTag(deleted.id));
              setDeleted(null);
            }}
            testID="tag-undo"
          />
        </View>
      )}
      <Text style={[styles.hint, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
        {t('tags.mainHint')}
      </Text>
      {tree.length === 0 && (
        <Text style={[styles.hint, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
          {t('tags.empty')}
        </Text>
      )}
      {tree.map(({ tag, depth }) => {
        const meta = [
          t('filters.places', { count: counts.get(tag.id) ?? 0 }),
          tag.osmCategories.length ? t('tags.osmCount', { count: tag.osmCategories.length }) : null,
          linkedCount.get(tag.id) ? t('tags.linkedCount', { count: linkedCount.get(tag.id)! }) : null,
        ].filter(Boolean);
        const selected = editing?.kind === 'edit' && editing.id === tag.id;
        return (
          <View key={tag.id} style={[styles.row, { marginLeft: depth * 22, borderColor: c.border, backgroundColor: selected ? c.selectedBg : c.surface }]}>
            <Pressable
              onPress={() => setEditing({ kind: 'edit', id: tag.id })}
              style={styles.rowMain}
              accessibilityRole="button"
              accessibilityLabel={`${t('tags.edit')}: ${tag.name}`}
              testID={`tag-row-${tag.name}`}
            >
              <TagIcon icon={tag.icon} color={tag.color} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.name, { color: c.text }]} maxFontSizeMultiplier={2}>
                  {depth > 0 ? '› ' : ''}
                  {tag.name}
                </Text>
                <Text style={[styles.meta, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
                  {meta.join(' · ')}
                </Text>
              </View>
            </Pressable>
            <Pressable
              onPress={() => setEditing({ kind: 'new', parentId: tag.id })}
              style={[styles.addSub, { borderColor: c.border }]}
              accessibilityRole="button"
              accessibilityLabel={`${t('tags.newSub')}: ${tag.name}`}
              hitSlop={4}
              testID={`tag-addsub-${tag.name}`}
            >
              <Text style={{ color: c.accent, fontSize: 20, fontWeight: '600' }} maxFontSizeMultiplier={1.5}>
                +
              </Text>
            </Pressable>
          </View>
        );
      })}

      <SectionTitle>{t('tags.friends')}</SectionTitle>
      <Text style={[styles.hint, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
        {friend.entries.length ? t('tags.friendsHint') : t('tags.friendsEmpty')}
      </Text>
      {friend.entries.map((e) => {
        const mine = e.match ? byId.get(e.match.tagId) : undefined;
        const status = mine ? (e.match!.via === 'manual' ? t('tags.linkedTo', { name: mine.name }) : t('tags.linkedByName', { name: mine.name })) : t('tags.unlinked');
        const clash = e.clashWith ? byId.get(e.clashWith) : undefined;
        return (
          <View key={e.key} style={[styles.friendRow, { borderColor: c.border, backgroundColor: c.surface }]} testID={`friendtag-${e.name}`}>
            <View style={styles.rowMain}>
              <TagIcon icon={mine ? mine.icon : e.icon} color={mine ? mine.color : (e.color ?? UNTAGGED_COLOR)} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.name, { color: c.text }]} maxFontSizeMultiplier={2}>
                  {e.name}
                </Text>
                <Text style={[styles.meta, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
                  {t('tags.friendMeta', { person: e.personName, count: e.count })} · {status}
                </Text>
                {clash && (
                  <Text style={[styles.meta, { color: c.warning }]} maxFontSizeMultiplier={2} testID="friendtag-clash">
                    ⚠ {t('tags.clash', { name: clash.name })}
                  </Text>
                )}
              </View>
            </View>
            <View style={styles.actions}>
              <Button kind="secondary" label={t('tags.link')} onPress={() => setLinking(linking === e.key ? null : e.key)} testID={`friendtag-link-${e.name}`} />
              {!mine && (
                <Button kind="secondary" label={t('tags.adopt')} onPress={() => adopt(e)} accessibilityLabel={t('tags.adoptA11y', { name: e.name })} testID={`friendtag-adopt-${e.name}`} />
              )}
              {e.match?.via === 'manual' && <Button kind="secondary" label={t('tags.unlink')} onPress={() => link(e, null)} testID={`friendtag-unlink-${e.name}`} />}
            </View>
            {linking === e.key && (
              <View style={{ gap: 6, marginTop: 8 }}>
                <Text style={{ color: c.text }} maxFontSizeMultiplier={2}>
                  {t('tags.pickTag', { person: e.personName, name: e.name })}
                </Text>
                <View style={styles.wrap}>
                  {tree.map(({ tag, path }) => (
                    <Pill key={tag.id} label={path.join(' › ')} color={tag.color} selected={e.match?.tagId === tag.id} onPress={() => link(e, tag.id)} testID={`friendtag-pick-${tag.name}`} />
                  ))}
                </View>
              </View>
            )}
          </View>
        );
      })}
    </View>
  );

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <ScreenHeader
        title={t('tags.title')}
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        right={
          <Pressable onPress={() => setEditing({ kind: 'new', parentId: null })} accessibilityRole="button" hitSlop={8} testID="tag-new">
            <Text style={{ color: c.accent, fontWeight: '700', fontSize: 16 }} maxFontSizeMultiplier={2}>
              + {t('tags.new')}
            </Text>
          </Pressable>
        }
      />
      {wide ? (
        <View style={styles.split}>
          <ScrollView style={{ width: Math.min(520, width * 0.48), flexGrow: 0, borderRightWidth: StyleSheet.hairlineWidth, borderColor: c.border }} contentContainerStyle={{ padding: gutter, paddingBottom: insets.bottom + 24 }}>
            {list}
          </ScrollView>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: gutter + 4, paddingBottom: insets.bottom + 24 }} keyboardShouldPersistTaps="handled">
            {editor ?? (
              <Text style={[styles.hint, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
                {t('tags.mainHint')}
              </Text>
            )}
          </ScrollView>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: gutter, paddingBottom: insets.bottom + 24 }} keyboardShouldPersistTaps="handled">
          {editor ?? list}
        </ScrollView>
      )}
    </View>
  );
}

export default function TagsRoute() {
  return (
    <DataGate>
      <TagsScreen />
    </DataGate>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  split: { flex: 1, flexDirection: 'row' },
  hint: { fontSize: 14, marginBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, paddingRight: 8, marginBottom: 8 },
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, padding: 10, minHeight: 52 },
  name: { fontSize: 16, fontWeight: '700' },
  meta: { fontSize: 13, marginTop: 2 },
  addSub: { width: 40, height: 40, borderRadius: 20, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  friendRow: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 4, paddingBottom: 10, marginBottom: 8 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 10 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 10 },
  undo: { gap: 8, marginBottom: 12 },
});
