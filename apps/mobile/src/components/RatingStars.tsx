/**
 * My rating of a place: five stars, a radio group ("1 star" … "5 stars"). Tapping the selected star
 * again removes the rating (null). `RatingBadge` is the compact read-only form ("★ 4") used for
 * friends' ratings.
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Rating } from '@triangulair/data';

import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import { nextRating } from '../places/rating';

const STARS: Rating[] = [1, 2, 3, 4, 5];
/** Filled stars: a warm amber that reads on light and dark surfaces. */
const STAR_ON = '#F59E0B';

export function RatingStars({ value, onChange, testID = 'rating' }: { value: Rating | null; onChange: (r: Rating | null) => void; testID?: string }) {
  const c = useUiColors();
  const { t } = useI18n();
  return (
    <View>
      <View style={styles.row} accessibilityRole="radiogroup" accessibilityLabel={t('save.rating')} testID={testID}>
        {STARS.map((n) => {
          const on = value !== null && n <= value;
          return (
            <Pressable
              key={n}
              onPress={() => onChange(nextRating(value, n))}
              accessibilityRole="radio"
              aria-checked={value === n}
              accessibilityLabel={t('rating.stars', { count: n })}
              hitSlop={4}
              style={styles.star}
              testID={`${testID}-star-${n}`}
            >
              <Text style={[styles.starText, { color: on ? STAR_ON : c.textMuted }]} maxFontSizeMultiplier={1.5}>
                {on ? '★' : '☆'}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {value !== null ? (
        <Text style={[styles.hint, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
          {t('rating.hint')}
        </Text>
      ) : null}
    </View>
  );
}

/** "★ 4", read as "4 stars". */
export function RatingBadge({ value, testID }: { value: Rating; testID?: string }) {
  const c = useUiColors();
  const { t } = useI18n();
  return (
    <Text style={[styles.badge, { color: c.text }]} accessibilityLabel={t('rating.stars', { count: value })} maxFontSizeMultiplier={2} testID={testID}>
      <Text style={{ color: STAR_ON }}>★</Text> {value}
    </Text>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 4 },
  star: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  starText: { fontSize: 30, lineHeight: 36 },
  hint: { fontSize: 13, marginTop: 2 },
  badge: { fontSize: 13, fontWeight: '600' },
});
