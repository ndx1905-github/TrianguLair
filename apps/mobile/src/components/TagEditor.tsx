import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { categoryForTag } from '@triangulair/osm';

import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import { categoryLabel } from '../places/card';
import type { AppTag } from '../places/model';
import { ICON_GROUPS } from '../tags/iconSet';
import { suggestTagStyle } from '../tags/suggest';
import { MAX_TAG_NAME, parentOptions, PATH_SEPARATOR, tagPath, validateTagName } from '../tags/tree';
import type { IconName } from '../theme/icons';
import { PALETTE } from '../theme/tags';
import { TagIcon } from './TagIcon';
import { Button, Pill, SectionTitle } from './ui';

export interface TagDraft {
  name: string;
  parentId: string | null;
  color: string;
  icon: IconName;
  osmCategories: string[];
}

/** OSM categories offered for linking (the tag's own ones are always listed too). */
const OSM_CHOICES = [
  'amenity=restaurant', 'amenity=fast_food', 'amenity=cafe', 'amenity=bar', 'amenity=pub', 'amenity=ice_cream',
  'shop=bakery', 'shop=pastry', 'shop=cheese', 'shop=wine', 'shop=books', 'shop=clothes', 'amenity=marketplace',
  'tourism=museum', 'tourism=gallery', 'historic=monument', 'tourism=viewpoint', 'amenity=theatre', 'amenity=cinema',
  'amenity=music_venue', 'amenity=concert_hall', 'leisure=park', 'leisure=garden', 'natural=beach', 'tourism=hotel',
];

interface Props {
  /** The tag being edited; null for a new tag. */
  tag: AppTag | null;
  /** New tag: its parent ("Add a sub-tag"). */
  initialParentId?: string | null;
  tags: readonly AppTag[];
  onSave: (draft: TagDraft) => void;
  onCancel: () => void;
  onDelete?: () => void;
}

/**
 * Create or edit a tag (T-108): name, parent (sub-tags "Restaurant › Pizza"),
 * color from the spec palette, icon from the curated set (suggested from the
 * name for a new tag until the user picks one), linked OSM categories.
 */
