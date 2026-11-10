/** Pieces shared by the device screens (T-206, T-207). */
import { useEffect, useState, type ReactNode } from 'react';
import { Platform, StyleSheet, Text, TextInput, View } from 'react-native';

import { useUiColors } from '../hooks/useUiColors';

interface Observable<S> {
  readonly state: S;
  subscribe(fn: () => void): () => void;
}

/** The state of a session (sessions.ts) as React state. */
export function useMachine<S>(m: Observable<S> | null): S | null {
  const [s, setS] = useState<S | null>(m?.state ?? null);
  useEffect(() => {
    if (!m) {
      setS(null);
      return;
    }
    setS(m.state);
    return m.subscribe(() => setS(m.state));
  }, [m]);
  return s;
}

/** Calls `fn` every `ms` while `on`. */
export function usePoll(on: boolean, fn: () => void | Promise<void>, ms = 2000): void {
  useEffect(() => {
    if (!on) return;
    let busy = false;
    const id = setInterval(() => {
      if (busy) return;
      busy = true;
      void Promise.resolve(fn()).finally(() => {
        busy = false;
      });
    }, ms);
    return () => clearInterval(id);
  }, [on, fn, ms]);
}

/** The 12-digit confirmation number, large and spaced, the same on both devices. */
export function Fingerprint({ value, testID }: { value: string; testID?: string }) {
  const c = useUiColors();
  return (
    <View style={[styles.box, { borderColor: c.accent, backgroundColor: c.selectedBg }]}>
      <Text selectable style={[styles.big, { color: c.text }]} maxFontSizeMultiplier={1.6} testID={testID}>
        {value}
      </Text>
    </View>
  );
}

/** The 6-word code, one word per cell (easy to read aloud and to type). */
export function WordsCode({ code, testID }: { code: string; testID?: string }) {
  const c = useUiColors();
  const words = code.split(' ');
  return (
    <View style={[styles.words, { borderColor: c.border, backgroundColor: c.surfaceAlt }]} testID={testID} accessibilityLabel={code}>
      {words.map((w, i) => (
        <Text key={i} style={[styles.word, { color: c.text }]} maxFontSizeMultiplier={1.6}>
          {`${i + 1}. ${w}`}
        </Text>
      ))}
      {/* Hidden copy for selection and tests (the words joined). */}
      <Text selectable style={styles.hidden} testID={testID ? `${testID}-text` : undefined}>
        {code}
      </Text>
    </View>
  );
}

export function ErrorText({ children, testID }: { children: ReactNode; testID?: string }) {
  const c = useUiColors();
  return (
    <Text style={{ color: c.danger, fontSize: 15 }} maxFontSizeMultiplier={2} accessibilityLiveRegion="polite" testID={testID}>
      {children}
    </Text>
  );
}

/** A plain text field for words (no autocorrect, no capitalization). */
export function WordsField({ label, value, onChange, testID, lines = 3, error }: { label: string; value: string; onChange: (v: string) => void; testID: string; lines?: number; error?: boolean }) {
  const c = useUiColors();
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ color: c.text, fontSize: 15, fontWeight: '600' }} maxFontSizeMultiplier={2}>
        {label}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        autoComplete="off"
        multiline={lines > 1}
        accessibilityLabel={label}
        style={[styles.input, { minHeight: lines > 1 ? 24 * lines : 44, color: c.text, borderColor: error ? c.danger : c.border, backgroundColor: c.surface }]}
        maxFontSizeMultiplier={2}
        testID={testID}
      />
    </View>
  );
}

const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

const styles = StyleSheet.create({
  box: { borderWidth: 2, borderRadius: 14, paddingVertical: 12, paddingHorizontal: 16, alignSelf: 'center' },
  big: { fontFamily: mono, fontSize: 26, fontWeight: '700', letterSpacing: 2, textAlign: 'center' },
  words: { borderWidth: 1, borderRadius: 14, padding: 12, flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'center' },
  word: { fontFamily: mono, fontSize: 18, fontWeight: '600', minWidth: 120 },
  hidden: { position: 'absolute', width: 1, height: 1, opacity: 0, overflow: 'hidden' },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, fontSize: 16, textAlignVertical: 'top' },
});
