/**
 * No UI string is hard-coded in components (spec "Languages": texts
 * externalized). Parses every .tsx file and fails on JSX text containing a
 * letter, and on literal strings given to the props that are shown or read
 * aloud (label, title, placeholder, accessibilityLabel…). Symbols (✓, ✕, ‹, +)
 * and URL placeholders are allowed.
 */
import ts from 'typescript';
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
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const flag = (text: string, node: ts.Node) => {
    const v = text.trim();
    if (!v || !LETTER.test(v) || ALLOWED.some((r) => r.test(v))) return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
    found.push(`${fileName}:${line + 1}: ${v.slice(0, 60)}`);
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) flag(node.text, node);
    // {'Literal'} as a child.
    if (ts.isJsxExpression(node) && node.parent && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent)) && node.expression) {
      const e = node.expression;
      if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) flag(e.text, e);
    }
    if (ts.isJsxAttribute(node) && VISIBLE_PROPS.has(node.name.getText(sf)) && node.initializer) {
      const init = node.initializer;
      if (ts.isStringLiteral(init)) flag(init.text, init);
      else if (ts.isJsxExpression(init) && init.expression && (ts.isStringLiteral(init.expression) || ts.isNoSubstitutionTemplateLiteral(init.expression))) {
        flag(init.expression.text, init.expression);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
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
