/**
 * The data layer must run in React Native's Hermes engine, which has no
 * WebAssembly: nothing in the runtime dependency tree of this package may
 * ship a .wasm file or call the WebAssembly API (this is why Yjs replaced
 * Automerge, whose core is Rust compiled to WebAssembly).
 *
 * Covers `dependencies` and their own dependencies, transitively. The SQLite
 * drivers are optional peers chosen by the app (better-sqlite3 is native;
 * expo-sqlite is native on Android/iOS).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface Pkg {
  name: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const readPkg = (dir: string) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Pkg;

/** Node's lookup: `node_modules/<name>` in the requiring package's directory, then in each parent. */
function locate(name: string, from: string): string {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dirname(dir) === dir) throw new Error(`dependency ${name} (required from ${from}) is not installed`);
  }
}

function runtimeTree(): Map<string, string> {
  const seen = new Map<string, string>(); // name@dir → dir
  const visit = (dir: string) => {
    const pkg = readPkg(dir);
    const deps = { ...pkg.dependencies, ...pkg.optionalDependencies };
    for (const name of Object.keys(deps)) {
      let at: string;
      try {
        at = locate(name, dir);
      } catch (e) {
        if (pkg.optionalDependencies?.[name]) continue; // optional and absent
        throw e;
      }
      if (seen.has(at)) continue;
      seen.set(at, readPkg(at).name);
      visit(at);
    }
  };
  visit(ROOT);
  return seen;
}

function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue; // nested deps are visited as packages
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) yield* files(p);
    else yield p;
  }
}

const CODE = /\.(c|m)?js$/;

describe('no WebAssembly in the runtime dependency tree', () => {
  const tree = runtimeTree();

  it('the tree is what we expect (Yjs and its helpers, no Automerge)', () => {
    const names = [...new Set(tree.values())].sort();
    expect(names).toContain('yjs');
    expect(names.filter((n) => /automerge|wasm/i.test(n))).toEqual([]);
  });

  it('no package ships a .wasm file or calls WebAssembly', () => {
    const offending: string[] = [];
    for (const dir of [...tree.keys(), join(ROOT, 'src')]) {
      for (const f of files(dir)) {
        if (f.endsWith('.wasm')) offending.push(f);
        else if ((CODE.test(f) || f.endsWith('.ts')) && /\bWebAssembly\s*\./.test(readFileSync(f, 'utf8'))) offending.push(f);
      }
    }
    expect(offending).toEqual([]);
  });

  it('the package source does not import Automerge', () => {
    for (const f of files(join(ROOT, 'src'))) expect(readFileSync(f, 'utf8')).not.toMatch(/@automerge\//);
  });
});
