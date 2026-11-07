/** Pieces shared by the storage screens: form fields, test results with fixes, master key prompt. */
import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ScreenHeader } from '../components/ScreenHeader';
import { Button, SectionTitle } from '../components/ui';
import { useLayout } from '../hooks/useLayout';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import { useIdentity, useReadyIdentity } from '../identity/IdentityProvider';
import type { MasterKeySource } from './certify';
import type { DraftProblem } from './config';
import type { Fix, StepStatus, TestStep } from './connectionTest';

/** Screen frame of the storage screens: header, one centered column (640 pt). */
export function StorageScreen({ title, children, testID }: { title: string; children: ReactNode; testID?: string }) {
  const c = useUiColors();
  const insets = useSafeAreaInsets();
  const { gutter } = useLayout();
  const router = useRouter();
  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ScreenHeader title={title} onBack={() => (router.canGoBack() ? router.back() : router.replace('/settings'))} />
      <ScrollView
        contentContainerStyle={{ paddingLeft: gutter + insets.left, paddingRight: gutter + insets.right, paddingBottom: insets.bottom + 32, alignItems: 'center' }}
        keyboardShouldPersistTaps="handled"
        testID={testID}
      >
        <View style={styles.column}>{children}</View>
      </ScrollView>
    </View>
  );
}

export function Muted({ children, testID }: { children: ReactNode; testID?: string }) {
  const c = useUiColors();
  return (
    <Text style={{ color: c.textMuted, fontSize: 14 }} maxFontSizeMultiplier={2} testID={testID}>
      {children}
    </Text>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={{ gap: 10 }}>
      <SectionTitle>{title}</SectionTitle>
      {children}
    </View>
  );
}

/** A labelled text field; problems (errors and warnings) under it. */
export function Field({
  label,
  value,
  onChange,
  help,
  placeholder,
  secret,
  problems = [],
  testID,
  keyboard,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  help?: string;
  placeholder?: string;
  secret?: boolean;
  problems?: DraftProblem[];
  testID?: string;
  keyboard?: 'url' | 'default';
}) {
  const c = useUiColors();
  const { t } = useI18n();
  const error = problems.some((p) => p.level === 'error');
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ color: c.text, fontSize: 15, fontWeight: '600' }} maxFontSizeMultiplier={2} nativeID={testID ? `${testID}-label` : undefined}>
        {label}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={c.textMuted}
        secureTextEntry={secret}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        autoComplete="off"
        keyboardType={keyboard === 'url' ? 'url' : 'default'}
        accessibilityLabel={label}
        style={[styles.input, { color: c.text, borderColor: error ? c.danger : c.border, backgroundColor: c.surface }]}
        maxFontSizeMultiplier={2}
        testID={testID}
      />
      {help ? <Muted>{help}</Muted> : null}
      {problems.map((p) => (
        <Text key={p.code} style={{ color: p.level === 'error' ? c.danger : c.warning, fontSize: 14 }} maxFontSizeMultiplier={2} testID={testID ? `${testID}-problem` : undefined}>
          {t(`storage.problem.${p.code}`)}
        </Text>
      ))}
    </View>
  );
}

/** A choice card (protocol). */
export function ChoiceCard({ title, help, selected, onPress, disabled, badge, testID }: { title: string; help: string; selected?: boolean; onPress?: () => void; disabled?: boolean; badge?: string; testID?: string }) {
  const c = useUiColors();
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      style={({ pressed }) => [styles.card, { borderColor: selected ? c.accent : c.border, backgroundColor: selected ? c.selectedBg : c.surface, opacity: disabled ? 0.6 : pressed ? 0.85 : 1 }]}
      accessibilityRole="radio"
      aria-checked={!!selected}
      aria-disabled={!!disabled}
      accessibilityLabel={title}
      testID={testID}
    >
      <View style={styles.cardHead}>
        <Text style={{ color: c.text, fontSize: 16, fontWeight: '700', flexShrink: 1 }} maxFontSizeMultiplier={2}>
          {title}
        </Text>
        {badge ? (
          <View style={[styles.badge, { borderColor: c.warning, backgroundColor: c.warningBg }]}>
            <Text style={{ color: c.text, fontSize: 12, fontWeight: '600' }} maxFontSizeMultiplier={2}>
              {badge}
            </Text>
          </View>
        ) : null}
      </View>
      <Text style={{ color: c.textMuted, fontSize: 14 }} maxFontSizeMultiplier={2}>
        {help}
      </Text>
    </Pressable>
  );
}

const ICON: Record<StepStatus, string> = { running: '…', ok: '✓', warn: '!', fail: '✕', skip: '–' };

export function CopyBlock({ text, testID }: { text: string; testID?: string }) {
  const c = useUiColors();
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <View style={{ gap: 6 }}>
      <ScrollView horizontal style={[styles.code, { backgroundColor: c.surfaceAlt, borderColor: c.border }]} contentContainerStyle={{ padding: 10 }}>
        <Text selectable style={{ color: c.text, fontSize: 12, fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }) }} maxFontSizeMultiplier={1.6} testID={testID}>
          {text}
        </Text>
      </ScrollView>
      <View style={{ alignSelf: 'flex-start' }}>
        <Button
          kind="secondary"
          label={copied ? t('storage.copied') : t('storage.copy')}
          onPress={() => {
            void Clipboard.setStringAsync(text).then(() => setCopied(true), () => {});
          }}
        />
      </View>
    </View>
  );
}

