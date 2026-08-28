#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WIZARD="$REPO_ROOT/verification/wizards/wizard-m5-windows-sandbox.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/m5 wizard tests.XXXXXX")"
LIB="$TEST_ROOT/wizard-functions.sh"
trap 'rm -rf "$TEST_ROOT"' EXIT

awk '/^prepare_transfer_kit\(\) \{/ { exit } { print }' "$WIZARD" > "$LIB"
# shellcheck source=/dev/null
source "$LIB"

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
assert_eq() { [[ "$1" == "$2" ]] || fail "$3 (expected '$2', got '$1')"; }
assert_ne() { [[ "$1" != "$2" ]] || fail "$3 (unexpected '$2')"; }
assert_file_value() { local actual; actual="$(< "$1")"; assert_eq "$actual" "$2" "$3"; }
assert_new_run() { local rejected="$1" message="$2"; assert_ne "$RUN_ID" "$rejected" "$message"; valid_wizard_run_id "$RUN_ID" || fail "$message (replacement '$RUN_ID' is invalid)"; }
say() { :; }
if ! command -v powershell.exe >/dev/null 2>&1; then
  to_win() { printf '%s' "$1"; }
  powershell.exe() {
    python -c 'import json, os, sys; m=json.load(open(os.environ["M5_MANIFEST"], encoding="utf-8-sig")); expected={"schema":"m5-sandbox-kit-v2","runId":os.environ["M5_RUN_ID"],"installer":os.environ["M5_INSTALLER_HASH"],"wheel":os.environ["M5_WHEEL_HASH"],"capture":os.environ["M5_HELPER_HASH"],"sandbox":os.environ["M5_WIZARD_HELPER_HASH"],"ffmpeg":os.environ["M5_FFMPEG_HASH"],"ffprobe":os.environ["M5_FFPROBE_HASH"]}; actual={"schema":m.get("schema"),"runId":m.get("runId"),"installer":m.get("installer",{}).get("sha256"),"wheel":m.get("wheel",{}).get("sha256"),"capture":m.get("captureHelper",{}).get("sha256"),"sandbox":m.get("sandboxHelper",{}).get("sha256"),"ffmpeg":m.get("wheel",{}).get("bundledFfmpegSha256"),"ffprobe":m.get("wheel",{}).get("bundledFfprobeSha256")}; sys.exit(0 if actual == expected else 1)'
  }
fi
write_manifest() {
  local path="$1" run_id="$2" wheel_hash="$3"
  printf '{"schema":"m5-sandbox-kit-v2","runId":"%s","installer":{"sha256":"i"},"wheel":{"sha256":"%s","bundledFfmpegSha256":"f","bundledFfprobeSha256":"p"},"captureHelper":{"sha256":"c"},"sandboxHelper":{"sha256":"s"}}\n' "$run_id" "$wheel_hash" > "$path"
}

CASE_INDEX=0
reset_case() {
  CASE_INDEX=$((CASE_INDEX + 1))
  REPO_DIR="$TEST_ROOT/case $CASE_INDEX/repo"
  TRANSFER_BASE="$REPO_DIR/verification/evidence/m5/.sandbox-transfer"
  CURRENT_RUN_FILE="$TRANSFER_BASE/current-run.txt"
  mkdir -p "$TRANSFER_BASE"
}

valid_wizard_run_id 20260826T044141Z || fail 'valid base run ID was rejected'
valid_wizard_run_id 20240229T235959Z-retry-retry || fail 'valid leap-day repeated-retry run ID was rejected'
for invalid in 20261399T256199Z 20260229T000000Z 20260431T000000Z 00000101T000000Z 20260826T044141Z-retry-1; do
  if valid_wizard_run_id "$invalid"; then fail "invalid calendar run ID was accepted: $invalid"; fi
done

