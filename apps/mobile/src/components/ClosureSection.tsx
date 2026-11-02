import { StyleSheet, Text, View } from 'react-native';
import type { PlaceRecord } from '@triangulair/data';

import { readSignals, signalsSince } from '../closure/glue';
import { signalDate, signalText } from '../closure/labels';
import { resolveClosure } from '../closure/run';
import { useData } from '../data/DataProvider';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import { Button } from './ui';

/**
 * Closed-place status on the card (T-113): the "maybe closed" badge with its
 * reasons and date, and the user's answer ("Confirm closed" / "Still open").
 * Nothing is ever closed or deleted without that answer.
 */
export function ClosureSection({ place, mine }: { place: PlaceRecord; mine: boolean }) {
  const c = useUiColors();
  const tr = useI18n();
  const { t } = tr;
  const { mutate } = useData();
  const signals = readSignals(place);

  if (place.status === 'maybe_closed') {
    const since = signalDate(signalsSince(signals), tr.locale);
    const fromPeople = signals.length > 0 && signals.every((s) => s.source !== 'osm');
    return (
      <View style={[styles.box, { backgroundColor: c.warningBg, borderColor: c.warning }]} testID="closure-maybe">
        <View style={styles.badgeRow}>
          <View style={[styles.badge, { backgroundColor: '#6B7280' }]}>
            <Text style={styles.badgeText} maxFontSizeMultiplier={1.6}>
              ✕ {t('closure.badge')}
            </Text>
          </View>
          {since && (
            <Text style={[styles.since, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
              {t('closure.since', { date: since })}
            </Text>
          )}
        </View>
        {signals.map((s, i) => (
          <Text key={`${s.code}-${i}`} style={[styles.reason, { color: c.text }]} maxFontSizeMultiplier={2} testID="closure-reason">
            • {signalText(s, tr)} <Text style={{ color: c.textMuted }}>({t(`closure.reliability.${s.reliability}`)})</Text>
          </Text>
        ))}
        {fromPeople && (
          <Text style={[styles.hint, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
            {t('closure.osmHint')}
          </Text>
        )}
        {mine && (
          <>
            <Text style={[styles.hint, { color: c.text }]} maxFontSizeMultiplier={2}>
              {t('closure.ask')}
            </Text>
            <View style={styles.actions}>
              <Button kind="danger" label={t('closure.confirm')} onPress={() => resolveClosure(place, 'closed', mutate)} testID="closure-confirm" />
              <Button kind="secondary" label={t('closure.stillOpen')} onPress={() => resolveClosure(place, 'still_open', mutate)} testID="closure-still-open" />
            </View>
          </>
        )}
      </View>
    );
  }
  if (place.status === 'closed') {
    return (
      <View style={[styles.box, { backgroundColor: c.surfaceAlt, borderColor: c.border }]} testID="closure-closed">
        <Text style={[styles.reason, { color: c.text }]} maxFontSizeMultiplier={2}>
          {t('closure.closed')}
        </Text>
        {mine && (
          <View style={styles.actions}>
            <Button kind="secondary" label={t('closure.reopen')} onPress={() => resolveClosure(place, 'still_open', mutate)} testID="closure-reopen" />
          </View>
        )}
      </View>
    );
  }
  return null;
}

const styles = StyleSheet.create({
  box: { borderRadius: 12, borderWidth: 1, padding: 12, gap: 6, marginTop: 10 },
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  badge: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  badgeText: { color: '#FFFFFF', fontWeight: '700', fontSize: 13 },
  since: { fontSize: 13 },
  reason: { fontSize: 14 },
  hint: { fontSize: 13 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
});
