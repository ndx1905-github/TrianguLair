/** The F-Droid dependency audit of the Android build (scripts/fdroid-deps.mjs, CI native-android.yml). */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { audit, countLibraries, parseLine, report } from '../scripts/fdroid-deps.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/fdroid-deps.mjs', import.meta.url));

/** Shaped like `./gradlew :app:dependencies --configuration releaseRuntimeClasspath`. */
const BEFORE = `
releaseRuntimeClasspath - Runtime classpath of compilation 'release' (target  (androidJvm)).
+--- project :expo
|    +--- project :expo-location
|    |    +--- com.google.android.gms:play-services-location:21.0.1
|    |    |    +--- com.google.android.gms:play-services-base:18.1.0
|    |    |    |    \\--- androidx.core:core:1.2.0 -> 1.16.0 (*)
|    |    |    \\--- com.google.android.gms:play-services-basement:18.1.0 (*)
|    |    \\--- androidx.core:core-ktx:1.16.0 (*)
|    \\--- project :expo-camera
|         +--- com.google.mlkit:barcode-scanning:17.3.0
|         |    \\--- com.google.android.odml:image:1.0.0-beta1
|         \\--- androidx.camera:camera-core:1.6.0
+--- org.maplibre.gl:android-sdk-opengl:13.6.1
\\--- com.facebook.react:react-android:0.86.3
`;

const AFTER = `
releaseRuntimeClasspath - Runtime classpath of compilation 'release' (target  (androidJvm)).
+--- project :expo
|    +--- project :tl-location
|    \\--- project :tl-qr-scanner
|         +--- androidx.camera:camera-core:1.6.0
|         |    \\--- com.google.guava:listenablefuture:1.0
|         \\--- com.google.zxing:core:3.5.3
+--- project :maplibre_maplibre-react-native
|    \\--- org.maplibre.gl:android-sdk-opengl:13.6.1
\\--- com.facebook.react:react-android:0.86.3
`;

function run(tree: string): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fdroid-'));
  const file = join(dir, 'deps.txt');
  writeFileSync(file, tree);
  try {
    return { code: 0, out: execFileSync(process.execPath, [SCRIPT, '--fail', file], { encoding: 'utf8' }) };
  } catch (e) {
    const err = e as { status: number; stdout: string };
    return { code: err.status, out: err.stdout };
  }
}

describe('F-Droid dependency audit', () => {
  it('parses Gradle tree lines', () => {
    expect(parseLine('|    |    +--- androidx.core:core:1.2.0 -> 1.16.0 (*)')).toEqual({ depth: 2, name: 'androidx.core:core:1.16.0' });
    expect(parseLine('\\--- project :expo-camera')).toEqual({ depth: 0, name: 'project :expo-camera' });
    expect(parseLine('releaseRuntimeClasspath - Runtime classpath')).toBeNull();
  });

  it('finds Play services and ML Kit, with the module that pulls each in', () => {
    const found = audit(BEFORE);
    expect(found.map((f) => [f.artifact, f.via])).toEqual([
      ['com.google.android.gms:play-services-location', 'expo-location'],
      ['com.google.android.gms:play-services-base', 'expo-location'],
      ['com.google.android.gms:play-services-basement', 'expo-location'],
      ['com.google.mlkit:barcode-scanning', 'expo-camera'],
      ['com.google.android.odml:image', 'expo-camera'],
    ]);
    expect(report(found)).toContain('F-Droid will not accept the build');
  });

  it('allows ZXing and other open-source com.google libraries', () => {
    expect(audit(AFTER)).toEqual([]);
    expect(report([], countLibraries(AFTER))).toContain('No Google Play Services, Firebase, ML Kit or Play Core library among the 5 libraries');
  });

  it('flags Firebase and Play Core too', () => {
    const tree = '+--- com.google.firebase:firebase-messaging:24.0.0\n\\--- com.google.android.play:review:2.0.1\n';
    expect(audit(tree).map((f) => f.label)).toEqual(['Firebase', 'Google Play Core']);
  });

  it('fails the CI step on a finding, on an empty tree, and passes a clean tree', () => {
    const bad = run(BEFORE);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('::error title=F-Droid::expo-location pulls in com.google.android.gms:play-services-location');
    expect(run('').code).toBe(1);
    const good = run(AFTER);
    expect(good.code).toBe(0);
    expect(good.out).toContain('0 proprietary libraries among 5 libraries');
  });
});