reset_case
RESUME_ID=20260826T044141Z
printf '%s\n' "$RESUME_ID" > "$CURRENT_RUN_FILE"
mkdir -p "$TRANSFER_BASE/$RESUME_ID/kit" "$TRANSFER_BASE/$RESUME_ID/outbox" "$TRANSFER_BASE/$RESUME_ID/host-evidence"
choose_run i w c s f p
assert_eq "$RUN_ID" "$RESUME_ID" 'exact interrupted pre-manifest run did not resume'
assert_file_value "$CURRENT_RUN_FILE" "$RESUME_ID" 'pre-manifest resume rewrote the run pointer'

reset_case
RESUME_ID=20260826T050000Z
printf '%s\n' "$RESUME_ID" > "$CURRENT_RUN_FILE"
mkdir -p "$TRANSFER_BASE/$RESUME_ID/kit"
write_manifest "$TRANSFER_BASE/$RESUME_ID/kit/kit-manifest.json" "$RESUME_ID" w
choose_run i w c s f p
assert_eq "$RUN_ID" "$RESUME_ID" 'matching incomplete manifested run did not resume'

reset_case
printf '%s\n' '../../outside' > "$CURRENT_RUN_FILE"
choose_run i w c s f p
assert_new_run '../../outside' 'path-traversal pointer was accepted'
assert_file_value "$CURRENT_RUN_FILE" "$RUN_ID" 'rejected path-traversal pointer was not replaced'

reset_case
printf '%s\n' '2026-08-26-not-a-wizard-run' > "$CURRENT_RUN_FILE"
choose_run i w c s f p
assert_new_run '2026-08-26-not-a-wizard-run' 'malformed pointer was accepted'
assert_file_value "$CURRENT_RUN_FILE" "$RUN_ID" 'rejected malformed pointer was not replaced'

reset_case
RESUME_ID=20260826T060000Z
printf '%s\n' "$RESUME_ID" > "$CURRENT_RUN_FILE"
mkdir -p "$TRANSFER_BASE/$RESUME_ID/kit"
write_manifest "$TRANSFER_BASE/$RESUME_ID/kit/kit-manifest.json" "$RESUME_ID" contradictory-wheel
choose_run i w c s f p
assert_new_run "$RESUME_ID" 'contradictory manifested run was resumed'

reset_case
RESUME_ID=20260826T070000Z
printf '%s\n' "$RESUME_ID" > "$CURRENT_RUN_FILE"
mkdir -p "$TRANSFER_BASE/$RESUME_ID/kit"
write_manifest "$TRANSFER_BASE/$RESUME_ID/kit/kit-manifest.json" "$RESUME_ID" w
printf '# completed\n' > "$REPO_DIR/verification/evidence/m5/${RESUME_ID}-windows-sandbox.md"
choose_run i w c s f p
assert_new_run "$RESUME_ID" 'completed run was resumed'

reset_case
RESUME_ID=20260826T080000Z
printf '%s\n' "$RESUME_ID" > "$CURRENT_RUN_FILE"
mkdir -p "$TRANSFER_BASE/$RESUME_ID/kit" "$TRANSFER_BASE/$RESUME_ID/outbox" "$TRANSFER_BASE/$RESUME_ID/host-evidence"
printf 'stale guest' > "$TRANSFER_BASE/$RESUME_ID/outbox/stale.json"
printf 'stale acceptance' > "$TRANSFER_BASE/$RESUME_ID/host-evidence/accepted-stale.json"
printf 'SMARTSCREEN_REPUTATION_OK=yes\n' > "$TRANSFER_BASE/$RESUME_ID/wizard-state.env"
choose_run i w c s f p
assert_eq "$RUN_ID" "$RESUME_ID" 'pre-manifest run with unbound evidence changed identity'
[[ ! -e "$OUTBOX/stale.json" && ! -e "$HOST_EVIDENCE/accepted-stale.json" && ! -e "$STATE_FILE" ]] || fail 'unbound pre-manifest evidence remained reusable'
find "$RUN_ROOT" -maxdepth 2 -type f -path '*/unbound-pre-manifest-evidence/*' | grep -q . || fail 'unbound pre-manifest evidence was not preserved in quarantine'

