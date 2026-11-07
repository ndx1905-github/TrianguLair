/** Pieces shared by the invitation and contacts screens. */
import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Platform, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import Svg, { Path, Rect } from 'react-native-svg';

import { Banner, Button, Segmented } from '../components/ui';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import { ToggleRow } from '../firstLaunch/ToggleRow';
import { safetyRows, type AnswerWarning, type ShareScope } from './model';
import { isRetryable, type LinkProblem } from './problems';
import { qrMatrix, qrPath, type Ecc } from './qr';

/** A QR code, always dark on white with its quiet zone (scanners need the contrast). */
export function QrCode({ value, size = 240, ecc = 'M', testID, label }: { value: string; size?: number; ecc?: Ecc; testID?: string; label: string }) {
  const m = qrMatrix(value, ecc);
  const n = m.size + 8;
  return (
    <View style={[styles.qr, { width: size, height: size }]} testID={testID} accessibilityRole="image" accessibilityLabel={label} {...(Platform.OS === 'web' && { dataSet: { qrVersion: String(m.version), qrValue: value } })}>
      <Svg width={size} height={size} viewBox={`0 0 ${n} ${n}`}>
        <Rect x={0} y={0} width={n} height={n} fill="#FFFFFF" />
        <Path d={qrPath(m)} fill="#000000" />
      </Svg>
    </View>
  );
}

/** Opens the share sheet (native, or the Web Share API); falls back to copying. */
export async function shareOrCopy(message: string): Promise<'shared' | 'copied'> {
  if (Platform.OS === 'web') {
    const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { share?: (d: { text: string }) => Promise<void> }) : undefined;
    if (nav?.share) {
      try {
        await nav.share({ text: message });
        return 'shared';
      } catch {
        // Cancelled or refused: copy instead.
      }
    }
    await Clipboard.setStringAsync(message);
    return 'copied';
  }
  await Share.share({ message });
  return 'shared';
}

/** The link as text, with Share and Copy. */
export function LinkActions({ link, message, testID }: { link: string; message: string; testID: string }) {
  const c = useUiColors();
  const { t } = useI18n();
  const [done, setDone] = useState<'shared' | 'copied' | null>(null);
  return (
    <View style={{ gap: 8 }}>
      <Text selectable style={[styles.mono, { color: c.text, backgroundColor: c.surfaceAlt, borderColor: c.border }]} maxFontSizeMultiplier={1.6} testID={`${testID}-link`}>
        {link}
      </Text>
      <View style={styles.row}>
        <Button label={t('contacts.share')} onPress={() => void shareOrCopy(message).then(setDone, () => {})} testID={`${testID}-share`} />
        <Button
          kind="secondary"
          label={done === 'copied' ? t('contacts.copied') : t('contacts.copy')}
          onPress={() => void Clipboard.setStringAsync(link).then(() => setDone('copied'), () => {})}
          testID={`${testID}-copy`}
        />
      </View>
      {done === 'copied' && (
        <Text style={{ color: c.textMuted, fontSize: 13 }} maxFontSizeMultiplier={2} testID={`${testID}-copied`}>
          {t('contacts.copiedHelp')}
        </Text>
      )}
    </View>
  );
}

/** A multi-line paste field with its button. */
export function PasteField({
  label,
  value,
  onChange,
  onSubmit,
  action,
  busy,
  disabled,
  testID,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  action: string;
  busy?: boolean;
  /** Not ready yet (the contacts are opening). */
  disabled?: boolean;
  testID: string;
}) {
  const c = useUiColors();
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: c.textMuted, fontSize: 15, fontWeight: '600' }} maxFontSizeMultiplier={2}>
        {label}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder="https://triangulair.app/…"
        placeholderTextColor={c.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        multiline
        style={[styles.input, { borderColor: c.border, backgroundColor: c.surface, color: c.text }]}
        accessibilityLabel={label}
        maxFontSizeMultiplier={2}
        testID={`${testID}-input`}
      />
      <View style={styles.row}>
        <Button label={action} onPress={onSubmit} disabled={busy || disabled || !value.trim()} testID={`${testID}-open`} />
        {busy && <ActivityIndicator color={c.accent} />}
      </View>
    </View>
  );
}

/** A name field (what I call this person: only on my devices). */
export function NameField({ label, value, onChange, testID, help }: { label: string; value: string; onChange: (v: string) => void; testID: string; help?: string }) {
  const c = useUiColors();
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: c.textMuted, fontSize: 15, fontWeight: '600' }} maxFontSizeMultiplier={2}>
        {label}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        autoCapitalize="words"
        style={[styles.input, { minHeight: 48, borderColor: c.border, backgroundColor: c.surface, color: c.text }]}
        accessibilityLabel={label}
        maxFontSizeMultiplier={2}
        maxLength={80}
        testID={testID}
      />
      {help ? (
        <Text style={{ color: c.textMuted, fontSize: 13 }} maxFontSizeMultiplier={2}>
          {help}
        </Text>
      ) : null}
    </View>
  );
}

