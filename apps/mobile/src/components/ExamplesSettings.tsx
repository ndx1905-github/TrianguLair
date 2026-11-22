import { useState } from 'react';
import { Text, View } from 'react-native';

import { useExamples } from '../data/useExamples';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import { Banner, Button, SectionTitle } from './ui';

/** Settings › "Example places": the one-tap delete, while the examples are there (src/data/demo.ts). */
export function ExamplesSettings() {
  const c = useUiColors();
  const { t } = useI18n();
  const { present, remove } = useExamples();
  const [deleted, setDeleted] = useState<number | null>(null);
  if (!present && deleted == null) return null;
  return (
    <View style={{ gap: 10 }} testID="settings-examples">
      <SectionTitle>{t('examples.settingsTitle')}</SectionTitle>
      {deleted != null ? (
        <Banner testID="settings-examples-deleted">{t('examples.deleted', { count: deleted })}</Banner>
      ) : (
        <>
          <Text style={{ color: c.textMuted, fontSize: 14 }} maxFontSizeMultiplier={2}>
            {t('examples.settingsHelp')}
          </Text>
          <Button kind="danger" label={t('examples.delete')} onPress={() => setDeleted(remove())} testID="settings-examples-delete" />
        </>
      )}
    </View>
  );
}
