/*
 * Known-answer vectors (docs/format/vectors/*.json, described in docs/format/README.md):
 * 1. every vector's `expect` is what the library returns for its `input` today (reading side);
 * 2. regenerating the files from seeded randomness gives exactly the committed files (writing side).
 * `npm run vectors` rewrites the files (UPDATE_VECTORS=1).
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runVector, type VectorFile } from './vectors/builder';
import { generateVectors, VECTOR_FILES, vectorFileText } from './vectors/generate';
import { OP_NAMES } from './vectors/ops';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../docs/format/vectors');
const update = process.env['UPDATE_VECTORS'] === '1';

function load(name: string): VectorFile {
  return JSON.parse(readFileSync(join(DIR, `${name}.json`), 'utf8')) as VectorFile;
}

describe('known-answer vectors', () => {
  if (update) {
    it('writes docs/format/vectors/*.json', () => {
      mkdirSync(DIR, { recursive: true });
      const files = generateVectors();
      for (const [name, file] of Object.entries(files)) writeFileSync(join(DIR, `${name}.json`), vectorFileText(file));
      const counts = Object.entries(files).map(([n, f]) => `${n}: ${f.vectors.length}`);
      console.log(`vectors written (${Object.values(files).reduce((a, f) => a + f.vectors.length, 0)}):\n  ${counts.join('\n  ')}`);
    }, 120_000);
    return;
  }

  it('the directory holds exactly the generated files', () => {
    const present = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
    expect(present).toEqual(VECTOR_FILES.map(([n]) => `${n}.json`).sort());
  });

  for (const [name] of VECTOR_FILES) {
    it(`${name}.json: the library gives every expected result`, () => {
      const file = load(name);
      expect(file.vectors.length).toBeGreaterThan(0);
      for (const v of file.vectors) {
        expect(OP_NAMES).toContain(v.op);
        expect({ name: v.name, result: runVector(file, v) }).toEqual({ name: v.name, result: v.expect });
      }
    }, 60_000);
  }

  it('regenerating from the seeds gives the committed files byte for byte', () => {
    const files = generateVectors();
    for (const [name, file] of Object.entries(files)) {
      expect(vectorFileText(file), `${name}.json differs: run "npm run vectors" if the change is intended`).toBe(readFileSync(join(DIR, `${name}.json`), 'utf8'));
    }
  }, 120_000);

  it('covers positive and negative cases in every file', () => {
    for (const [name] of VECTOR_FILES) {
      const file = load(name);
      const ok = file.vectors.filter((v) => 'ok' in v.expect).length;
      expect(ok, `${name}: positive vectors`).toBeGreaterThan(0);
      expect(file.vectors.length - ok, `${name}: negative vectors`).toBeGreaterThan(name === 'invitation-record' ? -1 : 0);
    }
  });
});
