import { run, type Json, type JsonObj } from './ops';

export interface Vector {
  name: string;
  description: string;
  op: string;
  input: JsonObj;
  expect: JsonObj;
  /** Informational intermediate values (derivations, signed bytes...): checked by regeneration only. */
  details?: JsonObj;
}

export interface VectorFile {
  structure: string;
  /** Specification file in docs/format/. */
  spec: string;
  description: string;
  generator: string;
  /** Named values that inputs reference as {"$ref": "<name>"}. */
  fixtures: JsonObj;
  vectors: Vector[];
}

/** Replaces every {"$ref": name} (an object with that single key) by fixtures[name], recursively. */
export function resolve(v: Json, fixtures: JsonObj): Json {
  if (Array.isArray(v)) return v.map((x) => resolve(x, fixtures));
  if (typeof v === 'object' && v !== null) {
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === '$ref') {
      const name = v['$ref'] as string;
      if (!(name in fixtures)) throw new Error(`vector: unknown fixture ${name}`);
      return resolve(fixtures[name] as Json, fixtures);
    }
    const out: JsonObj = {};
    for (const k of keys) out[k] = resolve(v[k] as Json, fixtures);
    return out;
  }
  return v;
}

export function runVector(file: VectorFile, v: Vector): JsonObj {
  return run(v.op, resolve(v.input, file.fixtures) as JsonObj);
}

export class FileBuilder {
  readonly file: VectorFile;
  private readonly names = new Set<string>();
  constructor(structure: string, spec: string, description: string) {
    this.file = {
      structure,
      spec,
      description,
      generator: 'packages/crypto/test/vectors/generate.ts (npm run vectors in packages/crypto)',
      fixtures: {},
      vectors: [],
    };
  }

  fixture(name: string, value: Json): JsonObj {
    if (name in this.file.fixtures) throw new Error(`fixture ${name} defined twice`);
    this.file.fixtures[name] = value;
    return { $ref: name };
  }

  /**
   * Adds a vector. `want` is "ok" or the error code the vector is meant to show; generation fails
   * if the library does anything else, so every vector says what it was written to say.
   */
  add(name: string, description: string, op: string, input: JsonObj, want: string, details?: JsonObj, check?: (expect: JsonObj) => void): void {
    if (this.names.has(name)) throw new Error(`${this.file.structure}: duplicate vector ${name}`);
    this.names.add(name);
    const v: Vector = { name, description, op, input, expect: {} };
    if (details !== undefined) v.details = details;
    v.expect = runVector(this.file, v);
    const got = 'ok' in v.expect ? 'ok' : (v.expect['error'] as string);
    if (got !== want) throw new Error(`${this.file.structure}/${name}: wanted ${want}, got ${JSON.stringify(v.expect).slice(0, 300)}`);
    check?.(v.expect);
    this.file.vectors.push(v);
  }
}
