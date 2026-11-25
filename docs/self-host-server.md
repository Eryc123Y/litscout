# Self-hosting LitScout on your own Linux server

This guide sets up LitScout on a fresh Linux machine with systemd, without a
Cloudflare Worker or D1 database. The server runs the same Worker bundle on
workerd through Miniflare and keeps its data in one folder. The daily runs,
summaries and digests run there too, through the agent CLIs you sign in to.
For the Cloudflare deployment, see [Self-hosting LitScout](self-host.md). For
moving an existing Cloudflare deployment to a server, see the
[own-server runbook](runbook/own-server.md), which also has the details behind
each step here. Why the server exists and its limits:
[ADR 0004](adr/0004-own-server-runtime.md).

You need:

- **The server**: Linux with systemd (Ubuntu 24.04 tested), `curl`, `tar`,
  `xz-utils` and Python 3.10 or later, about 1 GB of free memory and 5 GB of
  disk. An administrator runs the few `sudo` lines below once.
- **A build machine** with Node 22.13 or later, pnpm and this repository. The
  server needs no repository and no build tools.
- **A public HTTPS address** for the reader, the CLI and MCP clients, for
  example a Cloudflare Tunnel (step 9) or your own reverse proxy with TLS.
  Until you have one, everything can be checked on the server itself.

LitScout runs as a user called `litscout` without sudo. The systemd units in
`deploy/` assume that user and the home `/home/litscout`; for another user,
change those paths in the units you install.

## 1. Create the user (administrator)

```sh
sudo useradd --create-home --shell /bin/bash litscout
sudo apt-get update
sudo apt-get install -y curl tar xz-utils python3
```

## 2. Install Node for the user

As `litscout` (`sudo -iu litscout`), install Node 22 into the home folder and
put it on the path:

```sh
mkdir -p ~/.local/node ~/.local/bin
curl -fsSL https://nodejs.org/dist/v22.23.5/node-v22.23.5-linux-x64.tar.xz \
  | tar -xJ --strip-components=1 -C ~/.local/node
echo 'export PATH=$HOME/.local/node/bin:$HOME/.local/bin:$PATH' >> ~/.bashrc
export PATH=$HOME/.local/node/bin:$HOME/.local/bin:$PATH
node --version
```

On an ARM server use the `linux-arm64` file.

## 3. Build a release (build machine)

```sh
pnpm install --frozen-lockfile
pnpm build
node apps/server/scripts/bundle.mjs /tmp/litscout-release
COPYFILE_DISABLE=1 tar --no-xattrs -C /tmp/litscout-release -czf litscout-release.tgz .
scp litscout-release.tgz SERVER:/tmp/
```

A release holds the built CLI and Worker (`dist/`), the operations scripts
(`scripts/`), the systemd units (`deploy/`) and a `package.json` that pins
the runtime packages.

## 4. Install the release (as `litscout`)

```sh
STAMP=$(date +%Y%m%d-%H%M)
mkdir -p ~/litscout/releases/$STAMP
tar -xzf /tmp/litscout-release.tgz -C ~/litscout/releases/$STAMP
cd ~/litscout/releases/$STAMP
npm_config_cache=~/tmp/npm-cache npm install --omit=dev --no-audit --no-fund
rm -rf ~/tmp/npm-cache
ln -sfn ~/litscout/releases/$STAMP ~/litscout/current
echo "alias litscout='node ~/litscout/current/dist/index.js'" >> ~/.bashrc
alias litscout='node ~/litscout/current/dist/index.js'
```

Every later update repeats steps 3 and 4 with a new stamp, then runs
`migrate` with the service stopped (step 6) and restarts it. The final run
keeps the live release and the two newest others.

## 5. Configure

```sh
mkdir -p ~/litscout/etc && cd ~/litscout/etc
litscout init
```

`init` asks a few questions: choose 3, your own Linux server, and give the
server's public HTTPS address (the one CLI and MCP clients will use, for
example `https://litscout-api.example.org`), then your time zone, language,
arXiv categories, topics and keywords, and the journals and conferences to
watch. It writes `litscout.config.ts`, `venues.json` and templates from the
answers. Summaries need an agent CLI signed in as `litscout`: keep keyword
mode for now and see step 11. `litscout init --defaults` writes a starter to
edit by hand instead; in it, set at least:

