#!/usr/bin/env bash
# One scheduled LitScout run on an own server.
#
#   daily-run.sh main|retry|final
#
# main and retry run the daily steps; the CLI skips work that is already done,
# so a retry only finishes what an earlier run left. final also writes the
# final digest, checks a few links, mirrors the alphaXiv library (when
# library.alphaxivCapture names a client), prunes, keeps the server's files
# within their limits (housekeep.py), and on Sundays writes the weekly
# report. Every
# run then catches up skipped days and the trends history while the day's
# write budget allows. Every command's JSON result goes to
# logs/run-<time>-<mode>.jsonl, and `daily report` sends the run report to
# Health. The model work uses the config's client and fallback chain
# (agent.summaries, agent.digest).
set -uo pipefail
MODE=${1:-}
case "$MODE" in
  main | retry | final) ;;
  *)
    echo "usage: daily-run.sh main|retry|final" >&2
    exit 2
    ;;
esac
BASE=${LITSCOUT_HOME:-$HOME/litscout}
CONFIG=${LITSCOUT_CONFIG:-$BASE/etc/litscout.config.ts}
NODE=${LITSCOUT_NODE:-node}
CLI=$BASE/current/dist/index.js
LOGS=$BASE/logs
# The instance's time zone decides which run is Sunday's (the weekly summary):
# LITSCOUT_TZ, else instance.timezone in the config, else UTC.
TZ_LOCAL=${LITSCOUT_TZ:-$(sed -n "s/^[[:space:]]*timezone:[[:space:]]*[\"']\([^\"']*\)[\"'].*/\1/p" "$CONFIG" 2>/dev/null | head -n 1)}
if [ -z "$TZ_LOCAL" ]; then
  echo "daily-run: no instance.timezone found in $CONFIG; Sunday is taken in UTC" >&2
  TZ_LOCAL=UTC
fi
umask 077
mkdir -p "$LOGS"
LOG=$LOGS/run-$(date -u +%Y%m%dT%H%M%SZ)-$MODE.jsonl
failed=0
last=""

# Record one step's exit code and output ($last). Exit 0 is done, 2 is
# nothing to do; anything else marks the run failed but later steps still
# run, as the runbook's recovery table expects.
record() {
  printf '%s' "$last" | python3 -I -c '
import json, sys
print(json.dumps({"step": sys.argv[1], "started": sys.argv[2],
                  "exit": int(sys.argv[3]), "output": sys.stdin.read()[-65536:]}))
' "$1" "$2" "$3" >> "$LOG"
  if [ "$3" -ne 0 ] && [ "$3" -ne 2 ]; then failed=1; fi
}
# Run one CLI command and record it.
step() {
  local name=$1
  shift
  local started code
  started=$(date -u +%FT%TZ)
  last=$("$NODE" "$CLI" "$@" --json --config "$CONFIG" 2>&1)
  code=$?
  record "$name" "$started" "$code"
}
# Keep releases, logs, agent transcripts and npm's cache within their limits
# and measure the user's home against the storage cap.
housekeep() {
  local started code
  started=$(date -u +%FT%TZ)
  last=$(python3 -I "$BASE/current/scripts/housekeep.py" "$BASE" --home "$HOME" 2>&1)
  code=$?
  record housekeep "$started" "$code"
}

cd "$BASE"
# Rows the day's budget must still hold before catch-up work starts, so a
# later run of the same day keeps room for its own steps.
CATCH_UP_RESERVE=${LITSCOUT_CATCH_UP_RESERVE:-10000}
budget_left() {
  "$NODE" "$CLI" budget --json --config "$CONFIG" 2> /dev/null | python3 -I -c '
import json, sys
d = json.load(sys.stdin)["data"]
print(max(0, d["limit"] - d["used"] - d.get("reserved", 0)))' 2> /dev/null || echo 0
}
# After the day's own work: days that were crawled but skipped while a later
# listing was read (oldest first), then the monthly trends history. Both stop
# when the budget gets close to the reserve, and resume on the next run.
catch_up() {
  local behind day i
  behind=$(printf '%s' "$status_out" | python3 -I -c '
import json, sys
try:
    rows = json.load(sys.stdin)["data"]
except Exception:
    rows = []
print(" ".join(sorted(r["day"] for r in rows if isinstance(r, dict) and r.get("behind"))))' 2> /dev/null)
  for day in $behind; do
    [ "$(budget_left)" -ge "$CATCH_UP_RESERVE" ] || return 0
    step "summaries $day" summaries run --day "$day"
    step "digest $day" digest run --day "$day"
  done
  for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
    [ "$(budget_left)" -ge "$CATCH_UP_RESERVE" ] || return 0
    step "trends backfill" trends backfill
    printf '%s' "$last" | grep -q '"nextMonth": *"' || return 0
  done
}
# The server's facts (footprint, newest snapshot, newest run of each timer)
# for Health and doctor: measured without removing anything, then sent.
server_status() {
  local file=$LOGS/server-status.json
  python3 -I "$BASE/current/scripts/housekeep.py" "$BASE" --home "$HOME" \
    --dry-run --status-file "$file" > /dev/null 2>&1
  step "server status" server report "$file"
}
NOTIFY=$BASE/current/scripts/notify.py
# Push a message when the owner should act (failures, fallbacks, no digest,
# storage over its warning level or cap).
notify() {
  if [ -f "$NOTIFY" ]; then
    python3 -I "$NOTIFY" "$LOG" "$MODE" --state "$LOGS" \
      --url-file "$BASE/etc/ntfy.url" --home "$HOME" || true
  fi
}
# One run at a time: a retry waits for a main run that is still working.
exec 9> "$BASE/run.lock"
if ! flock -w 7200 9; then
  printf '%s\n' '{"step": "lock", "started": "", "exit": 1, "output": "{\"success\": false, \"data\": {\"message\": \"another run held the lock for two hours\"}}"}' >> "$LOG"
  notify
  exit 1
fi
step start daily start
step status daily status
status_out=$last
step fetch daily fetch
step summaries summaries run
if [ "$MODE" = final ]; then
  step digest digest run --final
  # An earlier run wrote the digest, so its trends refresh did not happen here.
  if printf '%s' "$last" | grep -q '"status": *"exists"'; then
    step trends trends refresh
  fi
  step links links check --limit 10
  # The alphaXiv mirror, when library.alphaxivCapture names a client (exit 2
  # when it is off).
  step alphaxiv alphaxiv capture --import
  step prune prune
  housekeep
  # Still over the storage cap after the file limits: the oldest compact feed
  # days go first, one week a run.
  if printf '%s' "$last" | grep -q '"overCap": *true'; then
    step "prune over cap" prune --over-cap
  fi
  if [ "$(TZ=$TZ_LOCAL date +%u)" = 7 ]; then step weekly weekly; fi
else
  step digest digest run
fi
catch_up
step report daily report
server_status
notify
exit "$failed"
