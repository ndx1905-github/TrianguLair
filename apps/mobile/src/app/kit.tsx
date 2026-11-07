/**
 * Recovery kit (spec "Recovery kit"): the 12 words, shown on demand while
 * they are still on this device, the export formats (password manager entry,
 * clipboard field by field with clearing after one minute, printable page),
 * then a check of 3 words, after which the phrase is erased from the device.
 */
import { useEffect, useMemo, useState } from 'react';
import { Platform, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { Redirect, useRouter } from 'expo-router';

import { Banner, Button, SectionTitle } from '../components/ui';
import { Frame } from '../firstLaunch/Frame';
import { useLayout } from '../hooks/useLayout';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import { copySecret, onClipboardCleared } from '../identity/clipboard';
import { useIdentity } from '../identity/IdentityProvider';
import { checkWords, clipboardFields, kitEntry, passwordManagerText, phraseWords, pickCheckIndexes, printableKitHtml, type KitInput } from '../identity/kit';
import { printHtml } from '../identity/print';
import { protocolOf } from '../storage/config';
import { useStorage } from '../storage/StorageProvider';

type Phase = 'show' | 'check' | 'done';

export default function KitScreen() {
  const { state, readPendingPhrase, confirmKit } = useIdentity();
  const tr = useI18n();
  const { t, locale } = tr;
  const c = useUiColors();
  const router = useRouter();
  const storage = useStorage();
  const { fontScale, width } = useLayout();
  const [phrase, setPhrase] = useState<string | null | undefined>(undefined);
  const [shown, setShown] = useState(false);
  const [phase, setPhase] = useState<Phase>('show');
  const [message, setMessage] = useState<string | null>(null);
  const [typed, setTyped] = useState(['', '', '']);
  const [wrong, setWrong] = useState(false);
  const indexes = useMemo(() => pickCheckIndexes(), []);

  const ready = state.kind === 'ready';
  useEffect(() => {
    if (!ready) return;
    let live = true;
    void readPendingPhrase().then((p) => live && setPhrase(p));
    const off = onClipboardCleared(() => live && setMessage(t('kit.cleared')));
    return () => {
      live = false;
      off();
      // Do not keep the words in memory once the screen is gone.
      setPhrase(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  if (state.kind === 'none') return <Redirect href="/welcome" />;
  if (state.kind !== 'ready' || phrase === undefined) return <Frame title={t('kit.title')} />;

  const back = () => (router.canGoBack() ? router.back() : router.replace('/'));

  if (phase === 'done' || !phrase) {
    const saved = state.record.kitSavedAt;
    return (
      <Frame
        title={phase === 'done' ? t('kit.done.title') : t('kit.title')}
        lead={phase === 'done' ? t('kit.done.lead') : saved ? t('kit.saved', { date: new Date(saved).toLocaleDateString(locale) }) : t('kit.gone')}
        testID="kit-done"
        actions={<Button label={phase === 'done' ? t('kit.done.back') : t('common.back')} onPress={back} testID="kit-back" />}
      />
    );
  }

  const cur = storage.state.current;
  const input: KitInput = { phrase, owner: state.record.owner, readAddress: cur?.readUrl ?? null, protocol: cur ? t(`storage.protocol.${protocolOf(cur)}`) : null, name: state.profile.name, date: new Date() };
  const entry = kitEntry(input, t);
  const words = phraseWords(phrase);

  if (phase === 'check') {
    const confirm = async () => {
      if (checkWords(phrase, indexes, typed).every(Boolean)) {
        await confirmKit();
        setPhrase(null);
        setPhase('done');
      } else {
        setWrong(true);
      }
    };
    return (
      <Frame
        title={t('kit.check.title')}
        lead={t('kit.check.lead')}
        testID="kit-check"
        actions={
          <>
            <Button label={t('kit.check.confirm')} onPress={() => void confirm()} disabled={typed.some((w) => !w.trim())} testID="kit-confirm" />
            <Button kind="secondary" label={t('kit.check.back')} onPress={() => setPhase('show')} />
          </>
        }
      >
        {indexes.map((i, n) => (
          <View key={i} style={{ gap: 4 }}>
            <Text style={{ color: c.text, fontSize: 15, fontWeight: '600' }} maxFontSizeMultiplier={2}>
              {t('kit.check.word', { n: i + 1 })}
            </Text>
            <TextInput
              value={typed[n]}
              onChangeText={(v) => {
                setWrong(false);
                setTyped((cur) => cur.map((x, k) => (k === n ? v : x)));
              }}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              autoComplete="off"
              importantForAutofill="no"
              style={[styles.input, { color: c.text, borderColor: wrong ? c.danger : c.border, backgroundColor: c.surface }]}
              accessibilityLabel={t('kit.check.word', { n: i + 1 })}
              maxFontSizeMultiplier={2}
              testID={`kit-word-${n}`}
            />
          </View>
        ))}
        {wrong && (
          <Text style={{ color: c.danger }} maxFontSizeMultiplier={2} accessibilityLiveRegion="polite" testID="kit-wrong">
            {t('kit.check.wrong')}
          </Text>
        )}
      </Frame>
    );
  }

  const share = async () => {
    try {
      await Share.share({ message: passwordManagerText(entry, t), title: entry.title });
    } catch {
      setMessage(t('kit.shareFailed'));
    }
  };
  const print = async () => {
    try {
      await printHtml(printableKitHtml(input, t, locale));
    } catch {
      setMessage(t('kit.printFailed'));
    }
  };
  const copy = async (value: string) => setMessage((await copySecret(value)) ? t('kit.copied') : t('kit.shareFailed'));

  // Word cells: as many columns as fit (3 on wide screens, 1 with very large text on a small phone).
  const cellMin = Math.min(Math.max(120, 104 * fontScale), width - 48);

  return (
    <Frame
      title={t('kit.title')}
      lead={t('kit.lead')}
      testID="kit"
      header={
        <View style={{ alignSelf: 'flex-start' }}>
          <Button kind="secondary" label={`‹ ${t('common.back')}`} onPress={back} testID="back" />
        </View>
      }
      actions={<Button label={t('kit.next')} onPress={() => setPhase('check')} disabled={!shown} testID="kit-next" />}
    >
      {!cur && <Banner tone="warning">{t('kit.localOnlyNote')}</Banner>}
      <SectionTitle>{t('kit.phraseLabel')}</SectionTitle>
      {shown ? (
        <>
          <View style={styles.grid} testID="kit-words">
            {words.map((w, i) => (
              <View
                key={i}
                style={[styles.cell, { minWidth: cellMin, borderColor: c.border, backgroundColor: c.surface }]}
                accessible
                accessibilityLabel={t('kit.word', { n: i + 1, word: w })}
              >
                <Text style={{ color: c.textMuted, fontSize: 13, minWidth: 22 }} maxFontSizeMultiplier={2}>
                  {i + 1}
                </Text>
                <Text style={{ color: c.text, fontSize: 18, fontWeight: '700', flexShrink: 1 }} maxFontSizeMultiplier={2} selectable={false}>
                  {w}
                </Text>
              </View>
            ))}
          </View>
          <Button kind="secondary" label={t('kit.hide')} onPress={() => setShown(false)} testID="kit-hide" />
        </>
      ) : (
        <View style={{ gap: 8 }}>
          <Text style={{ color: c.textMuted, fontSize: 14 }} maxFontSizeMultiplier={2}>
            {t('kit.revealHelp')}
          </Text>
          <Button label={t('kit.reveal')} onPress={() => setShown(true)} testID="kit-reveal" />
        </View>
      )}
      <Frame.Note>{t('kit.onceNote')}</Frame.Note>

      <SectionTitle>{t('kit.export')}</SectionTitle>
      <View style={{ gap: 8 }}>
        <Button kind="secondary" label={t('kit.export.manager')} onPress={() => void share()} testID="kit-share" />
        {clipboardFields(entry, t).map((f) => (
          <Button key={f.key} kind="secondary" label={f.label} onPress={() => void copy(f.value)} testID={`kit-copy-${f.key}`} />
        ))}
        <Button
          kind="secondary"
          label={Platform.OS === 'web' ? t('kit.export.printWeb') : t('kit.export.print')}
          onPress={() => void print()}
          testID="kit-print"
        />
        {message && <Banner testID="kit-message">{message}</Banner>}
      </View>
    </Frame>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  cell: { flexGrow: 1, flexBasis: 0, flexDirection: 'row', alignItems: 'baseline', gap: 8, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10 },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, fontSize: 17, minHeight: 48 },
});
