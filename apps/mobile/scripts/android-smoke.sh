#!/usr/bin/env bash
# Smoke test of the release APK on a running Android emulator (CI: native-android.yml, "smoke" job).
#   scripts/android-smoke.sh <apk> <output dir>
# Installs the APK, runs the Maestro flow in .maestro/smoke.yaml, and writes to <output dir>:
#   screenshots/*.png         the flow's screenshots (and Maestro's on failure)
#   logcat-app.txt            logcat filtered to the app's processes, ReactNativeJS, AndroidRuntime, crashes
#   logcat-full.txt.gz        the whole logcat, for anything the filter misses
#   maestro/                  Maestro's report (JUnit) and debug output
# Fails when the flow fails or when the app crashed (Java exception, native signal, JS fatal).
set -uo pipefail

APK=${1:?apk}
OUT=${2:?output dir}
PKG=org.triangulair.app
HERE=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$OUT/screenshots" "$OUT/maestro"
OUT=$(cd "$OUT" && pwd)

adb wait-for-device
# A freshly booted emulator is slow; its launcher or other system apps can stop responding,
# and their "isn't responding" dialogs would cover the app. Hide those dialogs and let the
# system settle.
adb shell settings put global hide_error_dialogs 1 || true
adb shell 'while [ "$(getprop sys.boot_completed)" != 1 ]; do sleep 1; done'
sleep 20
adb logcat -c || true
adb logcat -v threadtime -b main,system,crash > "$OUT/logcat-full.txt" 2>/dev/null &
LOGCAT=$!

# The app's process ids over time (it is restarted by the flow).
: > "$OUT/pids.txt"
( while true; do adb shell pidof "$PKG" 2>/dev/null | tr ' ' '\n' >> "$OUT/pids.txt"; sleep 1; done ) &
PIDS=$!

adb install -r -g "$APK" || { echo "::error::adb install failed"; exit 1; }

status=0
( cd "$OUT/screenshots" && maestro test \
    --format junit --output "$OUT/maestro/report.xml" \
    --debug-output "$OUT/maestro/debug" --flatten-debug-output \
    --test-output-dir "$OUT/maestro/out" \
    "$HERE/.maestro/smoke.yaml" ) || status=$?

# On failure: what was on screen (resource-id is the testID), for the job log.
if [ "$status" -ne 0 ]; then
  adb exec-out uiautomator dump /dev/tty > "$OUT/screen-at-failure.xml" 2>/dev/null || true
  adb exec-out screencap -p > "$OUT/screenshots/zz-at-failure.png" 2>/dev/null || true
fi

# Let the last log lines arrive.
sleep 3
kill "$PIDS" "$LOGCAT" 2>/dev/null || true
wait 2>/dev/null || true

# The flow's screenshots and Maestro's own (taken when a step fails).
find "$OUT/maestro" -name '*.png' -exec cp {} "$OUT/screenshots/" \; 2>/dev/null || true

# threadtime: date time pid tid level tag: message
sort -u "$OUT/pids.txt" | grep -E '^[0-9]+$' > "$OUT/pids.sorted" || true
awk -v pidfile="$OUT/pids.sorted" '
  BEGIN { while ((getline p < pidfile) > 0) pids[p] = 1 }
  ($3 in pids) || /ReactNativeJS|AndroidRuntime|ReactNative| DEBUG  |org\.triangulair\.app/ { print }
' "$OUT/logcat-full.txt" > "$OUT/logcat-app.txt"
gzip -f "$OUT/logcat-full.txt"

# Crashes of the app only (other processes, e.g. preinstalled apps, crash on emulators too):
# a Java exception names the process; a native crash and the JS fatal error are logged
# by the app's own process; ANRs name the package.
crashed=0
awk -v pkg="$PKG" -v pidfile="$OUT/pids.sorted" '
  BEGIN { while ((getline p < pidfile) > 0) pids[p] = 1 }
  /FATAL EXCEPTION/ { held = $0; next }
  held != "" { if (index($0, "Process: " pkg)) { print held; print; grab = 60 } held = ""; next }
  grab > 0 { print; grab--; next }
  ($3 in pids) && /Fatal signal|JavascriptException|Unhandled JS Exception/ { print; grab = 40; next }
  /ANR in / && index($0, pkg) { print; grab = 20 }
' "$OUT/logcat-app.txt" > "$OUT/crashes.txt"
[ -s "$OUT/crashes.txt" ] && crashed=1
{
  echo '## Android smoke test'
  echo
  if [ "$status" -eq 0 ] && [ "$crashed" -eq 0 ]; then echo 'Passed: first launch, add a place, its card and pin on the map, the list and its search, cold restart.'; else echo "**Failed** (Maestro exit $status, crash: $crashed)."; fi
  echo
  echo "Screenshots: $(ls "$OUT/screenshots" | tr '\n' ' ')"
  if [ "$crashed" -eq 1 ]; then echo; echo '### Crash'; echo; echo '```'; head -60 "$OUT/crashes.txt"; echo '```'; fi
  if grep -qE ' E ReactNativeJS' "$OUT/logcat-app.txt"; then
    echo; echo '### JavaScript errors (console.error)'; echo; echo '```'
    grep -E ' E ReactNativeJS' "$OUT/logcat-app.txt" | cut -c1-400 | head -40
    echo '```'
  fi
} >> "${GITHUB_STEP_SUMMARY:-/dev/stdout}"

rm -f "$OUT/pids.txt" "$OUT/pids.sorted"
[ -s "$OUT/crashes.txt" ] || rm -f "$OUT/crashes.txt"

# The job log gets the essentials too (the artifacts are not always at hand).
echo '--- JavaScript logs (ReactNativeJS) ---'
grep -E ' ReactNativeJS' "$OUT/logcat-app.txt" | cut -c1-600 | tail -80 || true
echo '--- Warnings and errors of the app (other tags) ---'
awk '$5 == "W" || $5 == "E" || $5 == "F"' "$OUT/logcat-app.txt" | grep -v ' ReactNativeJS\| AndroidRuntime\|ViewManagerPropertyUpdater' | cut -c1-400 | sort -k6 | uniq -f5 -c | sort -rn | head -60 || true
if [ -s "$OUT/screen-at-failure.xml" ]; then
  echo '--- On screen when the flow failed (resource-id = testID) ---'
  grep -oE '(resource-id|text|content-desc)="[^"]+"' "$OUT/screen-at-failure.xml" | grep -v 'resource-id="android:id\|resource-id="com.android' | head -120
fi
if [ "$crashed" -eq 1 ]; then
  echo "::error::The app crashed, see crashes.txt"
  echo '--- Crash ---'
  cut -c1-600 "$OUT/crashes.txt" | head -150
  exit 1
fi
exit "$status"
