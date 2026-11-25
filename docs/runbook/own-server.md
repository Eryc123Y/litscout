# Own server runbook

Run LitScout on a Linux server instead of Cloudflare Workers, and move an
existing Cloudflare deployment's data there. To set up a new server from
nothing, follow [Self-hosting on your own server](../self-host-server.md)
first; this runbook has the details behind its steps. The server runs the same Worker
bundle (`apps/cli/dist/worker.js`) on workerd through Miniflare, with D1, KV
and Durable Object data kept in one state folder. Decisions and limits:
[ADR 0004](../adr/0004-own-server-runtime.md).

What stays on Cloudflare: DNS, a Cloudflare Tunnel to reach the server, and
Access in front of the private pages. Nothing else needs Workers or D1.

## What you need

- A Linux server with systemd, 1 GB of free memory and a few GB of disk.
- A dedicated user without sudo (here `litscout`). An administrator installs
  the systemd unit once.
- Node.js 22.13 or later for that user.
- A build machine with the repository (`pnpm install`, `pnpm build`). The
  server needs no repository, no pnpm and no build tools.

## Layout

```
/home/litscout/litscout/
  releases/<stamp>/   dist/ and node_modules/ of one build
  current -> releases/<stamp>
  etc/server.json     settings (mode 600)
  etc/secrets.env     the Worker's secrets (mode 600)
  state/              D1, KV and Durable Object data (mode 700)
  migration/<stamp>/  exports being imported (mode 700)
  backups/            nightly compressed snapshots (mode 700)
  logs/               one JSON-lines file per scheduled run, 30 days
  etc/litscout.config.ts, etc/venues.json, etc/briefs/   the scheduled runs' config
```

## Settings

`etc/server.json`:

```json
{
  "host": "127.0.0.1",
  "port": 8787,
  "app": "/home/litscout/litscout/current/dist",
  "state": "/home/litscout/litscout/state",
  "secretsFile": "secrets.env",
  "cronUtc": "02:00",
  "vars": { "PUBLIC_URL": "https://API_HOST", "...": "the Worker's other vars" }
}
```

- `vars` are the plain variables the Worker has on Cloudflare (`wrangler.jsonc`
  `vars`). `PUBLIC_URL` must be the https address that CLI and MCP clients use.
- `etc/secrets.env` holds the server's `KEY=VALUE` lines: `MGMT_TOKEN`,
  `CONSENT_SECRET`. The scheduled runs do not read it: their source keys go in
  `etc/sources.env` (below). The server refuses a secrets file readable by others and
  the local-test switches (`LOCAL_DEV`, `PUBLIC_RATE_LIMIT`, `BACKUP_COOLDOWN`).
- `cronUtc` is when the Worker's daily maintenance runs (Cloudflare: `0 2 * * *`).

## Install or update a build

On the build machine, after `pnpm build`, pack `apps/cli/dist` with a
`package.json` that pins the runtime packages
(`node apps/server/scripts/bundle.mjs OUT`). Copy `OUT` to
`releases/<stamp>` on the server. From a Mac, pack it with
`COPYFILE_DISABLE=1 tar --no-xattrs -czf …`: plain `tar` adds a `._NAME`
metadata file beside every file (11-25: `migrate` took `._0001_schema.sql`
for a pending migration and stopped; it now skips hidden files). Then, as
`litscout`:

```sh
cd ~/litscout/releases/STAMP
npm_config_cache=~/tmp/npm-cache npm install --omit=dev --no-audit --no-fund
rm -rf ~/tmp/npm-cache
ln -sfn ~/litscout/releases/STAMP ~/litscout/current
```

A throwaway npm cache keeps the install from adding about 600 MB to
`~/.npm`. Run these steps from `litscout`'s home: through `sudo -u litscout` from
another account, `cd ~` first (`sudo -u litscout -H bash -c 'cd ~ && …'`),
because workerd opens its working directory and stops with `Permission
denied` in another user's home. In a script, start `litscout-server` again
whatever the step between stop and start returned (11-24: a `set -e` script
left it stopped for 12 seconds). Apply new migrations with the service stopped, then start it
again:

```sh
sudo systemctl stop litscout-server
node ~/litscout/current/dist/server.js migrate --config ~/litscout/etc/server.json
sudo systemctl start litscout-server
```

