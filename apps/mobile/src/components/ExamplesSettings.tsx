import { useState } from 'react';
import { Text, View } from 'react-native';

import { useExamples } from '../data/useExamples';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import { Banner, Button } from './ui';

/** Settings › My content › "Example places": the one-tap delete, while the examples are there (src/data/demo.ts). */
export function ExamplesSettings() {
  const c = useUiColors();
  const { t } = useI18n();
  const { present, remove } = useExamples();
  const [deleted, setDeleted] = useState<number | null>(null);
  if (!present && deleted == null) return null;
  return (
    <View style={{ gap: 10 }} testID="settings-examples">
      <Text style={{ color: c.text, fontSize: 15, fontWeight: '700' }} accessibilityRole="header" maxFontSizeMultiplier={2}>
        {t('examples.settingsTitle')}
      </Text>
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
