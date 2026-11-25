#!/usr/bin/env bash
# Keep the agent CLIs on an own server usable.
#
#   clients.sh check    each client's login check (daily, before the final run)
#   clients.sh update   update the clients, then check them (weekly)
#
# A failed login check or update sends one ntfy message (etc/ntfy.url), so the
# owner can sign in again before the next scheduled run needs the client.
set -uo pipefail
ACTION=${1:-check}
BASE=${LITSCOUT_HOME:-$HOME/litscout}
URL_FILE=$BASE/etc/ntfy.url
problems=()

run() { timeout "${LITSCOUT_CLIENT_TIMEOUT:-120}" "$@" > /dev/null 2>&1; }

if [ "$ACTION" = update ]; then
  run claude update || problems+=("Claude Code update failed")
  run npm install -g --no-audit --no-fund @openai/codex@latest || problems+=("Codex update failed")
  run agy update || problems+=("Antigravity update failed")
elif [ "$ACTION" != check ]; then
  echo "usage: clients.sh check|update" >&2
  exit 2
fi

# The same checks the CLI runs before using a client.
claude auth status 2> /dev/null | grep -q '"loggedIn": *true' || problems+=("Claude Code is signed out: run claude and /login")
run codex login status || problems+=("Codex is signed out: run codex login")
run agy models || problems+=("Antigravity is signed out or cannot list models: run agy")

versions="claude $(claude --version 2> /dev/null | head -1), codex $(codex --version 2> /dev/null | head -1), agy $(agy --version 2> /dev/null | head -1)"
echo "$(date -u +%FT%TZ) $ACTION: ${#problems[@]} problem(s); $versions"
if [ "${#problems[@]}" -gt 0 ]; then
  printf '%s\n' "${problems[@]}"
  if [ -s "$URL_FILE" ]; then
    body=$(printf -- '- %s\n' "${problems[@]}")
    curl -s -m 20 -A litscout-server -H "Title: LitScout clients need attention" \
      -H "Priority: high" -H "Tags: warning" -d "$body" "$(cat "$URL_FILE")" > /dev/null || true
  fi
  exit 1
fi
