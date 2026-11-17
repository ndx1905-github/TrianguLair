// SPDX-License-Identifier: MPL-2.0
/**
 * The sync package's own runtime dependency (fflate) and its sources use no WebAssembly (Hermes has
 * none). libsodium-wrappers-sumo (app-level signatures in the vault, sign.ts) is the crypto package's
 * own dependency, already in the app, which runs it without WebAssembly (asm.js fallback).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

describe('no WebAssembly', () => {
  it('fflate and src', () => {
    const files = [...walk(join(__dirname, '../node_modules/fflate')), ...walk(join(__dirname, '../src'))];
    expect(files.filter((f) => f.endsWith('.wasm'))).toEqual([]);
    const js = files.filter((f) => /\.(c|m)?js$|\.ts$/.test(f));
    expect(js.filter((f) => readFileSync(f, 'utf8').includes('WebAssembly.'))).toEqual([]);
    const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));
    // libsodium-wrappers-sumo: the crypto package's own copy (list keys, lists.ts), which falls back to asm.js
    // where WebAssembly is missing (Hermes); the app bundles one copy for both.
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@triangulair/crypto', '@triangulair/data', '@triangulair/storage', 'fflate', 'libsodium-wrappers-sumo']);
  });
});