After every deploy, run
`python3 ~/litscout/current/scripts/housekeep.py ~/litscout`: it keeps the
live release and the two before it as backups and removes the rest, so the next scheduled run does not
count extra releases against the 4 GB warning. The final run does the same
every night.

`migrate --dry-run` lists pending files without applying them.

## Service

Install `apps/server/deploy/litscout-server.service` as
`/etc/systemd/system/litscout-server.service`, then
`sudo systemctl daemon-reload && sudo systemctl enable --now litscout-server`.
The unit runs as `litscout`, listens on `127.0.0.1:8787`, may write only the
state folder, and is limited to 800 MB of memory and one CPU core. Logs:
`journalctl -u litscout-server`. Only one process may open a state folder:
stop the service before `migrate`, `import` or `counts`.

## Tokens

`litscout token create`, `list` and `revoke` send the token record to the
instance's `/admin/tokens` routes with the management token from the CLI's
deployment state, so they work on a server as on Cloudflare. Only the token's
hash leaves the machine that creates it. A Worker deployed before these
routes existed gets the old path through Wrangler. To make a token for the
server's own scheduled runs, run `token create --save-only` on the server as
`litscout`, with a `~/.config/litscout/state.json` that holds the management
token and the instance address.

## Scheduled runs

`scripts/daily-run.sh main|retry|final` runs the daily commands in order
(`daily start`, `status`, `fetch`, `summaries run`, `digest run`, and on the
final run `digest run --final`, `links check`, `prune`, `housekeep.py` and
on Sundays `weekly`), then `daily report`, which sends the run report to
Health, and `server report`, which sends the server's facts: the footprint
against the cap, the newest snapshot and the newest run of each timer
(`housekeep.py --dry-run --status-file logs/server-status.json`). Health
shows them in a Server tile, and `litscout doctor` checks them instead of
Wrangler, D1 usage and reconciliation and the 500 MB D1 limit, which do not
apply here. The Worker knows it runs on the server because `apps/server` sets
`LITSCOUT_RUNTIME=server`. Install
`litscout-daily@.service` and the three timers (09:45 main, 14:30 and 16:30
retries, 21:45 final, Asia/Shanghai; arXiv's listing has appeared around
13:40). The unit loads `etc/sources.env` (mode 600, owner `litscout`) when it
exists: `OPENALEX_API_KEY`, `OPENREVIEW_USERNAME` and `OPENREVIEW_PASSWORD`
(or `OPENREVIEW_TOKEN`) and `S2_API_KEY`. Without them OpenAlex conference
reads fail once the shared keyless budget runs out, and OpenReview venues are
skipped; a retry only finishes what is missing. After the day's own work, every run
catches up: days crawled but skipped while a later listing was read
(`behind` in `daily status`, oldest first, summaries then digest), then
`trends backfill` until it reports no next month; both stop while fewer than
10,000 rows of the day's budget are left (`LITSCOUT_CATCH_UP_RESERVE`). One run holds
a lock; a run is capped at 1 GiB and one CPU core.

The runs use the server's own config, `etc/litscout.config.ts`:

- `agent.summaries`: `client: "antigravity"`, `fallback: ["codex", "claude"]`.
  `agent.digest`: `client: "codex"`, `fallback: ["claude", "antigravity"]`.
  Antigravity cuts one message off at about 230 KB and a day's digest input
  is about 1 MB, so it writes summaries but not the digest. Codex refuses an
  input over 1,048,576 characters, so the writer's input is kept under
  1,000,000: on a bigger day (11-24: 1,493 papers, 2.2 MB) candidates keep
  only each summary's TL;DR, the full list keeps titles, and abstracts are
  cut to 1,200, 800, then 500 characters, as far as needed. Each client is
  used only after its login check passes; a client that fails, or returns no
  usable draft twice, hands over to the next, and the run report lists the
  clients used and the last client's error line. Prompts go to the clients on stdin (Linux caps one argument
  at 128 KB).
- `agent.summaries.chunkSize: 40`, `maxChunks: 50`: one run summarises up
  to 2,000 papers. Tuesday's listing carries the weekend's submissions
  (1,100 to 1,500 papers in November 2026); with 20 chunks (800 papers) its
  brief waited for the final run. The limit only spreads the work over runs;
  it does not reduce what the clients are asked to do.
- `research.vaultIndex: true`: without the vault on the server, the digest
  reads projects and ideas from the instance's vault index.
