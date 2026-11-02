/**
 * Layout of the first-launch and kit screens: one scrolling column, at most
 * 560 pt wide and centered (tablets, unfolded foldables, landscape), safe
 * margins, the actions at the end of the content so they move with large
 * text instead of covering it.
 */
import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Banner } from '../components/ui';
import { useLayout } from '../hooks/useLayout';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';

export function Frame({
  title,
  lead,
  step,
  children,
  actions,
  testID,
  header,
}: {
  title: string;
  lead?: string;
  /** [n, total] for "Step n of total". */
  step?: [number, number];
  children?: ReactNode;
  actions?: ReactNode;
  testID?: string;
  /** Above the title (back button, logo). */
  header?: ReactNode;
}) {
  const c = useUiColors();
  const insets = useSafeAreaInsets();
  const { gutter, height } = useLayout();
  const { t } = useI18n();
  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: c.background }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          {
            paddingTop: insets.top + (height < 500 ? 12 : 32),
            paddingBottom: insets.bottom + 24,
            paddingLeft: insets.left + gutter + 6,
            paddingRight: insets.right + gutter + 6,
          },
        ]}
        keyboardShouldPersistTaps="handled"
        testID={testID}
      >
        <View style={styles.column}>
          {header}
          {step && (
            <Text style={[styles.step, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
              {t('common.stepOf', { n: step[0], total: step[1] })}
            </Text>
          )}
          <Text style={[styles.title, { color: c.text }]} accessibilityRole="header" maxFontSizeMultiplier={2}>
            {title}
          </Text>
          {lead ? (
            <Text style={[styles.lead, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
              {lead}
            </Text>
          ) : null}
          {children}
          {actions ? <View style={styles.actions}>{actions}</View> : null}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/** Muted paragraph inside a frame. */
function Note({ children }: { children: ReactNode }) {
  const c = useUiColors();
  return (
    <Text style={{ color: c.textMuted, fontSize: 14 }} maxFontSizeMultiplier={2}>
      {children}
    </Text>
  );
}
Frame.Note = Note;

/** "Available with sharing (phase 2)" label. */
export function Phase2Badge() {
  const c = useUiColors();
  const { t } = useI18n();
  return (
    <View style={[styles.badge, { borderColor: c.warning, backgroundColor: c.warningBg }]}>
      <Text style={{ color: c.text, fontSize: 13, fontWeight: '600' }} maxFontSizeMultiplier={2}>
        {t('phase2.badge')}
      </Text>
    </View>
  );
}

/** A choice that is not available yet: label, help, phase-2 badge, not pressable. */
export function UnavailableOption({ label, help, testID }: { label: string; help: string; testID?: string }) {
  const c = useUiColors();
  return (
    <View style={[styles.option, { borderColor: c.border, backgroundColor: c.surface }]} accessibilityState={{ disabled: true }} testID={testID}>
      <Text style={{ color: c.textMuted, fontSize: 16, fontWeight: '700' }} maxFontSizeMultiplier={2}>
        {label}
      </Text>
      <Text style={{ color: c.textMuted, fontSize: 14 }} maxFontSizeMultiplier={2}>
        {help}
      </Text>
      <Phase2Badge />
    </View>
  );
}

/** Warning about where secrets live on the web test build (none on native). */
export function SecretStoreNotice({ kind }: { kind: 'keychain' | 'web-wrapped' | 'web-plain' | 'memory' }) {
  const { t } = useI18n();
  if (kind === 'keychain') return null;
  return (
    <View style={{ marginTop: 16 }}>
      <Banner tone="warning" testID="secret-store-notice">
        {kind === 'memory' ? t('welcome.webMemory') : t('welcome.webTest')}
      </Banner>
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 1, alignItems: 'center' },
  column: { width: '100%', maxWidth: 560, gap: 12 },
  step: { fontSize: 13, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.6 },
  title: { fontSize: 28, fontWeight: '800' },
  lead: { fontSize: 16 },
  actions: { gap: 10, marginTop: 16 },
  badge: { alignSelf: 'flex-start', borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  option: { borderWidth: 1, borderRadius: 14, padding: 14, gap: 6 },
});
