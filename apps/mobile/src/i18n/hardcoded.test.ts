/**
 * No UI string is hard-coded in components (spec "Languages": texts
 * externalized). Parses every .tsx file and fails on JSX text containing a
 * letter, and on literal strings given to the props that are shown or read
 * aloud (label, title, placeholder, accessibilityLabel…). Symbols (✓, ✕, ‹, +)
 * and URL placeholders are allowed.
 */
import { parse } from '@babel/parser';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';

declare global {
  interface ImportMeta {
    /** Vite: the matching files' contents, read at transform time. */
    glob(pattern: string | string[], options: { query: '?raw'; import: 'default'; eager: true }): Record<string, string>;
  }
}

/** Every component source (`.tsx`), by path relative to this folder. */
const SOURCES = import.meta.glob(['../**/*.tsx', '!../**/*.test.tsx'], { query: '?raw', import: 'default', eager: true });
const VISIBLE_PROPS = new Set(['label', 'title', 'lead', 'placeholder', 'accessibilityLabel', 'accessibilityHint', 'removeLabel', 'help', 'message', 'alt']);
const LETTER = /\p{L}/u;
const ALLOWED = [/^https?:\/\/\S*$/];

export function hardcodedStrings(source: string, fileName = 'x.tsx'): string[] {
  // Babel's parser (the one Metro uses): TypeScript 7 no longer ships the JavaScript compiler API.
  const file = parse(source, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
  const found: string[] = [];
  const flag = (text: string, node: t.Node) => {
    const v = text.trim();
    if (!v || !LETTER.test(v) || ALLOWED.some((r) => r.test(v))) return;
    found.push(`${fileName}:${node.loc?.start.line ?? 0}: ${v.slice(0, 60)}`);
  };
  /** The text of a string literal or of a template literal without substitutions, else null. */
  const literal = (e: t.Node): string | null =>
    t.isStringLiteral(e) ? e.value : t.isTemplateLiteral(e) && e.expressions.length === 0 ? (e.quasis[0]?.value.cooked ?? null) : null;
  t.traverse(file, (node, ancestors) => {
    if (t.isJSXText(node)) flag(node.value, node);
    // {'Literal'} as a child.
    const parent = ancestors[ancestors.length - 1]?.node;
    if (t.isJSXExpressionContainer(node) && (t.isJSXElement(parent) || t.isJSXFragment(parent))) {
      const text = literal(node.expression);
      if (text !== null) flag(text, node.expression);
    }
    if (t.isJSXAttribute(node) && t.isJSXIdentifier(node.name) && VISIBLE_PROPS.has(node.name.name) && node.value) {
      const init = node.value;
      if (t.isStringLiteral(init)) flag(init.value, init);
      else if (t.isJSXExpressionContainer(init)) {
        const text = literal(init.expression);
        if (text !== null) flag(text, init.expression);
      }
    }
  });
  return found;
}

describe('hard-coded UI strings', () => {
  it('detects literal JSX text and visible props', () => {
    const src = `const a = <View><Text>Hello</Text><Text>{t('x')}</Text><Text>✓</Text><B label="Save" testID="save-button" /><B placeholder="https://…" /><B title={'Oops'} /><Text>{'Bye'}</Text></View>;`;
    expect(hardcodedStrings(src).map((s) => s.split(': ')[1])).toEqual(['Hello', 'Save', 'Oops', 'Bye']);
  });

  it('finds none in the app components', () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(50);
    const all = Object.entries(SOURCES).flatMap(([f, src]) => hardcodedStrings(src, f));
    expect(all).toEqual([]);
  });
});