- `instance.publicUrl`: the public HTTPS address;
- `instance.timezone` and `instance.language`;
- `sources.arxiv.categories` and `topics`;
- `agent`: keep `mode: "none"` for keyword-only feeds, or see step 11.

Then prepare the server's own settings:

```sh
litscout server init --config ~/litscout/etc/litscout.config.ts
```

This creates the LitScout folder (`etc`, `state`, `logs`, `backups`,
`releases`, mode 700) and writes:

- `etc/server.json`: where the server listens (`127.0.0.1:8787`), its data
  folder and the Worker's variables, taken from your config;
- `etc/secrets.env`: a new management token and consent secret (mode 600).
  Add the server's source keys here as `S2_API_KEY=…`, `OPENALEX_API_KEY=…`
  or `CORE_API_KEY=…` lines if you have them; the daily run's keys go in
  `etc/sources.env` ([Paper sources and their keys](sources.md#on-your-own-server));
- `~/.config/litscout/state.json`: the management token and address for the
  CLI.

`--dry-run` lists the files and variable names without writing anything.
After changing the config, rerun with `--force`: the settings are rewritten
(the old file is kept beside it) and the secrets stay.

## 6. Create the database

```sh
node ~/litscout/current/dist/server.js migrate --config ~/litscout/etc/server.json
```

`migrate --dry-run` lists the migrations first. Run `migrate` only while the
service is stopped.

## 7. Start the service (administrator)

```sh
sudo cp /home/litscout/litscout/current/deploy/litscout-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now litscout-server
curl -s http://127.0.0.1:8787/health
```

`{"ok":true}` means the Worker runs and the database is current. The unit
listens on `127.0.0.1` only, may write only the state folder, and is limited
to 800 MB of memory and one CPU core. Without systemd, run
`node ~/litscout/current/dist/server.js serve --config
~/litscout/etc/server.json` instead. To only try LitScout, on one computer
and with no public address, follow
[Try LitScout on your own computer](try-locally.md).

## 8. Check it on the server

Before the public address works, point a copy of the config at the local
port. The CLI accepts an HTTP address on the loopback interface:

```sh
cd ~/litscout/etc
sed 's#publicUrl: "https://[^"]*"#publicUrl: "http://127.0.0.1:8787"#' \
  litscout.config.ts > local.config.ts
litscout token create --name scheduler --scopes read,ingest --save-only --config local.config.ts
litscout daily status --json --config local.config.ts
litscout doctor --config local.config.ts
```

`token create --save-only` stores the new token for that address without
printing it. `doctor` should report `runtime: "server"` and fail only on
checks you have not set up yet, such as Access. Later runs use the public address, so create the scheduler token
for it again in step 10.

## 9. Give it a public address

The reader (`/app`), the API (`/api/v1`) and MCP (`/mcp`) are all served on
`127.0.0.1:8787`. Put HTTPS in front of it:

- **Cloudflare Tunnel**: create a named tunnel in the Cloudflare dashboard
  with a public hostname that points to `http://127.0.0.1:8787`, save its
  token as `~/litscout/etc/tunnel.token` (mode 600), install `cloudflared`,
  then as administrator copy `deploy/litscout-tunnel.service` to
  `/etc/systemd/system/` and `enable --now` it. Protect the reader hostname
  with Cloudflare Access and put its team domain and audience in `access` in
  the config ([browser access](self-host.md#5-set-up-browser-access-for-one-email)),
  then rerun `server init --force` and restart `litscout-server`.
- **Your own reverse proxy** with TLS (nginx, Caddy) to `127.0.0.1:8787`.
  Keep `/app` behind a login of your own: LitScout's private pages rely on
  Cloudflare Access or on API tokens.

`instance.publicUrl` must be the address the API answers on.

## 10. Create the scheduler token

```sh
litscout token create --name scheduler --scopes read,ingest --save-only \
  --config ~/litscout/etc/litscout.config.ts
litscout doctor --config ~/litscout/etc/litscout.config.ts
```

Add `vault` to the scopes if a vault machine will sync an Obsidian vault
([vault sync](self-host.md#obsidian-vault-sync)). On a server, `doctor`
skips the Cloudflare checks (Wrangler, D1 usage, the 500 MB D1 limit) and
checks the server's storage against its 5 GB cap, the newest snapshot and the
last scheduled runs instead.

## 11. Agent clients (optional)

Summaries and digests need at least one signed-in agent CLI for `litscout`:
Claude Code (`claude`), Codex (`npm install -g @openai/codex`, then `codex
login`) or Antigravity (`agy`). Install each as `litscout` so it lands in
`~/.local`, sign in once, then set `agent.mode: "client"` and the chains in
the config, for example:

```ts
agent: {
  mode: "client",
  summaries: { client: "codex", fallback: ["claude"] },
  digest: { client: "codex", fallback: ["claude"] },
},
```

To mirror your alphaXiv library into the Library every night, sign Claude
Code in with a claude.ai account that has the alphaXiv connector and set
`library: { alphaxivCapture: "claude" }`.

`~/litscout/current/scripts/clients.sh check` runs each client's login
check. Subscription CLIs only: LitScout never needs an API key for them.

## 12. Scheduled runs and snapshots (administrator)

The timers ship in UTC: the main run at 01:45, retries at 06:30 and 08:30
(arXiv's new listing has appeared around 05:40), the final run at 13:45 and
the snapshot at 20:30. Change the `OnCalendar=` lines to suit your day; a
time zone name works too, for example `*-*-* 09:45:00 Europe/Berlin`. The
weekly summary follows `instance.timezone` in your config. The fetch reads source keys from
`etc/sources.env` (mode 600, owner `litscout`; `KEY=VALUE` lines for
`OPENALEX_API_KEY`, `OPENREVIEW_USERNAME` and `OPENREVIEW_PASSWORD` or
`OPENREVIEW_TOKEN`, `S2_API_KEY` and any publisher keys;
see [Paper sources and their keys](sources.md)), which
`litscout-daily@.service` loads when it exists. Then:

```sh
# In a root shell: other users cannot read the litscout home folder.
sudo sh -c 'cd /home/litscout/litscout/current/deploy && cp \
  litscout-daily@.service litscout-daily-*.timer \
  litscout-snapshot.service litscout-snapshot.timer \
  litscout-clients@.service litscout-clients-*.timer /etc/systemd/system/'
sudo systemctl daemon-reload
sudo systemctl enable --now litscout-daily-main.timer litscout-daily-retry.timer \
  litscout-daily-final.timer litscout-snapshot.timer
# With agent clients:
sudo systemctl enable --now litscout-clients-check.timer litscout-clients-update.timer
```

Each run (`scripts/daily-run.sh main|retry|final`) fetches, summarises,
digests and catches up what is missing, writes one JSON-lines log to
`~/litscout/logs/`, reports to Health, and sends the server's facts. The final
run also prunes old records and keeps the files within their limits
([storage limits](runbook/own-server.md#storage-limits)). Snapshots of the
data go to `~/litscout/backups/` every night; copy them off the server
(`scripts/pull-snapshots.sh` on another machine). Notifications through ntfy
are optional: put a topic URL in `~/litscout/etc/ntfy.url` (mode 600).

Do not start `litscout-daily@` units by hand while a timer may fire; a run
waits for the one before it.

## 13. First crawl

```sh
litscout daily fetch --json --config ~/litscout/etc/litscout.config.ts
litscout daily status --json --config ~/litscout/etc/litscout.config.ts
```

Then open the reader at your public address. Health shows the delivery
calendar, the last runs and a Server tile with storage, the newest snapshot
and each timer's last run. To pair an MCP client, see
[Pair an MCP client](self-host.md#10-pair-an-mcp-client) with your public
address.

The steps above are checked in a clean Ubuntu 24.04 container by
`tools/self-host-server-check.sh RELEASE.tgz` (systemd steps excepted).