/** The 60-digit safety code, 3 groups per row on phones (4 rows), 6 on wide screens. */
export function SafetyCodeGrid({ groups, wide, testID }: { groups: string[]; wide?: boolean; testID: string }) {
  const c = useUiColors();
  const rows = safetyRows(groups, wide ? 6 : 3);
  return (
    <View style={[styles.code, { backgroundColor: c.surfaceAlt, borderColor: c.border }]} testID={testID} accessibilityLabel={groups.join(' ')}>
      {rows.map((r, i) => (
        <Text key={i} style={[styles.codeRow, { color: c.text }]} maxFontSizeMultiplier={1.8}>
          {r.join('  ')}
        </Text>
      ))}
    </View>
  );
}

/** "Verified" (I compared the code) / "Not verified" / "Cannot be checked" (no storage). */
export function TrustBadge({ verified, checkable, testID }: { verified: boolean; checkable: boolean; testID?: string }) {
  const c = useUiColors();
  const { t } = useI18n();
  const kind = verified ? 'verified' : checkable ? 'unverified' : 'uncheckable';
  const color = verified ? c.open : c.warning;
  return (
    <View style={[styles.badge, { borderColor: color }]} testID={testID} {...(Platform.OS === 'web' && { dataSet: { trust: kind } })}>
      <Text style={{ color, fontSize: 12, fontWeight: '700' }} maxFontSizeMultiplier={1.6}>
        {verified ? '✓ ' : ''}
        {t(`contacts.badge.${kind}`)}
      </Text>
    </View>
  );
}

/** What a person can see of mine: everything I share with friends, some lists, or nothing. */
export function ShareChoice({
  value,
  onChange,
  lists,
  testID,
}: {
  value: ShareScope;
  onChange: (s: ShareScope) => void;
  lists: { id: string; name: string }[];
  testID: string;
}) {
  const { t } = useI18n();
  const c = useUiColors();
  return (
    <View style={{ gap: 8 }} testID={testID}>
      <Segmented
        options={[
          { value: 'all', label: t('contacts.scope.all') },
          { value: 'lists', label: t('contacts.scope.lists') },
          { value: 'none', label: t('contacts.scope.none') },
        ]}
        value={value.kind}
        onChange={(k) => onChange(k === 'lists' ? { kind: 'lists', lists: value.kind === 'lists' ? value.lists : [] } : { kind: k })}
        testID={`${testID}-kind`}
      />
      <Text style={{ color: c.textMuted, fontSize: 13 }} maxFontSizeMultiplier={2}>
        {t(`contacts.scope.${value.kind}Help`)}
      </Text>
      {value.kind === 'lists' &&
        (lists.length === 0 ? (
          <Text style={{ color: c.textMuted, fontSize: 14 }} maxFontSizeMultiplier={2}>
            {t('contacts.scope.noLists')}
          </Text>
        ) : (
          lists.map((l) => (
            <ToggleRow
              key={l.id}
              label={l.name}
              value={value.lists.includes(l.id)}
              onChange={(on) => onChange({ kind: 'lists', lists: on ? [...value.lists, l.id] : value.lists.filter((x) => x !== l.id) })}
              testID={`${testID}-list-${l.id}`}
            />
          ))
        ))}
    </View>
  );
}

export function ProblemBanner({ problem, testID }: { problem: LinkProblem; testID?: string }) {
  const { t } = useI18n();
  return (
    <Banner tone="warning" testID={testID ?? 'link-problem'}>
      {t(`contacts.problem.${problem}`)}
      {isRetryable(problem) ? '' : `\n${t('contacts.problem.askNew')}`}
    </Banner>
  );
}

export function WarningBanner({ warning, name, testID }: { warning: AnswerWarning; name: string; testID?: string }) {
  const { t } = useI18n();
  return (
    <Banner tone="warning" testID={testID ?? `answer-warning-${warning}`}>
      {t(`contacts.warning.${warning}`, { name: name || t('contacts.someone') })}
    </Banner>
  );
}

export function Card({ children, testID }: { children: ReactNode; testID?: string }) {
  const c = useUiColors();
  return (
    <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]} testID={testID}>
      {children}
    </View>
  );
}

export function Strong({ children, testID }: { children: ReactNode; testID?: string }) {
  const c = useUiColors();
  return (
    <Text style={{ color: c.text, fontSize: 16, fontWeight: '700' }} maxFontSizeMultiplier={2} testID={testID}>
      {children}
    </Text>
  );
}

/** Short display of an owner key when no name is known yet. */
export function shortKey(owner: string): string {
  const k = owner.replace(/^ed25519:/, '');
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

const styles = StyleSheet.create({
  qr: { alignSelf: 'center', backgroundColor: '#FFFFFF', borderRadius: 8, overflow: 'hidden' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  mono: { fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }), fontSize: 12, borderWidth: 1, borderRadius: 10, padding: 10 },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, fontSize: 16, minHeight: 72, textAlignVertical: 'top' },
  code: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 4, alignItems: 'center' },
  codeRow: { fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }), fontSize: 17, letterSpacing: 1 },
  badge: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, alignSelf: 'flex-start' },
  card: { borderWidth: 1, borderRadius: 14, padding: 14, gap: 10 },
});
