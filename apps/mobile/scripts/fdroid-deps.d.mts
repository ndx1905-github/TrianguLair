// Types of fdroid-deps.mjs, for its unit test (src/fdroidDeps.test.ts).
export interface Finding {
  artifact: string;
  label: string;
  via: string;
  path: string[];
}
export function parseLine(line: string): { depth: number; name: string } | null;
export function audit(text: string): Finding[];
export function countLibraries(text: string): number;
export function report(findings: Finding[], libraries?: number): string;
