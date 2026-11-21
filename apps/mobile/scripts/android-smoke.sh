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
  ($3 in pids) || /ReactNativeJS|AndroidRuntime|ReactNative|libc  |DEBUG   |hermes|Hermes|org\.triangulair\.app/ { print }
' "$OUT/logcat-full.txt" > "$OUT/logcat-app.txt"
gzip -f "$OUT/logcat-full.txt"
rm -f "$OUT/pids.txt" "$OUT/pids.sorted"

crashed=0
if grep -E "FATAL EXCEPTION|Fatal signal|JavascriptException|Unhandled JS Exception|Process: $PKG" "$OUT/logcat-app.txt" > "$OUT/crashes.txt"; then
  crashed=1
fi

{
  echo '## Android smoke test'
  echo
  if [ "$status" -eq 0 ] && [ "$crashed" -eq 0 ]; then echo 'Passed: first launch, add a place, see it on the map and in the list, cold restart.'; else echo "**Failed** (Maestro exit $status, crash: $crashed)."; fi
  echo
  echo "Screenshots: $(ls "$OUT/screenshots" | tr '\n' ' ')"
  if [ "$crashed" -eq 1 ]; then echo; echo '### Crash'; echo; echo '```'; head -60 "$OUT/crashes.txt"; echo '```'; fi
  if grep -qE ' E ReactNativeJS' "$OUT/logcat-app.txt"; then
    echo; echo '### JavaScript errors (console.error)'; echo; echo '```'
    grep -E ' E ReactNativeJS' "$OUT/logcat-app.txt" | cut -c1-400 | head -40
    echo '```'
  fi
} >> "${GITHUB_STEP_SUMMARY:-/dev/stdout}"

if [ "$crashed" -eq 1 ]; then
  echo "::error::The app crashed, see crashes.txt"
  cat "$OUT/crashes.txt"
  exit 1
fi
exit "$status"
