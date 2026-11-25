#!/usr/bin/env bash
# Follow docs/self-host-server.md in a clean Ubuntu 24.04 container.
#
#   tools/self-host-server-check.sh RELEASE.tgz
#
# RELEASE.tgz is a release from step 3 of the guide. Needs Docker and the
# network (Ubuntu packages, Node from nodejs.org, arXiv). Rerun it after a
# change to the guide or to server init, migrate, serve or daily-run.sh.
# Steps 1-8 and 10-13 as written; systemd units (7, 12) are replaced by
# running serve in the background and one daily-run.sh by hand, because a
# container has no systemd. The public address (9) is not available, so the
# CLI uses the local copy of the config from step 8 throughout.
set -euo pipefail
RELEASE=$1
NAME=ls-guide-test
docker rm -f $NAME >/dev/null 2>&1 || true
docker run -d --name $NAME ubuntu:24.04 sleep infinity >/dev/null
docker cp "$RELEASE" $NAME:/tmp/litscout-release.tgz
root() { docker exec $NAME bash -lc "$1"; }
as_litscout() { docker exec -u litscout -w /home/litscout $NAME bash -lc "$1"; }

echo "== 1. user and packages"
root 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq >/dev/null && apt-get install -y -qq curl tar xz-utils python3 >/dev/null && useradd --create-home --shell /bin/bash litscout && chmod 644 /tmp/litscout-release.tgz && echo ok'

echo "== 2. node"
ARCH=$(docker exec $NAME uname -m)
NODEARCH=$([ "$ARCH" = aarch64 ] && echo arm64 || echo x64)
as_litscout "mkdir -p ~/.local/node ~/.local/bin
curl -fsSL https://nodejs.org/dist/v22.23.5/node-v22.23.5-linux-$NODEARCH.tar.xz | tar -xJ --strip-components=1 -C ~/.local/node
echo 'export PATH=\$HOME/.local/node/bin:\$HOME/.local/bin:\$PATH' >> ~/.bashrc
export PATH=\$HOME/.local/node/bin:\$HOME/.local/bin:\$PATH
node --version"

# bash -lc does not read .bashrc; the guide's interactive shell does.
ENV='export PATH=$HOME/.local/node/bin:$HOME/.local/bin:$PATH; litscout() { node ~/litscout/current/dist/index.js "$@"; }'

echo "== 4. release"
as_litscout "$ENV
STAMP=\$(date +%Y%m%d-%H%M)
mkdir -p ~/litscout/releases/\$STAMP
tar -xzf /tmp/litscout-release.tgz -C ~/litscout/releases/\$STAMP
cd ~/litscout/releases/\$STAMP && npm_config_cache=~/tmp/npm-cache npm install --omit=dev --no-audit --no-fund 2>&1 | tail -1 && rm -rf ~/tmp/npm-cache
ln -sfn ~/litscout/releases/\$STAMP ~/litscout/current
ls ~/litscout/current"

echo "== 5. configure"
as_litscout "$ENV
mkdir -p ~/litscout/etc && cd ~/litscout/etc
litscout init --json | head -c 300; echo
sed -i 's#// publicUrl: \"https://worker.example.workers.dev\",#publicUrl: \"https://litscout-api.invalid\",#' litscout.config.ts
grep -n publicUrl litscout.config.ts
litscout server init --config ~/litscout/etc/litscout.config.ts --dry-run --json
litscout server init --config ~/litscout/etc/litscout.config.ts --json
stat -c '%a %n' ~/litscout/etc/secrets.env ~/litscout/etc/server.json ~/litscout/state ~/.config/litscout/state.json"

echo "== 6. database"
as_litscout "$ENV
node ~/litscout/current/dist/server.js migrate --config ~/litscout/etc/server.json --dry-run | head -c 200; echo
node ~/litscout/current/dist/server.js migrate --config ~/litscout/etc/server.json | tail -c 200; echo"

echo "== 7. serve (no systemd in a container)"
as_litscout "$ENV
nohup node ~/litscout/current/dist/server.js serve --config ~/litscout/etc/server.json > ~/serve.log 2>&1 &
for i in \$(seq 1 40); do sleep 1; h=\$(curl -s http://127.0.0.1:8787/health || true); [ \"\$h\" = '{\"ok\":true}' ] && break; done
echo health=\$h"

echo "== 8. check on the server"
as_litscout "$ENV
cd ~/litscout/etc
sed 's#publicUrl: \"https://[^\"]*\"#publicUrl: \"http://127.0.0.1:8787\"#' litscout.config.ts > local.config.ts
grep -n publicUrl local.config.ts
litscout token create --name scheduler --scopes read,ingest --save-only --config local.config.ts --json | head -c 400; echo
litscout daily status --json --config local.config.ts | head -c 400; echo"

echo "== 10. doctor (local address)"
as_litscout "$ENV
cd ~/litscout/etc
litscout doctor --json --config local.config.ts > ~/doctor.json || true
python3 -c 'import json; d=json.load(open(\"/home/litscout/doctor.json\")); x=d[\"data\"]; print(\"success\", d.get(\"success\")); print(\"runtime\", x.get(\"runtime\")); print(\"not ok\", [k for k,v in x[\"checks\"].items() if not v.get(\"ok\")]); print(\"warnings\", x[\"warnings\"])'"

echo "== 12. one scheduled run by hand (timers need systemd)"
as_litscout "$ENV
LITSCOUT_CONFIG=~/litscout/etc/local.config.ts LITSCOUT_NODE=\$(command -v node) timeout 900 ~/litscout/current/scripts/daily-run.sh final; echo exit=\$?
ls ~/litscout/logs
python3 -c '
import json, glob
for line in open(sorted(glob.glob(\"/home/litscout/litscout/logs/run-*.jsonl\"))[-1]):
    r = json.loads(line); print(r[\"step\"], r[\"exit\"], r[\"output\"][-160:].replace(chr(10), \" \"))'"

echo "== 13. health and server facts"
as_litscout "$ENV
cd ~/litscout/etc
litscout daily status --json --config local.config.ts | head -c 600; echo
litscout doctor --json --config local.config.ts > ~/doctor2.json || true
python3 -c 'import json; x=json.load(open(\"/home/litscout/doctor2.json\"))[\"data\"]; print(\"server\", json.dumps(x.get(\"server\"))[:500]); print(\"warnings\", x[\"warnings\"])'"
echo "== done"