export function TagEditor({ tag, initialParentId = null, tags, onSave, onCancel, onDelete }: Props) {
  const c = useUiColors();
  const tr = useI18n();
  const { t } = tr;
  const byId = new Map(tags.map((x) => [x.id, x]));
  const [name, setName] = useState(tag?.name ?? '');
  const [parentId, setParentId] = useState<string | null>(tag ? tag.parentId : initialParentId);
  const initial = tag ? { color: tag.color, icon: tag.icon } : suggestTagStyle('', tags);
  const [color, setColor] = useState(initial.color);
  const [icon, setIcon] = useState<IconName>(initial.icon);
  const [picked, setPicked] = useState({ color: !!tag, icon: !!tag });
  const [osm, setOsm] = useState<string[]>(tag?.osmCategories ?? []);
  const [touched, setTouched] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const problem = validateTagName(name, parentId, tags, tag?.id);
  const onName = (v: string) => {
    setName(v);
    if (!tag && (!picked.color || !picked.icon)) {
      const s = suggestTagStyle(v, tags);
      if (!picked.color) setColor(s.color);
      if (!picked.icon) setIcon(s.icon);
    }
  };
  const submit = () => {
    setTouched(true);
    if (problem) return;
    onSave({ name: name.trim(), parentId, color, icon, osmCategories: osm });
  };
  const parents = parentOptions(tag?.id ?? null, tags);
  const osmList = [...new Set([...osm, ...OSM_CHOICES])];
  const preview = [parentId ? tagPath(parentId, byId) : null, name.trim() || t('tags.name')].filter(Boolean).join(PATH_SEPARATOR);

  return (
    <View testID="tag-editor">
      <View style={styles.previewRow}>
        <TagIcon icon={icon} color={color} size={44} />
        <Text style={[styles.preview, { color: c.text }]} maxFontSizeMultiplier={2} testID="tag-preview">
          {preview}
        </Text>
      </View>

      <SectionTitle>{t('tags.name')}</SectionTitle>
      <TextInput
        value={name}
        onChangeText={onName}
        onBlur={() => setTouched(true)}
        placeholder={t('tags.namePlaceholder')}
        placeholderTextColor={c.textMuted}
        maxLength={MAX_TAG_NAME + 10}
        style={[styles.input, { color: c.text, borderColor: touched && problem ? c.danger : c.border, backgroundColor: c.surface }]}
        accessibilityLabel={t('tags.name')}
        autoFocus={!tag}
        testID="tag-name"
      />
      {touched && problem && (
        <Text style={{ color: c.danger, marginTop: 4 }} maxFontSizeMultiplier={2} testID="tag-name-error">
          {t(`tags.error.${problem}`, { max: MAX_TAG_NAME })}
        </Text>
      )}

      <SectionTitle>{t('tags.parent')}</SectionTitle>
      <View style={styles.wrap}>
        <Pill label={t('tags.noParent')} selected={parentId === null} onPress={() => setParentId(null)} testID="tag-parent-none" />
        {parents.map((n) => (
          <Pill
            key={n.tag.id}
            label={n.path.join(PATH_SEPARATOR)}
            color={n.tag.color}
            selected={parentId === n.tag.id}
            onPress={() => setParentId(n.tag.id)}
            testID={`tag-parent-${n.tag.name}`}
          />
        ))}
      </View>

      <SectionTitle>{t('tags.color')}</SectionTitle>
      <View style={styles.wrap} accessibilityRole="radiogroup">
        {(Object.entries(PALETTE) as [keyof typeof PALETTE, string][]).map(([key, hex]) => {
          const on = color.toUpperCase() === hex.toUpperCase();
          return (
            <Pressable
              key={key}
              onPress={() => {
                setColor(hex);
                setPicked((p) => ({ ...p, color: true }));
              }}
              style={[styles.swatchRing, { borderColor: on ? c.text : 'transparent' }]}
              accessibilityRole="radio"
              aria-checked={on}
              accessibilityLabel={t('tags.colorA11y', { name: t(`color.${key}`) })}
              testID={`tag-color-${key}`}
            >
              <View style={[styles.swatch, { backgroundColor: hex }]} />
            </Pressable>
          );
        })}
      </View>

      <SectionTitle>{t('tags.icon')}</SectionTitle>
      {ICON_GROUPS.map((g) => (
        <View key={g.id} style={styles.iconGroup}>
          <Text style={[styles.groupLabel, { color: c.textMuted }]} maxFontSizeMultiplier={1.8}>
            {t(`iconGroup.${g.id}`)}
          </Text>
          <View style={styles.wrap}>
            {g.icons.map((ic) => {
              const on = ic === icon;
              return (
                <Pressable
                  key={ic}
                  onPress={() => {
                    setIcon(ic);
                    setPicked((p) => ({ ...p, icon: true }));
                  }}
                  style={[styles.iconCell, { borderColor: on ? c.text : c.border, backgroundColor: on ? c.selectedBg : c.surface }]}
                  accessibilityRole="radio"
                  aria-checked={on}
                  accessibilityLabel={t('tags.iconA11y', { name: ic })}
                  testID={`tag-icon-${ic}`}
                >
                  <TagIcon icon={ic} color={on ? color : '#94A3B8'} size={32} />
                </Pressable>
              );
            })}
          </View>
        </View>
      ))}

      <SectionTitle>{t('tags.osm')}</SectionTitle>
      <Text style={[styles.hint, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
        {t('tags.osmHint')}
      </Text>
      <View style={styles.wrap}>
        {osmList.map((k) => {
          const [key, value = ''] = k.split('=');
          const id = key ? categoryForTag(key, value) : null;
          return (
            <Pill
              key={k}
              label={id ? `${categoryLabel(id, tr)} · ${value}` : k}
              selected={osm.includes(k)}
              onPress={() => setOsm((list) => (list.includes(k) ? list.filter((x) => x !== k) : [...list, k]))}
              testID={`tag-osm-${k}`}
            />
          );
        })}
      </View>

      <View style={[styles.wrap, { marginTop: 20 }]}>
        <Button label={tag ? t('tags.save') : t('tags.create')} onPress={submit} disabled={touched && !!problem} testID="tag-save" />
        <Button kind="secondary" label={t('common.cancel')} onPress={onCancel} testID="tag-cancel" />
      </View>
      {tag && onDelete && (
        <View style={{ marginTop: 16, gap: 8 }}>
          {confirmDelete ? (
            <>
              <Text style={{ color: c.text }} maxFontSizeMultiplier={2}>
                {t('tags.confirmDelete', { name: tag.name })}
              </Text>
              <View style={styles.wrap}>
                <Button kind="danger" label={t('tags.delete')} onPress={onDelete} testID="tag-confirm-delete" />
                <Button kind="secondary" label={t('common.cancel')} onPress={() => setConfirmDelete(false)} />
              </View>
            </>
          ) : (
            <View style={styles.wrap}>
              <Button kind="secondary" label={t('tags.delete')} onPress={() => setConfirmDelete(true)} testID="tag-delete" />
            </View>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  previewRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4 },
  preview: { fontSize: 20, fontWeight: '700', flexShrink: 1 },
  input: { minHeight: 44, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, fontSize: 16 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  swatchRing: { width: 44, height: 44, borderRadius: 22, borderWidth: 2.5, alignItems: 'center', justifyContent: 'center' },
  swatch: { width: 32, height: 32, borderRadius: 16 },
  iconGroup: { marginBottom: 8 },
  groupLabel: { fontSize: 12, fontWeight: '600', marginBottom: 4 },
  iconCell: { width: 48, height: 48, borderRadius: 12, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  hint: { fontSize: 13, marginBottom: 8 },
});
