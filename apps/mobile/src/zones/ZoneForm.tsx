import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { SaveEditor, type SaveFields } from '../components/SaveEditor';
import { Banner, Button, SectionTitle } from '../components/ui';
import { useTags } from '../data/usePlaces';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';

interface Props {
  initialName: string;
  /** "Neighbourhood from OpenStreetMap", "2 street segments, 640 m"… */
  summary: string;
  alreadySaved: boolean;
  onBack: () => void;
  onSave: (name: string, fields: SaveFields) => void;
}

/** Second step of a new zone: the same personal fields as a place (spec: tags, notes, visibility). */
export function ZoneForm({ initialName, summary, alreadySaved, onBack, onSave }: Props) {
  const c = useUiColors();
  const { t } = useI18n();
  const { tags } = useTags();
  const [name, setName] = useState(initialName);
  const [fields, setFields] = useState<SaveFields>({
    tagIds: [],
    status: null,
    priceLevel: null,
    comment: '',
    commentVisibility: 'friends',
    sharing: 'friends',
  });
  return (
    <View testID="zone-form">
      <Text style={[styles.summary, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
        {summary}
      </Text>
      {alreadySaved && (
        <View style={{ marginTop: 8 }}>
          <Banner>{t('zone.alreadySaved')}</Banner>
        </View>
      )}
      <SectionTitle>{t('add.name')}</SectionTitle>
      <TextInput
        value={name}
        onChangeText={setName}
        placeholder={t('zone.namePlaceholder')}
        placeholderTextColor={c.textMuted}
        style={[styles.input, { color: c.text, borderColor: c.border, backgroundColor: c.surfaceAlt }]}
        accessibilityLabel={t('add.name')}
        testID="zone-name"
      />
      <SaveEditor value={fields} tags={tags} onChange={(patch) => setFields((f) => ({ ...f, ...patch }))} />
      <View style={styles.actions}>
        <Button kind="secondary" label={t('zone.backToShape')} onPress={onBack} testID="zone-back-shape" />
        <Button label={t('zone.save')} onPress={() => onSave(name.trim() || initialName, fields)} disabled={!name.trim() && !initialName} testID="zone-save" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  summary: { fontSize: 14 },
  input: { minHeight: 44, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, fontSize: 16 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 20, justifyContent: 'flex-end' },
});
