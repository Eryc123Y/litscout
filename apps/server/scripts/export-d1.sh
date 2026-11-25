#!/usr/bin/env bash
# Export a deployed LitScout's D1 database and OAUTH_KV for `server.js import`.
# Read-only on Cloudflare. Run from the repository after `pnpm install`.
#
#   LITSCOUT_D1=litscout-db LITSCOUT_WRANGLER_CONFIG=~/.config/litscout/wrangler.jsonc \
#     apps/server/scripts/export-d1.sh DIR
#
# DIR is created mode 700 and gets schema.json, tables.txt, data.sql, kv.json
# and counts-remote.json, each mode 600.
set -euo pipefail
: "${LITSCOUT_D1:?set LITSCOUT_D1 to the D1 database name}"
: "${LITSCOUT_WRANGLER_CONFIG:?set LITSCOUT_WRANGLER_CONFIG to the deployed wrangler.jsonc}"
DIR=${1:?usage: export-d1.sh DIR}
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
WRANGLER=${WRANGLER:-$REPO/node_modules/.bin/wrangler}
umask 077
mkdir -p "$DIR"
d1() { "$WRANGLER" d1 "$@" "$LITSCOUT_D1" --remote --config "$LITSCOUT_WRANGLER_CONFIG"; }

d1 execute --json --command "SELECT type, name, sql FROM sqlite_master ORDER BY rowid" \
  > "$DIR/schema.json"
# Plain tables only: not virtual tables, their FTS shadow tables or internal tables.
python3 -I - "$DIR/schema.json" > "$DIR/tables.txt" <<'PY'
import json, re, sys
rows = json.load(open(sys.argv[1]))[0]["results"]
virtual = {r["name"] for r in rows if r["type"] == "table"
           and re.match(r"\s*CREATE\s+VIRTUAL", r["sql"] or "", re.I)}
shadow = re.compile(r"_(data|idx|content|docsize|config)")
for r in rows:
    name = r["name"]
    if r["type"] != "table" or not r["sql"] or name in virtual:
        continue
    if name.startswith(("sqlite_", "_cf_")):
        continue
    if any(name.startswith(v + "_") and shadow.fullmatch(name[len(v):]) for v in virtual):
        continue
    print(name)
PY

# `d1 export` refuses a database with FTS tables, so name the plain tables.
# --no-schema leaves out generated columns; the import recreates them.
ARGS=()
while read -r table; do ARGS+=(--table "$table"); done < "$DIR/tables.txt"
"$WRANGLER" d1 export "$LITSCOUT_D1" --remote --config "$LITSCOUT_WRANGLER_CONFIG" \
  --no-schema "${ARGS[@]}" --output "$DIR/data.sql" > "$DIR/export.log" 2>&1

SQL=""
while read -r table; do SQL+="SELECT '$table' AS t, count(*) AS n FROM \"$table\";"; done < "$DIR/tables.txt"
d1 execute --json --command "$SQL" > "$DIR/counts-remote.json"

# KV entries with their expiry and metadata. Values are read as text.
"$WRANGLER" kv key list --binding OAUTH_KV --remote --config "$LITSCOUT_WRANGLER_CONFIG" \
  > "$DIR/kv-keys.json"
python3 -I - "$DIR/kv-keys.json" "$DIR/kv.json" "$WRANGLER" "$LITSCOUT_WRANGLER_CONFIG" <<'PY'
import json, subprocess, sys
keys_file, out_file, wrangler, config = sys.argv[1:]
entries = []
for key in json.load(open(keys_file)):
    value = subprocess.run(
        [wrangler, "kv", "key", "get", key["name"], "--binding", "OAUTH_KV",
         "--remote", "--config", config, "--text"],
        capture_output=True, text=True, check=True).stdout
    entry = {"name": key["name"], "value": value}
    if key.get("expiration"):
        entry["expiration"] = key["expiration"]
    if key.get("metadata") is not None:
        entry["metadata"] = key["metadata"]
    entries.append(entry)
json.dump(entries, open(out_file, "w"))
PY

echo "tables=$(wc -l < "$DIR/tables.txt" | tr -d ' ')" \
  "rows=$(grep -c '^INSERT' "$DIR/data.sql")" \
  "kv=$(python3 -I -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' "$DIR/kv.json")"
