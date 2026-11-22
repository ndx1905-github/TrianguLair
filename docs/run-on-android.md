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

The same run's summary has an **F-Droid dependency check**: it lists Google
Play Services, Firebase or ML Kit libraries in the APK and the module pulling
each in (see [spec-coverage.md](spec-coverage.md), gap 9: `expo-location`,
`expo-camera` barcode scanning, MapLibre's location engine). The full
dependency tree is attached as the `android-dependencies-…` artifact.

## Smoke test on an emulator

After the build, the **Smoke test on an emulator** job installs the APK on an
Android 14 emulator (x86_64, so `x86_64` must be in the ABI list) and runs the
[Maestro](https://maestro.dev) flow in
[`apps/mobile/.maestro/smoke.yaml`](../apps/mobile/.maestro/smoke.yaml): the
app starts, first launch (profile, keys, app lock, location and import
skipped), add a place by hand, see its card on the map and its row in the
list, search it, and find it again after a cold restart. The job fails if a
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