function FixView({ fix }: { fix: Fix }) {
  const c = useUiColors();
  const { t } = useI18n();
  return (
    <View style={{ gap: 6 }} testID={`fix-${fix.id}`}>
      <Text style={{ color: c.text, fontSize: 14 }} maxFontSizeMultiplier={2}>
        {t(`storage.fix.${fix.id}`, fix.params)}
      </Text>
      {fix.copy ? <CopyBlock text={fix.copy} testID={`fix-${fix.id}-copy`} /> : null}
    </View>
  );
}

/** The test steps as they run, each with its outcome and fixes. */
export function TestResults({ steps }: { steps: TestStep[] }) {
  const c = useUiColors();
  const { t } = useI18n();
  const color = (s: StepStatus) => (s === 'ok' ? c.open : s === 'fail' ? c.danger : s === 'warn' ? c.warning : c.textMuted);
  return (
    <View style={{ gap: 8 }} testID="test-results">
      {steps.map((s, i) => (
        <View key={`${s.id}-${i}`} style={[styles.step, { borderColor: c.border, backgroundColor: c.surface }]} testID={`step-${s.id}`}>
          <View style={styles.stepHead}>
            {s.status === 'running' ? (
              <ActivityIndicator size="small" color={c.accent} />
            ) : (
              <Text style={[styles.icon, { color: '#FFFFFF', backgroundColor: color(s.status) }]} maxFontSizeMultiplier={1.4} accessibilityLabel={t(`storage.status.${s.status}`)} testID={`step-${s.id}-${s.status}`}>
                {ICON[s.status]}
              </Text>
            )}
            <Text style={{ color: c.text, fontSize: 15, fontWeight: '600', flexShrink: 1 }} maxFontSizeMultiplier={2}>
              {t(`storage.step.${s.id}`)}
            </Text>
          </View>
          {s.status !== 'running' && (
            <Text style={{ color: c.textMuted, fontSize: 14 }} maxFontSizeMultiplier={2} testID={`step-${s.id}-outcome`}>
              {t(`storage.test.${s.id}.${s.outcome}`)}
              {s.detail ? ` (${s.detail})` : ''}
            </Text>
          )}
          {s.fixes.map((f) => (
            <FixView key={f.id} fix={f} />
          ))}
        </View>
      ))}
    </View>
  );
}

/**
 * The master key for certifying a read address: one tap on the primary device, else the 12
 * words (checked against my identity before anything is done).
 */
export function MasterKeyPrompt({ onReady, busy, actionLabel, testID }: { onReady: (m: MasterKeySource) => void; busy?: boolean; actionLabel: string; testID?: string }) {
  const c = useUiColors();
  const { t } = useI18n();
  const identity = useReadyIdentity();
  const { checkPhrase } = useIdentity();
  const [phrase, setPhrase] = useState('');
  const [wrong, setWrong] = useState(false);
  if (identity.record.primary) {
    return (
      <View style={{ gap: 8 }} testID={testID}>
        <Muted>{t('storage.master.primary')}</Muted>
        <Button label={actionLabel} onPress={() => onReady({ kind: 'primary' })} disabled={busy} testID="master-go" />
      </View>
    );
  }
  const words = phrase.trim().split(/\s+/).filter(Boolean).length;
  return (
    <View style={{ gap: 8 }} testID={testID}>
      <Muted>{t('storage.master.phrase')}</Muted>
      <TextInput
        value={phrase}
        onChangeText={(v) => {
          setPhrase(v);
          setWrong(false);
        }}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        autoComplete="off"
        multiline
        accessibilityLabel={t('settings.primaryPhrase')}
        style={[styles.input, { minHeight: 72, textAlignVertical: 'top', color: c.text, borderColor: wrong ? c.danger : c.border, backgroundColor: c.surface }]}
        maxFontSizeMultiplier={2}
        testID="master-phrase"
      />
      {wrong && (
        <Text style={{ color: c.danger }} maxFontSizeMultiplier={2}>
          {t('settings.primaryMismatch')}
        </Text>
      )}
      <Button
        label={actionLabel}
        disabled={busy || words !== 12}
        onPress={() => {
          void checkPhrase(phrase).then((ok) => (ok ? onReady({ kind: 'phrase', phrase }) : setWrong(true)));
        }}
        testID="master-go"
      />
    </View>
  );
}

/** A progress bar with its label. */
export function ProgressBar({ value, label, testID }: { value: number; label: string; testID?: string }) {
  const c = useUiColors();
  const pct = Math.max(0, Math.min(1, value));
  return (
    <View style={{ gap: 6 }} testID={testID}>
      <View style={[styles.track, { backgroundColor: c.surfaceAlt, borderColor: c.border }]} accessibilityRole="progressbar" aria-valuenow={Math.round(pct * 100)} aria-valuemin={0} aria-valuemax={100}>
        <View style={{ width: `${pct * 100}%`, height: '100%', backgroundColor: c.accent, borderRadius: 6 }} />
      </View>
      <Muted>{label}</Muted>
    </View>
  );
}

export function formatBytes(n: number, locale: string): string {
  const units = ['B', 'kB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: i === 0 ? 0 : 1 }).format(v)} ${units[i]}`;
}

const styles = StyleSheet.create({
  column: { width: '100%', maxWidth: 640, gap: 10 },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, fontSize: 16, minHeight: 44 },
  card: { borderWidth: 1.5, borderRadius: 14, padding: 12, gap: 4 },
  cardHead: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  badge: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  step: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 8 },
  stepHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  icon: { width: 22, height: 22, borderRadius: 11, textAlign: 'center', fontSize: 13, fontWeight: '800', lineHeight: 22, overflow: 'hidden' },
  code: { borderWidth: 1, borderRadius: 10, maxHeight: 260 },
  track: { height: 12, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
});
