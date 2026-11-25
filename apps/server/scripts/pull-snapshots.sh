#!/usr/bin/env bash
# Copy the server's newest state snapshot to this machine; keep the newest 14.
# Run from a scheduler on a laptop or desktop that is not always on.
#
#   LITSCOUT_SSH=my-server apps/server/scripts/pull-snapshots.sh [LOCAL_DIR]
#
# Needs passwordless ssh and sudo on the server. Skips a snapshot it has.
set -euo pipefail
HOST=${LITSCOUT_SSH:?set LITSCOUT_SSH to the ssh host of the server}
REMOTE=${LITSCOUT_BACKUPS:-/home/litscout/litscout/backups}
LOCAL=${1:-$HOME/.local/share/litscout/server-snapshots}
KEEP=${LITSCOUT_KEEP:-14}
umask 077
mkdir -p "$LOCAL"
remote_cmd="sudo -n find $REMOTE -maxdepth 1 -name 'litscout-state-*.tar.xz' -printf '%f\\n' | sort | tail -1"
latest=$(ssh -o BatchMode=yes -o ConnectTimeout=20 "$HOST" "$remote_cmd")
if [ -z "$latest" ]; then echo "no snapshot on $HOST"; exit 0; fi
if [ -s "$LOCAL/$latest" ]; then echo "have $latest"; exit 0; fi
ssh -o BatchMode=yes "$HOST" "sudo -n cat $REMOTE/$latest" > "$LOCAL/$latest.partial"
xz -t "$LOCAL/$latest.partial"
mv "$LOCAL/$latest.partial" "$LOCAL/$latest"
# Keep the newest $KEEP snapshots (names sort by time).
count=$(find "$LOCAL" -maxdepth 1 -name 'litscout-state-*.tar.xz' | wc -l | tr -d ' ')
excess=$((count - KEEP))
if [ "$excess" -gt 0 ]; then
  find "$LOCAL" -maxdepth 1 -name 'litscout-state-*.tar.xz' | sort | head -n "$excess" | while read -r old; do rm -f "$old"; done
fi
size=$(wc -c < "$LOCAL/$latest" | tr -d ' ')
echo "copied $latest, $size bytes"
