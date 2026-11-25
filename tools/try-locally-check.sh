#!/usr/bin/env bash
# Follow docs/try-locally.md in a clean Ubuntu 24.04 container, from a clean
# clone of the commit that is checked out here.
#
#   tools/try-locally-check.sh
#
# Needs Docker and the network (Ubuntu packages, Node from nodejs.org, npm
# packages, arXiv). Rerun it after a change to the guide or to init,
# server init --local, migrate, serve or daily fetch. Steps 1-5 as written,
# then doctor, the checks behind "How a trial stays private" and the export
# from step 9. The browser and the agent clients (steps 7 and 8) are not
# covered.
set -euo pipefail
NAME=ls-trial-test
REPO=$(git rev-parse --show-toplevel)
BUNDLE=$(mktemp -d)/litscout.bundle
git -C "$REPO" bundle create -q "$BUNDLE" HEAD
docker rm -f $NAME >/dev/null 2>&1 || true
docker run -d --name $NAME ubuntu:24.04 sleep infinity >/dev/null
docker cp "$BUNDLE" $NAME:/tmp/litscout.bundle
root() { docker exec $NAME bash -c "$1"; }
user() { docker exec -u reader -w /home/reader $NAME bash -c "$ENV
$1"; }
ENV='export PATH=$HOME/.local/node/bin:$PATH'

echo "== the reader's computer: Git, Node and pnpm"
root 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq >/dev/null && apt-get install -y -qq git curl xz-utils python3 >/dev/null && useradd --create-home --shell /bin/bash reader && chmod 644 /tmp/litscout.bundle && echo ok'
NODEARCH=$([ "$(docker exec $NAME uname -m)" = aarch64 ] && echo arm64 || echo x64)
user "mkdir -p ~/.local/node
curl -fsSL https://nodejs.org/dist/v22.23.5/node-v22.23.5-linux-$NODEARCH.tar.xz | tar -xJ --strip-components=1 -C ~/.local/node
npm install -g pnpm >/dev/null 2>&1; node --version; pnpm --version"

# Every later step starts like a new terminal: the two lines from step 1.
ENV="$ENV"'
REPO="$HOME/litscout"; export PATH="$REPO/node_modules/.bin:$PATH"'

echo "== 1. build"
user 'git -c advice.detachedHead=false clone -q /tmp/litscout.bundle litscout && cd litscout
pnpm install --frozen-lockfile >/dev/null 2>&1
pnpm build >/dev/null 2>&1
ls apps/cli/dist | tr "\n" " "; echo; litscout --help | head -c 60; echo'

echo "== 2. config"
user 'mkdir -p ~/litscout/etc && cd ~/litscout/etc
litscout init --json | head -c 200; echo
sed -i "s#// publicUrl: \"https://worker.example.workers.dev\",#publicUrl: \"http://127.0.0.1:8787\",#" litscout.config.ts
grep -n publicUrl litscout.config.ts'

echo "== 3. prepare the server"
user 'cd ~/litscout/etc
litscout server init --local --json | head -c 300; echo
node "$REPO/apps/cli/dist/server.js" migrate --config ~/litscout/etc/server.json | tail -c 120; echo
stat -c "%a %n" ~/litscout/etc/secrets.env ~/litscout/etc/server.json ~/.config/litscout/state.json'

echo "== 4. start the server"
user 'nohup node "$REPO/apps/cli/dist/server.js" serve --config ~/litscout/etc/server.json > ~/serve.log 2>&1 &
for i in $(seq 1 40); do sleep 1; h=$(curl -s http://127.0.0.1:8787/health || true); [ "$h" = "{\"ok\":true}" ] && break; done
echo health=$h; cat ~/serve.log'

echo "== 5. first day"
user 'cd ~/litscout/etc
litscout token create --name scheduler --scopes read,ingest --save-only --json | head -c 200; echo
litscout daily fetch --json | head -c 160; echo
curl -s -o /dev/null -w "reader page %{http_code}\n" http://127.0.0.1:8787/app/days
curl -s http://127.0.0.1:8787/api/v1/feed/days | head -c 200; echo
litscout doctor --json > ~/doctor.json || true
python3 -c "import json; d=json.load(open(\"/home/reader/doctor.json\")); x=d[\"data\"]; print(\"success\", d.get(\"success\")); print(\"not ok\", [k for k,v in x[\"checks\"].items() if not v.get(\"ok\")]); print(\"access\", x[\"checks\"][\"access\"][\"message\"]); print(\"warnings\", x[\"warnings\"])"'

echo "== how a trial stays private (expect 401, 401, 401, 401, 403)"
user 'curl -s -o /dev/null -w "another host name: %{http_code}\n" -H "Host: rebind.example:8787" http://127.0.0.1:8787/api/v1/feed/days
curl -s -o /dev/null -w "through a proxy: %{http_code}\n" -H "X-Forwarded-For: 203.0.113.7" http://127.0.0.1:8787/api/v1/feed/days
curl -s -o /dev/null -w "another port: %{http_code}\n" -H "Host: 127.0.0.1:9999" http://127.0.0.1:8787/api/v1/feed/days
curl -s -o /dev/null -w "agent endpoint without a token: %{http_code}\n" -X POST -H "Content-Type: application/json" -d "{}" http://127.0.0.1:8787/mcp
curl -s -o /dev/null -w "write from another site: %{http_code}\n" -X POST -H "Content-Type: application/json" -H "Sec-Fetch-Site: cross-site" -H "Origin: https://elsewhere.example" -d "{}" http://127.0.0.1:8787/api/v1/events'

echo "== 9. export"
user 'cd ~/litscout/etc
litscout token create --name export --scopes read,write --save-only --json | head -c 120; echo
litscout backup --out ~/litscout-export.json --json | head -c 200; echo
ls -la ~/litscout-export.json'
docker rm -f $NAME >/dev/null
echo "== done"
