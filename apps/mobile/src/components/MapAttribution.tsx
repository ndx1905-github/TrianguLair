import { Linking, StyleSheet, Text, View } from 'react-native';

import { MAP_ATTRIBUTION_URL, MAP_REPORT_URL } from '../config';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';

/**
 * Always-visible map attribution (required by OSM / OpenFreeMap, spec "Base map"):
 * "OpenFreeMap © OpenMapTiles, data © OpenStreetMap contributors" (opens the copyright page) and
 * "Report an error" (OpenStreetMap's page for fixing the map).
 */
export function MapAttribution({ bottom, right, onHeight }: { bottom: number; right: number; /** Its height (it wraps with large text). */ onHeight?: (h: number) => void }) {
  const c = useUiColors();
  const { t } = useI18n();
  return (
    <View
      style={[styles.box, { bottom, right, backgroundColor: c.surface + 'D9' }]}
      onLayout={onHeight ? (e) => onHeight(Math.round(e.nativeEvent.layout.height)) : undefined}
      testID="map-attribution"
    >
      <Text style={[styles.text, { color: c.textMuted }]} maxFontSizeMultiplier={1.6}>
        <Text accessibilityRole="link" onPress={() => Linking.openURL(MAP_ATTRIBUTION_URL)}>
          {t('map.attribution')}
        </Text>
        {' · '}
        <Text accessibilityRole="link" onPress={() => Linking.openURL(MAP_REPORT_URL)} style={styles.link} testID="map-report-error">
          {t('map.reportError')}
        </Text>
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    position: 'absolute',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    maxWidth: '90%',
  },
  text: { fontSize: 11 },
  link: { textDecorationLine: 'underline' },
});
