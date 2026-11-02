// SPDX-License-Identifier: MPL-2.0
/** The package runs in Hermes (no WebAssembly) and browsers: its own runtime dependency, fflate, must stay pure JS. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe('no WebAssembly', () => {
  it('fflate and the sources contain no .wasm file and no WebAssembly call', () => {
    const roots = [fileURLToPath(new URL('../node_modules/fflate', import.meta.url)), fileURLToPath(new URL('../src', import.meta.url))];
    for (const root of roots) {
      for (const f of files(root)) {
        expect(f.endsWith('.wasm'), f).toBe(false);
        if (/\.(c|m)?js$|\.ts$/.test(f)) expect(readFileSync(f, 'utf8').includes('WebAssembly.'), f).toBe(false);
      }
    }
  });

  it('the sources use no DOM API (DOMParser, TextDecoder) unavailable in Hermes', () => {
    for (const f of files(fileURLToPath(new URL('../src', import.meta.url)))) {
      const src = readFileSync(f, 'utf8');
      expect(/new (DOMParser|TextDecoder|DOMException)\b/.test(src), f).toBe(false);
    }
  });
});
