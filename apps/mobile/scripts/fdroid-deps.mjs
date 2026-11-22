#!/usr/bin/env node
// F-Droid dependency audit.
//
// Reads the output of `./gradlew :app:dependencies --configuration releaseRuntimeClasspath`
// and flags proprietary Google libraries (Play Services, Firebase, ML Kit), with the
// module that pulls each one in (e.g. expo-location, expo-camera).
//
// Usage: node scripts/fdroid-deps.mjs [--fail] <dependencies.txt> [summary.md]
// Writes a Markdown report to summary.md (or stdout) and prints one GitHub
// annotation per module that pulls something in. With --fail (CI), any finding
// is an `::error::` and the exit code is 1: the release APK must stay free of
// proprietary Google libraries. Without it, `::warning::` and exit 0.
//
// ZXing (`com.google.zxing:core`, the QR decoder of modules/tl-qr-scanner) is
// Apache-2.0 and accepted by F-Droid despite its group name: it is not flagged.
import { readFileSync, appendFileSync } from 'node:fs';

const FLAGGED = [
  { re: /^com\.google\.android\.gms:/, label: 'Google Play Services' },
  { re: /^com\.google\.firebase:/, label: 'Firebase' },
  { re: /^com\.google\.mlkit:/, label: 'ML Kit' },
  { re: /^com\.google\.android\.odml:/, label: 'ML Kit (on-device runtime)' },
  { re: /^com\.google\.android\.play:/, label: 'Google Play Core' },
];

/** Open-source libraries under a com.google group, accepted by F-Droid. */
const ALLOWED = [/^com\.google\.zxing:/];

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
    const rule = ALLOWED.some((a) => a.test(node.name)) ? undefined : FLAGGED.find((f) => f.re.test(node.name));
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

/** Counts the resolved libraries of the tree (to show that the check did read something). */
export function countLibraries(text) {
  const names = new Set();
  for (const line of text.split(/\r?\n/)) {
    const node = parseLine(line);
    if (node && !node.name.startsWith('project ')) names.add(node.name.split(':').slice(0, 2).join(':'));
  }
  return names.size;
}

export function report(findings, libraries) {
  const out = ['## F-Droid dependency check (release runtime classpath)', ''];
  if (findings.length === 0) {
    out.push(
      `No Google Play Services, Firebase, ML Kit or Play Core library among the ${libraries ?? 'resolved'} libraries. :white_check_mark:`,
      '',
      'Allowed: `com.google.zxing:core` (Apache-2.0, the QR decoder).',
    );
    return out.join('\n') + '\n';
  }
  const modules = [...new Set(findings.map((f) => f.via))];
  out.push(
    `:warning: **${findings.length} proprietary librar${findings.length === 1 ? 'y' : 'ies'}** ` +
      `pulled in by: ${modules.map((m) => `\`${m}\``).join(', ')}. ` +
      'F-Droid will not accept the build as is.',
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
  const args = process.argv.slice(2);
  const fail = args.includes('--fail');
  const [input, summary] = args.filter((a) => a !== '--fail');
  if (!input) {
    console.error('usage: fdroid-deps.mjs [--fail] <dependencies.txt> [summary.md]');
    process.exit(2);
  }
  const text = readFileSync(input, 'utf8');
  const libraries = countLibraries(text);
  // An empty or truncated tree must not pass as "nothing found".
  if (libraries === 0) {
    console.log('::error title=F-Droid::No dependency found in the Gradle output: wrong configuration or failed task?');
    process.exit(fail ? 1 : 0);
  }
  const findings = audit(text);
  const md = report(findings, libraries);
  if (summary) appendFileSync(summary, md);
  else process.stdout.write(md);
  // One annotation per module that pulls something in (details are in the summary).
  const byModule = new Map();
  for (const f of findings) byModule.set(f.via, [...(byModule.get(f.via) ?? []), f.artifact]);
  const level = fail ? 'error' : 'warning';
  for (const [via, libs] of byModule) console.log(`::${level} title=F-Droid::${via} pulls in ${libs.join(', ')}`);
  console.log(`F-Droid check: ${findings.length} proprietary librar${findings.length === 1 ? 'y' : 'ies'} among ${libraries} libraries.`);
  if (fail && findings.length > 0) process.exit(1);
}
