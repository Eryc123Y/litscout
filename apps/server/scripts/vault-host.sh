#!/usr/bin/env bash
# The jobs that stay on the machine holding the Obsidian vault when LitScout
# runs on a server. Run it from that machine's scheduler a few times a day.
#
#   LITSCOUT_CONFIG=~/.config/litscout/litscout.config.ts \
#   LITSCOUT_CLI=~/.local/share/litscout/app/apps/cli/dist/index.js \
#   LITSCOUT_SSH=server LITSCOUT_BRIEFS="/path/one.md:/path/two.md" \
#     apps/server/scripts/vault-host.sh
#
# 0. Update: the CLI has to be on the server's version, or it can reject the
#    server's replies. When LITSCOUT_CLI is the build inside a git clone, the
#    clone is pulled (fast-forward only) and rebuilt when its build is not
#    from the clone's commit. A pull that fails is reported and the sync runs
#    with the build it has. LITSCOUT_UPDATE=0 turns this step off;
#    LITSCOUT_PULL_SECONDS (120) is how long the pull may take.
# 1. Vault sync: publishes the vault index the server's digest reads (and,
#    with vault.write, writes digest files and managed blocks). Set
#    LITSCOUT_SYNC_ADOPT=1 when the digest folder holds an older pipeline's files.
# 2. Copies the digest brief files to the server's etc/briefs folder.
# 3. With LITSCOUT_NTFY_URL, from 10:00 to 12:59 checks that the server
#    started today's main run and sends a message if not.
# 4. From 22:00 to 07:59 local time only, resumes the legacy import, which
#    reads the old pipeline's repository on this machine. Its write budget is
#    then left over from the day's scheduled runs.
set -uo pipefail
CONFIG=${LITSCOUT_CONFIG:?set LITSCOUT_CONFIG to the config file}
CLI=${LITSCOUT_CLI:?set LITSCOUT_CLI to the built CLI}
HOST=${LITSCOUT_SSH:?set LITSCOUT_SSH to the ssh host of the server}
BRIEFS_DIR=${LITSCOUT_SERVER_BRIEFS:-/home/litscout/litscout/etc/briefs}
failed=0
# Exit 0 is done and 2 is nothing to do; anything else is a failure.
cli() {
  local code
  node "$CLI" "$@" --json --config "$CONFIG"
  code=$?
  echo
  if [ "$code" -ne 0 ] && [ "$code" -ne 2 ]; then failed=1; fi
}
# macOS has no timeout(1): stop a command still running after $1 seconds.
limited() {
  local seconds=$1 pid watcher code
  shift
  "$@" &
  pid=$!
  # Off the job's output, so a leftover sleep cannot hold the log open.
  (sleep "$seconds" && kill "$pid") > /dev/null 2>&1 &
  watcher=$!
  wait "$pid"
  code=$?
  # The watcher's sleep first, then the watcher itself.
  pkill -P "$watcher" 2> /dev/null
  kill "$watcher" 2> /dev/null
  wait "$watcher" 2> /dev/null
  return "$code"
}
# The clone is the folder three levels above the build (apps/cli/dist).
repo=$(cd "$(dirname "$CLI")/../../.." 2> /dev/null && pwd)
if [ "${LITSCOUT_UPDATE:-1}" != 0 ] && [ -n "$repo" ] && [ -e "$repo/.git" ]; then
  at=$(git -C "$repo" rev-parse HEAD)
  # LITSCOUT_PULLED is set by the restart below: one pull per run.
  if [ -z "${LITSCOUT_PULLED:-}" ]; then
    if ! GIT_TERMINAL_PROMPT=0 limited "${LITSCOUT_PULL_SECONDS:-120}" \
      git -C "$repo" pull -q --ff-only; then
      echo "== update: pull failed; the CLI stays at ${at:0:7}"
    elif [ "$(git -C "$repo" rev-parse HEAD)" != "$at" ]; then
      echo "== update: ${at:0:7} -> $(git -C "$repo" rev-parse --short=7 HEAD)"
      # The pull may have changed this script: start again from the new file.
      LITSCOUT_PULLED=1 exec "$BASH" "$0"
    fi
  fi
  # The build records its commit (tools/build.mjs); rebuild when it differs,
  # which also retries a build that failed and covers a pull made by hand.
  if [ "$(cat "$repo/apps/cli/dist/commit" 2> /dev/null)" != "$at" ]; then
    echo "== update: build ${at:0:7}"
    # The build's warnings stay out of the log; a failed build shows its end.
    if ! built=$(cd "$repo" && pnpm install --frozen-lockfile 2>&1 && pnpm build 2>&1); then
      echo "== update: build failed"
      printf '%s\n' "$built" | tail -20
      failed=1
    fi
  fi
fi
cd "$(dirname "$CONFIG")"
echo "== $(date '+%F %T') vault sync"
# A digest folder shared with an older pipeline's files needs --adopt on
# every sync (LITSCOUT_SYNC_ADOPT=1).
if [ "${LITSCOUT_SYNC_ADOPT:-}" = 1 ]; then cli sync --adopt; else cli sync; fi
# LITSCOUT_BRIEFS lists brief files separated by ":" (paths may hold spaces).
if [ -n "${LITSCOUT_BRIEFS:-}" ]; then
  IFS=':' read -r -a briefs <<< "$LITSCOUT_BRIEFS"
  for brief in "${briefs[@]}"; do
    name=$(basename "$brief")
    echo "== brief $name"
    # Read with node: on macOS a scheduler's shell may not open files under
    # ~/Documents, while node (which also runs the sync) may.
    if node -e 'process.stdout.write(require("fs").readFileSync(process.argv[1]))' "$brief" |
      ssh -o BatchMode=yes -o ConnectTimeout=20 "$HOST" \
        "sudo -n install -d -m 700 -o litscout -g litscout $BRIEFS_DIR && sudo -n -u litscout tee $BRIEFS_DIR/$name.new > /dev/null && sudo -n -u litscout mv $BRIEFS_DIR/$name.new $BRIEFS_DIR/$name"; then
      echo "copied"
    else
      failed=1
    fi
  done
fi
hour=$(date +%H)
# From 10:00 to 12:59, check from outside that the server started today's
# main run (an unreachable server counts too); one message a day at most.
if [ -n "${LITSCOUT_NTFY_URL:-}" ] && [ "$hour" -ge 10 ] && [ "$hour" -lt 13 ]; then
  today=$(date +%F)
  marker="$HOME/.cache/litscout/missed-run-$today"
  logs=${LITSCOUT_SERVER_LOGS:-/home/litscout/litscout/logs}
  found=$(ssh -o BatchMode=yes -o ConnectTimeout=20 "$HOST" \
    "sudo -n find $logs -name 'run-*-main.jsonl' -newermt '$today 00:00 $(date +%z)' | head -1" 2> /dev/null)
  reached=$?
  if { [ "$reached" -ne 0 ] || [ -z "$found" ]; } && [ ! -e "$marker" ]; then
    if [ "$reached" -ne 0 ]; then
      text="Cannot reach the server to check today's main run."
    else
      text="The server has not started today's main run."
    fi
    if curl -s -m 20 -H "Title: LitScout run missing" -H "Priority: high" -H "Tags: warning" \
      -d "$text" "$LITSCOUT_NTFY_URL" > /dev/null; then
      mkdir -p "$(dirname "$marker")" && touch "$marker"
    fi
    echo "== missed run: $text"
  fi
fi
if [ "$hour" -ge 22 ] || [ "$hour" -lt 8 ]; then
  echo "== legacy import"
  cli legacy import --keep-rows 2000
fi
exit "$failed"
