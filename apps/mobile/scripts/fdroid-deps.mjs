#!/usr/bin/env node
// F-Droid dependency audit (spec-coverage gap 9).
//
// Reads the output of `./gradlew :app:dependencies --configuration releaseRuntimeClasspath`
// and flags proprietary Google libraries (Play Services, Firebase, ML Kit), with the
// module that pulls each one in (e.g. expo-location, expo-camera).
//
// Usage: node scripts/fdroid-deps.mjs <dependencies.txt> [summary.md]
// Writes a Markdown report to summary.md (or stdout) and prints one GitHub
// `::warning::` line per finding. Always exits 0: this is a report, not a gate.
import { readFileSync, appendFileSync } from 'node:fs';

const FLAGGED = [
  { re: /^com\.google\.android\.gms:/, label: 'Google Play Services' },
  { re: /^com\.google\.firebase:/, label: 'Firebase' },
  { re: /^com\.google\.mlkit:/, label: 'ML Kit' },
  { re: /^com\.google\.android\.odml:/, label: 'ML Kit (on-device runtime)' },
  { re: /^com\.google\.android\.play:/, label: 'Google Play Core' },
];

// Ancestors that do not explain *why* a library is there (the app itself,
// Expo's umbrella project, and other Google / Android support libraries).
const NOT_A_CULPRIT = /^(project :app$|project :expo$|com\.google\.|androidx\.|org\.jetbrains\.|com\.android\.)/;

/** Parses one line of Gradle's tree output into { depth, name } or null. */
export function parseLine(line) {
  const m = /^([| ]*)[+\\]--- (.+)$/.exec(line);
  if (!m) return null;
  const depth = m[1].length / 5;
  // "group:artifact:1.0 -> 1.1 (*)" → "group:artifact:1.1"; "project :expo-camera" stays.
  let name = m[2].replace(/ \((\*|c|n)\)$/, '').trim();
  const arrow = /^(.+?):([^:\s]+) -> (\S+)$/.exec(name);
  if (arrow) name = `${arrow[1]}:${arrow[3]}`;
  else name = name.replace(/ -> \S+$/, '');
  return { depth, name };
}

/** Returns [{ artifact, label, via, path }] for every flagged library (deduplicated). */
export function audit(text) {
  const stack = [];
  const found = new Map();
  for (const line of text.split(/\r?\n/)) {
    const node = parseLine(line);
    if (!node) continue;
    stack.length = node.depth;
    const rule = FLAGGED.find((f) => f.re.test(node.name));
    if (rule) {
      const artifact = node.name.split(':').slice(0, 2).join(':');
      const culprit = [...stack].reverse().find((a) => !NOT_A_CULPRIT.test(a)) ?? stack[stack.length - 1] ?? '(direct)';
      const via = culprit.replace(/^project :/, '');
      const key = `${artifact}|${via}`;
      if (!found.has(key)) found.set(key, { artifact, label: rule.label, via, path: [...stack, node.name] });
    }
    stack.push(node.name);
  }
  return [...found.values()];
}

export function report(findings) {
  const out = ['## F-Droid dependency check (release runtime classpath)', ''];
  if (findings.length === 0) {
    out.push('No Google Play Services, Firebase or ML Kit library found. :white_check_mark:');
    return out.join('\n') + '\n';
  }
  const modules = [...new Set(findings.map((f) => f.via))];
  out.push(
    `:warning: **${findings.length} proprietary librar${findings.length === 1 ? 'y' : 'ies'}** ` +
      `pulled in by: ${modules.map((m) => `\`${m}\``).join(', ')}. ` +
      'F-Droid will not accept the build as is (see docs/spec-coverage.md, gap 9).',
    '',
    '| Library | Kind | Pulled in by | Path |',
    '| --- | --- | --- | --- |',
  );
  for (const f of findings) {
    out.push(`| \`${f.artifact}\` | ${f.label} | \`${f.via}\` | ${f.path.map((p) => `\`${p}\``).join(' → ')} |`);
  }
  return out.join('\n') + '\n';
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const [input, summary] = process.argv.slice(2);
  if (!input) {
    console.error('usage: fdroid-deps.mjs <dependencies.txt> [summary.md]');
    process.exit(2);
  }
  const findings = audit(readFileSync(input, 'utf8'));
  const md = report(findings);
  if (summary) appendFileSync(summary, md);
  else process.stdout.write(md);
  // One annotation per module that pulls something in (details are in the summary).
  const byModule = new Map();
  for (const f of findings) byModule.set(f.via, [...(byModule.get(f.via) ?? []), f.artifact]);
  for (const [via, libs] of byModule) console.log(`::warning title=F-Droid::${via} pulls in ${libs.join(', ')}`);
}