reset_case
RESUME_ID=20260826T090000Z
OUTSIDE_FILE="$TEST_ROOT/outside confirm target.txt"
printf 'outside must survive\n' > "$OUTSIDE_FILE"
printf '%s\n' "$RESUME_ID" > "$CURRENT_RUN_FILE"
mkdir -p "$TRANSFER_BASE/$RESUME_ID/kit"
MSYS=winsymlinks:sys ln -s "$OUTSIDE_FILE" "$TRANSFER_BASE/$RESUME_ID/kit/00-confirm-run.cmd"
[[ -L "$TRANSFER_BASE/$RESUME_ID/kit/00-confirm-run.cmd" ]] || fail 'could not construct exact nested 00-confirm-run.cmd symlink attack'
choose_run i w c s f p
assert_new_run "$RESUME_ID" 'nested kit/00-confirm-run.cmd symlink run was resumed'
write_lines "$KIT/00-confirm-run.cmd" '@echo safe replacement'
assert_file_value "$OUTSIDE_FILE" 'outside must survive' 'nested kit symlink attack overwrote the outside target'

reset_case
RESUME_ID=20260826T100000Z
OUTSIDE_POINTER="$TEST_ROOT/outside pointer target.txt"
printf '%s\n' "$RESUME_ID" > "$OUTSIDE_POINTER"
MSYS=winsymlinks:sys ln -s "$OUTSIDE_POINTER" "$CURRENT_RUN_FILE"
choose_run i w c s f p
assert_new_run "$RESUME_ID" 'reparse current-run pointer was trusted'
assert_file_value "$OUTSIDE_POINTER" "$RESUME_ID" 'reparse current-run pointer overwrote the outside target'
[[ ! -L "$CURRENT_RUN_FILE" ]] || fail 'reparse current-run pointer was not safely reconstructed'

if command -v cygpath >/dev/null 2>&1 && command -v powershell.exe >/dev/null 2>&1; then
  reset_case
  RESUME_ID=20260826T110000Z
  JUNCTION_TARGET="$TEST_ROOT/junction outside directory"
  mkdir -p "$TRANSFER_BASE/$RESUME_ID/kit" "$JUNCTION_TARGET"
  printf '%s\n' "$RESUME_ID" > "$CURRENT_RUN_FILE"
  M5_JUNCTION="$(to_win "$TRANSFER_BASE/$RESUME_ID/kit/nested-junction")" M5_JUNCTION_TARGET="$(to_win "$JUNCTION_TARGET")" powershell.exe -NoProfile -Command 'New-Item -ItemType Junction -Path $env:M5_JUNCTION -Target $env:M5_JUNCTION_TARGET -ErrorAction Stop | Out-Null'
  choose_run i w c s f p
  assert_new_run "$RESUME_ID" 'nested Windows junction/reparse run was resumed'
  printf 'PASS: native Windows junction/reparse rejection\n'
fi

reset_case
CLOCK_BIN="$TEST_ROOT/fixed clock bin"
mkdir -p "$CLOCK_BIN"
printf '#!/usr/bin/env bash\nprintf %s 20301231T235959Z\n' > "$CLOCK_BIN/date"
chmod +x "$CLOCK_BIN/date"
printf '# prior base outcome\n' > "$REPO_DIR/verification/evidence/m5/20301231T235959Z-windows-sandbox.md"
printf '# prior retry outcome\n' > "$REPO_DIR/verification/evidence/m5/20301231T235959Z-retry-windows-sandbox-retry-1.md"
OLD_PATH="$PATH"
PATH="$CLOCK_BIN:$PATH"
COLLISION_ID="$(new_run_id)"
PATH="$OLD_PATH"
assert_eq "$COLLISION_ID" '20301231T235959Z-retry-retry' 'new_run_id reused an ID whose transfer directory was gone but outcome remained'

