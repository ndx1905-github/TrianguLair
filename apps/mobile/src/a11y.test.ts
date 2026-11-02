/// <reference types="node" />
/**
 * react-native-web (0.21) ignores the `accessibilityState` prop: checked, selected, expanded and
 * disabled states were not exposed on web at all (found by the end-to-end tests, T-119). The
 * `aria-*` props work on both native and web, so components use those.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.tsx?$/.test(name) && !name.endsWith('.test.ts') ? [p] : [];
  });
}

describe('accessibility states', () => {
  it('uses aria-* props, not accessibilityState (dropped on web)', () => {
    const offenders = sources(dirname(fileURLToPath(import.meta.url))).filter((p) => /accessibilityState\s*=/.test(readFileSync(p, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
