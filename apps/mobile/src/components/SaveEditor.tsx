import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { CommentVisibility, PriceLevel, SaveStatus, Sharing } from '@triangulair/data';

import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import type { AppTag } from '../places/model';
import { makeMain } from '../places/add';
import { toggleIn } from '../places/filters';
import { tagPath } from '../tags/tree';
import { SectionTitle, Segmented } from './ui';

export interface SaveFields {
  tagIds: string[];
  status: SaveStatus | null;
  priceLevel: PriceLevel | null;
  comment: string;
  commentVisibility: CommentVisibility;
  sharing: Sharing;
}

interface Props {
  value: SaveFields;
  tags: readonly AppTag[];
  onChange: (patch: Partial<SaveFields>) => void;
  /** Comment edits are reported here on blur (the card saves then, not per keystroke). */
  onCommentCommit?: (comment: string) => void;
}

const STATUSES: (SaveStatus | 'none')[] = ['none', 'to_try', 'tried', 'favorite'];
const PRICES: (PriceLevel | 0)[] = [0, 1, 2, 3, 4];
const VISIBILITIES: CommentVisibility[] = ['private', 'friends', 'public'];

/**
 * My part of a place: tags (first = main tag, long press to make one main),
 * status, price level, comment with its own visibility, sharing.
 */
export function SaveEditor({ value, tags, onChange, onCommentCommit }: Props) {
  const c = useUiColors();
  const { t } = useI18n();
  const byId = new Map(tags.map((tag) => [tag.id, tag]));
  const selected = value.tagIds.map((id) => byId.get(id)).filter((x): x is AppTag => !!x);
  const others = tags.filter((tag) => !value.tagIds.includes(tag.id));

  return (
    <View testID="save-editor">
      <SectionTitle>{t('save.tags')}</SectionTitle>
      <View style={styles.wrap}>
        {selected.map((tag, i) => (
          <Pressable
            key={tag.id}
            onPress={() => onChange({ tagIds: toggleIn(value.tagIds, tag.id) })}
            onLongPress={() => onChange({ tagIds: makeMain(value.tagIds, tag.id) })}
            style={[styles.tag, { backgroundColor: tag.color, borderColor: tag.color }]}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: true }}
            accessibilityLabel={i === 0 ? t('save.tagMainA11y', { name: tag.name }) : t('save.tagA11y', { name: tag.name })}
            accessibilityHint={t('save.tagHint')}
            testID={`tag-selected-${tag.name}`}
          >
            <Text style={styles.tagOnText} maxFontSizeMultiplier={2}>
              {i === 0 ? `★ ${tagPath(tag.id, byId)}` : tagPath(tag.id, byId)}
            </Text>
          </Pressable>
        ))}
        {others.map((tag) => (
          <Pressable
            key={tag.id}
            onPress={() => onChange({ tagIds: [...value.tagIds, tag.id] })}
            style={[styles.tag, { borderColor: tag.color, backgroundColor: c.surface }]}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: false }}
            accessibilityLabel={t('save.tagA11y', { name: tag.name })}
            testID={`tag-option-${tag.name}`}
          >
            <View style={[styles.dot, { backgroundColor: tag.color }]} />
            <Text style={[styles.tagOffText, { color: c.text }]} maxFontSizeMultiplier={2}>
              {tagPath(tag.id, byId)}
            </Text>
          </Pressable>
        ))}
      </View>
      {selected.length > 1 && (
        <Text style={[styles.hint, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
          {t('save.mainHint')}
        </Text>
      )}

      <SectionTitle>{t('save.status')}</SectionTitle>
      <Segmented
        options={STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) }))}
        value={value.status ?? 'none'}
        onChange={(s) => onChange({ status: s === 'none' ? null : s })}
        testID="status"
      />

      <SectionTitle>{t('save.price')}</SectionTitle>
      <Segmented
        options={PRICES.map((p) => ({ value: p, label: p === 0 ? t('price.none') : '€'.repeat(p) }))}
        value={value.priceLevel ?? 0}
        onChange={(p) => onChange({ priceLevel: p === 0 ? null : p })}
        testID="price"
      />

      <SectionTitle>{t('save.comment')}</SectionTitle>
      <TextInput
        value={value.comment}
        onChangeText={(comment) => onChange({ comment })}
        onBlur={() => onCommentCommit?.(value.comment)}
        placeholder={t('save.commentPlaceholder')}
        placeholderTextColor={c.textMuted}
        multiline
        style={[styles.input, { color: c.text, borderColor: c.border, backgroundColor: c.surfaceAlt }]}
        accessibilityLabel={t('save.comment')}
        testID="comment"
      />
      <Text style={[styles.label, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
        {t('save.commentVisibility')}
      </Text>
      <Segmented
        options={VISIBILITIES.map((v) => ({ value: v, label: t(`visibility.${v}`) }))}
        value={value.commentVisibility}
        onChange={(commentVisibility) => onChange({ commentVisibility })}
        testID="comment-visibility"
      />

      <SectionTitle>{t('save.sharing')}</SectionTitle>
      <Segmented
        options={(['friends', 'private'] as Sharing[]).map((s) => ({ value: s, label: t(`sharing.${s}`) }))}
        value={value.sharing}
        onChange={(sharing) => onChange({ sharing })}
        testID="sharing"
      />
      <Text style={[styles.hint, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
        {value.sharing === 'private' ? t('sharing.privateHint') : t('sharing.friendsHint')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    minHeight: 32,
    borderRadius: 999,
    borderWidth: 1.5,
  },
  tagOnText: { color: '#FFFFFF', fontWeight: '700', fontSize: 14, textShadowColor: 'rgba(31,41,55,0.6)', textShadowRadius: 2 },
  tagOffText: { fontSize: 14, fontWeight: '500' },
  dot: { width: 10, height: 10, borderRadius: 5 },
  hint: { fontSize: 13, marginTop: 6 },
  label: { fontSize: 13, marginTop: 10, marginBottom: 6 },
  input: { minHeight: 64, borderWidth: 1, borderRadius: 12, padding: 10, fontSize: 15, textAlignVertical: 'top' },
});
