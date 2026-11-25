#!/usr/bin/env bash
# On the server, as root: import an export into a new state folder, compare
# every table's row count with the source, then swap it in and restart.
#
#   apps/server/scripts/resync.sh STAMP
#
# Inputs: $LITSCOUT_HOME/migration/STAMP/{schema.json,data.sql,kv.json,counts-remote.json}
# from export-d1.sh, owned by the service user. The previous state folder is
# kept as state.prev-STAMP. Nothing is swapped if a count differs.
set -euo pipefail
STAMP=${1:?usage: resync.sh STAMP}
HOME_DIR=${LITSCOUT_HOME:-/home/litscout/litscout}
SERVICE_USER=${LITSCOUT_USER:-litscout}
SERVICE=${LITSCOUT_SERVICE:-litscout-server}
NODE=${LITSCOUT_NODE:-$(getent passwd "$SERVICE_USER" | cut -d: -f6)/.local/node/bin/node}
INPUT=$HOME_DIR/migration/$STAMP
NEW=$HOME_DIR/state.new-$STAMP
as_user() { sudo -u "$SERVICE_USER" -H "$@"; }

[ -e "$NEW" ] && { echo "$NEW exists; use a new stamp" >&2; exit 1; }
for file in schema.json data.sql kv.json counts-remote.json; do
  [ -f "$INPUT/$file" ] || { echo "missing $INPUT/$file" >&2; exit 1; }
done

# The service's settings with a new state folder and an absolute secrets path.
as_user python3 -I - "$HOME_DIR/etc/server.json" "$INPUT/server.import.json" "$NEW" <<'PY'
import json, os, sys
source, target, state = sys.argv[1:]
config = json.load(open(source))
if config.get("secretsFile"):
    config["secretsFile"] = os.path.join(os.path.dirname(source), config["secretsFile"])
config["state"] = state
os.umask(0o077)
json.dump(config, open(target, "w"), indent=2)
PY

cd "$HOME_DIR/current"
as_user nice -n 10 "$NODE" dist/server.js import --config "$INPUT/server.import.json" \
  --schema "$INPUT/schema.json" --data "$INPUT/data.sql" --kv "$INPUT/kv.json"
as_user nice -n 10 "$NODE" dist/server.js counts --config "$INPUT/server.import.json" \
  > "$INPUT/counts-local.json"
as_user python3 -I - "$INPUT/counts-remote.json" "$INPUT/counts-local.json" <<'PY'
import json, sys
remote = {row["t"]: row["n"] for block in json.load(open(sys.argv[1])) for row in block["results"]}
local = json.load(open(sys.argv[2]))
differ = {t: [remote.get(t), local.get(t)] for t in sorted(set(remote) | set(local))
          if remote.get(t) != local.get(t)}
print(f"tables={len(local)} rows={sum(local.values())} mismatches={len(differ)}")
if differ:
    print(json.dumps(differ))
    sys.exit(1)
PY

systemctl stop "$SERVICE"
if [ -d "$HOME_DIR/state" ]; then mv "$HOME_DIR/state" "$HOME_DIR/state.prev-$STAMP"; fi
mv "$NEW" "$HOME_DIR/state"
systemctl start "$SERVICE"

PORT=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("port", 8787))' "$HOME_DIR/etc/server.json")
for _ in $(seq 1 30); do
  curl -sf "http://127.0.0.1:$PORT/health" > /dev/null && break
  sleep 2
done
curl -s "http://127.0.0.1:$PORT/health"
echo
