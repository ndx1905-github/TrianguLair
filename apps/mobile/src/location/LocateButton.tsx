import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';

import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import { locateMe, type Fix } from './index';

/** How long a "could not find you" notice stays. */
const NOTICE_MS = 6_000;

type NoticeKey = 'locate.denied' | 'locate.disabled' | 'locate.unavailable' | 'locate.stale';

/**
 * "Center on me": one position when pressed (no tracking), then `onFound`. The notice explains a
 * failure (permission, location off, no fix) or a stale position; the screen shows it.
 */
export function useLocate(onFound: (fix: Fix) => void) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeKey | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const show = (key: NoticeKey | null) => {
    if (timer.current) clearTimeout(timer.current);
    setNotice(key);
    if (key) timer.current = setTimeout(() => alive.current && setNotice(null), NOTICE_MS);
  };
  const run = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    show(null);
    try {
      const r = await locateMe();
      if (!alive.current) return;
      if (r.ok) {
        onFound(r.fix);
        if (r.stale) show('locate.stale');
      } else {
        show(`locate.${r.reason}`);
      }
    } finally {
      if (alive.current) setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, onFound]);
  return { busy, notice, run };
}

export function LocateButton({ busy, onPress }: { busy: boolean; onPress: () => void }) {
  const c = useUiColors();
  const { t } = useI18n();
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      style={[styles.button, { backgroundColor: c.surface, borderColor: c.border, shadowColor: c.shadow }]}
      accessibilityRole="button"
      accessibilityLabel={busy ? t('nav.locateBusyA11y') : t('nav.locateA11y')}
      aria-busy={busy}
      aria-disabled={busy}
      testID="locate-me"
    >
      {busy ? (
        <ActivityIndicator color={c.accent} />
      ) : (
        <Text style={[styles.icon, { color: c.accent }]} maxFontSizeMultiplier={1.4}>
          ◎
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 48,
    height: 48,
    borderRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOpacity: 0.15,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  icon: { fontSize: 26, fontWeight: '600', marginTop: -2 },
});