- `library.alphaxivCapture: "claude"`: the final run mirrors the alphaXiv
  library through Claude Code's alphaXiv connector (`alphaxiv capture
--import`; [details](daily.md#mirror-the-alphaxiv-library)). Off by
  default; the step then exits 2.
- `digest.briefFiles` under `etc/briefs/`, copied from the vault machine.
- No `legacy` block: the legacy import needs the old repository, so it runs
  on the vault machine.

## The vault machine

The vault stays on its own machine. `scripts/vault-host.sh` runs there from
its scheduler (launchd on macOS) before the server's runs: `litscout sync`
publishes the vault index (and writes digests once `vault.write` is on), the
brief files are copied to the server, and between 22:00 and 07:59 the legacy
import resumes, using budget the day's runs left.

The job first brings its own CLI to the current version. The CLI on the
vault machine has to match the server: a server deployed past it can answer
in a shape the older CLI rejects. When `LITSCOUT_CLI` is the build inside a
git clone, each run pulls that clone (`git pull --ff-only`, stopped after
`LITSCOUT_PULL_SECONDS`, 120 by default), restarts itself if the pull brought
new commits, and rebuilds (`pnpm install --frozen-lockfile`, `pnpm build`)
when `apps/cli/dist/commit` is not the clone's commit. The job's log shows
`== update: OLD -> NEW` and `== update: build SHA`. A pull that fails is
logged (`== update: pull failed; the CLI stays at SHA`) and the sync runs
with the build it has; a build that fails makes the job fail and logs the
last 20 lines the build printed (a build that works logs nothing more; on
the Mac it took between 10 and 80 seconds at the job's low priority). Nobody has to
rebuild the clone by hand after a deploy. `LITSCOUT_UPDATE=0` turns the step
off, for a CLI that is updated some other way.

When a run cannot read the server, the command's output names the cause:
`LitScout API HTTP 401`, `LitScout API unreachable`, an expired local token,
or "The server's budget reply does not fit this CLI ... update and rebuild
the CLI" when the two are on different versions. The legacy import reports
the same text as `budgetReason` beside `budget-unread`. Only an error this
code did not write still reads "Command failed ...; check authentication and
local configuration", with its status or error code when it has one.

## Agent clients

`scripts/clients.sh check` runs each client's login check (`claude auth
status`, `codex login status`, `agy models`); `clients.sh update` first
updates them (`claude update`, `npm install -g @openai/codex@latest`,
`agy update`). A failed check or update sends one ntfy message so the owner
can sign in again before a run needs the client. Install
`litscout-clients@.service` with `litscout-clients-check.timer` (daily 20:30,
before the final run) and `litscout-clients-update.timer` (Mondays 05:30,
before the morning run).

Claude Code runs with `--no-session-persistence`, so no attempt leaves its
prompt in `~/.claude/projects`, and writes the digest as JSON checked against
the draft schema (`--output-format json --json-schema`). To prove a client on
a full-size day without writing, run `digest run --dry-run --client claude
--day DAY`; it spends that client's quota.

The on-time rule is a setting: `HEALTH_ON_TIME_BY` in the server's `vars`
(`23:59` counts a digest written any time on its reading day as on time).

The daily write limit is `WRITE_LIMIT` in the same `vars`. Without it the
Worker keeps 80,000 rows a day, which fits the Cloudflare D1 Free plan; on an
own server the limit only guards against a runaway writer, so it is set much
higher (`1000000`). `litscout status` and Health show the limit in force.

## Notifications

Messages go to an ntfy topic only when the owner should act. After each
scheduled run, `scripts/notify.py` reads the run's log and sends one message
listing: failed steps, failed client login checks, a fallback to another
client, a run paused by a client's usage limit, a day with no digest after
the final run, and the `litscout` user's home above its 4 GB warning level or
its 5 GB cap. Each item is sent at most once a day. The topic URL lives in `etc/ntfy.url` (mode 600; a long random
topic name on ntfy.sh, or a self-hosted ntfy server); without that file
nothing is sent.

The vault machine's job also checks from outside: between 10:00 and 12:59 it
looks for a main-run log the server wrote since midnight and sends "run
missing" if there is none or the server cannot be reached
(`LITSCOUT_NTFY_URL` in its scheduler environment).

Subscribe in the ntfy app (iOS, Android or the web) with the topic name.

## Storage limits

LitScout's footprint is the `litscout` user's home: the LitScout folder, Node,
the agent CLIs and their state (about 2.8 GB on 2026-11-22, most of it Node,
the clients and three releases). The final run's `scripts/housekeep.py`
keeps it within the limits of ADR 0004 and logs what it removed:

| Files                                                                                                 | Kept                                    |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `releases/`                                                                                           | the live one and the two newest others  |
| `logs/run-*.jsonl`, `logs/notified-*`                                                                 | 30 days, and at most 200 MB of run logs |
| Agent transcripts (Antigravity conversations and brain folders, Codex sessions, Claude Code projects) | 14 days                                 |
| npm's download cache (`~/.npm/_cacache`)                                                              | emptied when it passes 200 MB           |
| `backups/`                                                                                            | seven snapshots (`snapshot.py --keep`)  |

The live release is never removed, nor any release when `current` does not
point at one of them. The newest run log, the one being written, always
stays. `python3 scripts/housekeep.py ~/litscout --dry-run` lists what would
go without removing it. If the home is still above 5 GB after these limits,
the run's notification says so, and the run calls `prune --over-cap`, which
removes the oldest week of archived papers (compact rows) ahead of their
12 months. The database's own retention (`storage.fullDays`, then
`storage.compactMonths`) runs in `prune`; `prune --dry-run` lists what would
go under `expiry`.

## Snapshots

`litscout-snapshot.timer` runs `scripts/snapshot.py` at 04:30: each SQLite
file is copied with SQLite's online backup while the server keeps running,
then the state folder (without its cache) is packed into one `.tar.xz` in
`backups/`; the newest seven are kept. About 6.5 MB for 39 MB of data.
`scripts/pull-snapshots.sh` on another machine copies the newest one over ssh
and keeps fourteen. To restore, stop the service, unpack a snapshot as the new
`state/` and start it.

## Move data from Cloudflare

1. Export (build machine): set `LITSCOUT_D1` to the database name and
   `LITSCOUT_WRANGLER_CONFIG` to the deployed `wrangler.jsonc`, then run
   `apps/server/scripts/export-d1.sh DIR`. It writes the schema, the rows of
   every plain table, source row counts and the KV entries. It only reads from
   Cloudflare.
2. Copy `DIR` to `migration/<stamp>` on the server (owner `litscout`, mode 700).
3. Import (server, as root): `apps/server/scripts/resync.sh STAMP` imports into
   a new state folder, compares every table's row count with the source,
   stops the service, keeps the old state as `state.prev-<stamp>`, swaps the
   new state in and starts the service. It stops before the swap if any count
   differs.

The import recreates tables, full-text indexes, triggers and indexes in an
order that keeps derived rows from being counted twice, then runs the FTS
integrity check. Rows written on Cloudflare after the export are not copied:
repeat steps 1–3 right before the switch, with no scheduled run in progress.

Not copied: Durable Object storage. OAuth MCP clients connect again after the
switch; `lsk_` bearer tokens keep working.

## Switch the hostnames

The server listens only on localhost. A Cloudflare Tunnel publishes it:

| Hostname   | Service                 | Access                                                              |
| ---------- | ----------------------- | ------------------------------------------------------------------- |
| `HOST`     | `http://localhost:8787` | the existing private app on `/app` and `/api/v1`, public exceptions |
| `API_HOST` | `http://localhost:8787` | none: the CLI and MCP use bearer tokens and OAuth                   |

1. Create a tunnel in Zero Trust → Networks → Tunnels and add both public
   hostnames. Save its token as `etc/tunnel.token` (owner `litscout`, mode 600) and install `apps/server/deploy/litscout-tunnel.service`; it runs the
   connector as `litscout` and starts only when the token file exists. A
   machine that already runs a tunnel for something else keeps it unchanged.
2. Remove `HOST` from the Worker's Custom Domains so the tunnel can take it.
   Keep the Access applications on `HOST` unchanged.
3. Point the CLI at `API_HOST` (`endpoint` in the CLI state) and run `doctor`.
4. Reconnect MCP clients to `https://API_HOST/mcp`.

## Roll back

The Worker and its D1 database stay deployed and untouched until you delete
them. To go back: remove the tunnel's public hostname for `HOST`, add `HOST`
back as the Worker's Custom Domain, point the CLI `endpoint` at the workers.dev
origin and reconnect MCP clients. Rows written on the server after the switch
stay on the server and are not copied back.