COPY_ROOT="$TEST_ROOT/copy verified spaced paths"
mkdir -p "$COPY_ROOT/source folder" "$COPY_ROOT/destination folder"
SOURCE="$COPY_ROOT/source folder/payload file.bin"
DESTINATION="$COPY_ROOT/destination folder/copied payload.bin"
printf 'verified payload\n' > "$SOURCE"
sha256_file() { sha256sum "$1" | awk '{print $1}'; }
EXPECTED_HASH="$(sha256_file "$SOURCE")"
copy_verified "$SOURCE" "$DESTINATION" "$EXPECTED_HASH"
assert_eq "$(sha256_file "$DESTINATION")" "$EXPECTED_HASH" 'copy_verified failed with spaced paths'
rm "$SOURCE"
copy_verified "$SOURCE" "$DESTINATION" "$EXPECTED_HASH"
assert_eq "$(sha256_file "$DESTINATION")" "$EXPECTED_HASH" 'copy_verified did not idempotently reuse a verified destination'

# Regression: evidence-gate functions must not reference a local on the same `local` line that defines it (set -u: "kind: unbound variable").
GATE_LIB="$TEST_ROOT/evidence-gate-functions.sh"
awk '/^(validate_guest_evidence|require_screenshot|require_passing_json)\(\) \{/ { keep = 1 } keep { print } keep && /^\}/ { keep = 0 }' "$WIZARD" > "$GATE_LIB"
grep -q '^validate_guest_evidence()' "$GATE_LIB" && grep -q '^require_screenshot()' "$GATE_LIB" && grep -q '^require_passing_json()' "$GATE_LIB" || fail 'could not extract evidence-gate functions from the wizard'
GATE_LOG="$TEST_ROOT/evidence-gate-calls.log"
(
  set -euo pipefail
  unset kind marker exact_name
  RUN_ROOT="$TEST_ROOT/gate run root"; RUN_ID=20301231T235959Z; HOST_EVIDENCE="$RUN_ROOT/host"; OUTBOX="$RUN_ROOT/outbox"; RUN_COMMAND=wizard
  GREEN=''; RESET=''; YELLOW=''
  mkdir -p "$RUN_ROOT" "$HOST_EVIDENCE"
  host_helper() { printf '%s\n' "$*" >> "$GATE_LOG"; return 0; }
  to_win() { printf '%s' "$1"; }
  write_env() { printf 'write_env %s=%s\n' "$1" "$2" >> "$GATE_LOG"; }
  say() { :; }; step() { :; }; note() { :; }; warn() { :; }; pause() { :; }; confirm() { return 0; }
  # shellcheck source=/dev/null
  source "$GATE_LIB"
  validate_guest_evidence guest-confirm "$RUN_ROOT/guest-confirm-attempt.marker"
  require_screenshot obs-recording 'the OBS recording view' SCREENSHOT_RESULT
  require_passing_json guest-confirm confirm.cmd 'guest confirmation' JSON_RESULT
) </dev/null || fail 'evidence-gate functions crashed under set -u (same-line local self-reference regression)'
grep -q -- '^ValidateGuestEvidence -EvidenceKind guest-confirm -AttemptMarkerPath .*guest-confirm-attempt.marker$' "$GATE_LOG" || fail 'validate_guest_evidence did not pass kind and marker through to host_helper'
grep -q -- '^ValidateScreenshot -ScreenshotKind obs-recording$' "$GATE_LOG" || fail 'require_screenshot did not derive its kind'
grep -q -- '^write_env SCREENSHOT_RESULT=yes$' "$GATE_LOG" || fail 'require_screenshot did not record its result'
grep -q -- '^write_env JSON_RESULT=yes$' "$GATE_LOG" || fail 'require_passing_json did not record its result'
printf 'PASS: evidence-gate functions run under set -u\n'

printf 'PASS: M5 wizard resume, path safety, collision, calendar, and copy regression cases\n'
