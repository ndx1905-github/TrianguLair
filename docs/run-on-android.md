# Run TrianguLair on an Android phone

GitHub Actions builds an installable **APK** (release build with the app's
JavaScript inside, works without a computer nearby). No Android Studio needed.

## 1. Build the APK

1. On github.com: *Actions* › **Native Android build** › *Run workflow*
   (branch `main`). Leave "ABIs" as is (`arm64-v8a` covers recent phones,
   `armeabi-v7a` older 32-bit ones, `x86_64` emulators).
2. It takes roughly 15–30 minutes. Pushing a version tag (`v…`) also runs it.

## 2. Download it

Open the finished run, scroll to **Artifacts** and download
`TrianguLair-android-apk-…` (a ZIP containing `TrianguLair.apk`; kept 7 days).
You need to be signed in to GitHub with access to the repository, so it is
often easiest to download on a computer and copy the APK to the phone (USB,
cloud drive, or a message to yourself), or to sign in to github.com in the
phone's browser and unzip with the *Files* app.

## 3. Install it

1. Open `TrianguLair.apk` on the phone.
2. Android asks to **allow installs from unknown sources** for the app you
   opened it with (Files, Chrome, …): *Settings* › allow, then go back.
3. Play Protect may warn about an unknown developer: *More details* › *Install
   anyway*.

To update: install a newer APK from the same workflow over it (your data stays).
The APK is signed with the build's **debug key**, which is fine for testing but
differs from any future store / F-Droid release: switching to one of those
means uninstalling first (export your data before).

## F-Droid check

Before the APK is built, the **F-Droid dependency check** reads the release
runtime classpath and **fails the build** if any Google Play services
(`com.google.android.gms`), Firebase, ML Kit or Play Core
(`com.google.android.play`) library is in it; the summary names the module
that pulls each one in. `com.google.zxing:core` (Apache-2.0, the QR decoder)
is allowed. The full dependency tree is attached as the
`android-dependencies-…` artifact.

On Android the app does not link `expo-location` (Play services location) or
`expo-camera` (ML Kit barcode scanning): `apps/mobile/package.json`
`expo.autolinking.android.exclude`. Two local modules replace them:
`apps/mobile/modules/tl-location` (the platform `LocationManager`) and
`apps/mobile/modules/tl-qr-scanner` (CameraX + ZXing). MapLibre's location
engine is its `default` one (the platform `LocationManager`, pinned in
`app.json`); the app does not use MapLibre's user-location layer. So location
and QR scanning work on phones without Google Play services. iOS and web keep
`expo-location` and `expo-camera`.

## Smoke test on an emulator

After the build, the **Smoke test on an emulator** job installs the APK on an
Android 14 emulator (x86_64, so `x86_64` must be in the ABI list) and runs the
[Maestro](https://maestro.dev) flow in
[`apps/mobile/.maestro/smoke.yaml`](../apps/mobile/.maestro/smoke.yaml): the
app starts, the QR scanner of "I already have my places" opens the camera
(or says there is none), first launch (profile, keys, app lock skipped, the
location allowed, import skipped), "center on me" after moving the map, add a
place by hand at the map's center (it must be at the mock position), see its
card on the map and its row in the list, search it, and find it again after a
cold restart. The emulator image is AOSP **without Google APIs**, and
`apps/mobile/scripts/android-smoke.sh` sends it a GPS position every 2 s
(`adb emu geo fix`): the location test proves that it works without Google
Play services. The job fails if a
step fails or if the app crashed (Java exception, native signal or fatal
JavaScript error).

The `android-smoke-…` artifact has the screenshots of each step,
`logcat-app.txt` (the app's processes, `ReactNativeJS`, `AndroidRuntime`),
`crashes.txt` when it crashed, the whole logcat and Maestro's report. The job
log and summary repeat the JavaScript logs and the crash.

To iterate on the test without rebuilding, run the workflow with
**apk_from_run** set to the id of an earlier run (its APK is reused, kept 7
days). Locally, with an emulator or a phone connected over `adb` and Maestro
installed: `apps/mobile/scripts/android-smoke.sh TrianguLair.apk /tmp/smoke`.

## What to try

See [run-on-iphone.md](run-on-iphone.md#what-to-try): the same applies.
