# Try LitScout on your own computer

A trial runs all of LitScout on one computer: the server, the web reader and
the `litscout` CLI. It needs no Cloudflare account, no domain and no server.
Use it to see whether LitScout suits you. For daily use, move to one of the
two deployments in the [README](../README.md#choose-how-to-run-it); an export
takes your library with you (step 9).

A trial differs from a deployment in three ways.

- **It is reachable from this computer only.** The reader is not on your
  phone, and claude.ai cannot connect to it, because both need a public HTTPS
  address.
- **It has no sign-in.** Anyone who uses this computer can open the reader.
  Do not run a trial on a shared machine.
- **Nothing runs by itself.** Papers arrive when you run the fetch, and the
  reader works while the server process runs.

You need macOS or Linux, Git, Node 22.13 or later, and pnpm at the version in
[`package.json`](../package.json). The commands assume a POSIX shell.

## 1. Build

```sh
git clone https://github.com/Eryc123Y/litscout.git
cd litscout
pnpm install --frozen-lockfile
pnpm build
REPO="$PWD"
export PATH="$REPO/node_modules/.bin:$PATH"
```

`litscout --help` now lists the commands. A new terminal needs the `REPO` and
`PATH` lines again, with the folder's full path in place of `$PWD`.

## 2. Write a config

Keep the config in a private folder outside the repository.

```sh
mkdir -p ~/litscout/etc
cd ~/litscout/etc
litscout init
```

`init` writes `litscout.config.ts`, `venues.json` and scheduler examples.
Open `litscout.config.ts` and set:

- `instance.publicUrl` to `"http://127.0.0.1:8787"`. This address marks the
  setup as a trial. Choose another port if 8787 is taken.
- `instance.timezone` to your IANA time zone, such as `"Europe/Berlin"`.
- `sources.arxiv.categories` to the arXiv categories you follow.
- `topics` to your topic names and keywords. A keyword in a paper's title or
  abstract puts the paper on the day's shortlist.

Leave `agent.mode: "none"` for now. It gives a keyword-only feed with
abstracts, which needs no model.

## 3. Prepare the server

```sh
litscout server init --local
node "$REPO/apps/cli/dist/server.js" migrate --config ~/litscout/etc/server.json
```

`server init --local` creates the `~/litscout` folders and writes three
private files: `etc/server.json` (the server's settings), `etc/secrets.env`
(a new management token) and `~/.config/litscout/state.json` (the same token,
for the CLI). `migrate` creates the database in `~/litscout/state`.

If `~/.config/litscout/state.json` already belongs to another LitScout
instance, `server init` stops and says so. Move that file aside first.

## 4. Start the server

```sh
node "$REPO/apps/cli/dist/server.js" serve --config ~/litscout/etc/server.json
```

The command prints the address and keeps running. Leave it in this terminal
and stop it with Ctrl-C. Do the next steps in a second terminal.

## 5. Fetch the first day

```sh
cd ~/litscout/etc
litscout token create --name scheduler --scopes read,ingest --save-only
litscout daily fetch --json
```

`token create --save-only` stores a token for the fetch without printing it.
`daily fetch` reads the newest arXiv listing for your categories and reports
its date as `day`.

Open <http://127.0.0.1:8787/app/days> and pick that date. Keyword matches
lead the list. On a busy day, **Start triage** walks through the papers
worth a decision; Skip, To read and Save are one key each.

`litscout doctor` checks the config, the server and the token, and prints a
fix for each failed check.

## 6. Fetch every day

Run `litscout daily fetch --json` from `~/litscout/etc` each morning, or let
cron do it: `cron.md` in the same folder has an entry to copy. The server
from step 4 must be running when the fetch runs. A missed day is filled in
by a later fetch.

## 7. Summaries and the morning brief (optional)

A model can write a short summary of each paper and a daily brief with picks
per topic. The model work runs through an agent CLI you are signed in to on
this computer, such as Claude Code or Codex.

1. In `litscout.config.ts`, set `agent.mode: "client"` and choose the client
   under `agent.summaries` and `agent.digest`. The Cloudflare guide's
   [config step](self-host.md#7-edit-the-config-and-update-deployment)
   describes these fields.
2. Run `litscout server init --local --force` and restart the server, so the
   reader knows that summaries are on.
3. After each fetch, run the summary and digest steps of the
   [daily runbook](runbook/daily.md#self-host-runs).

## 8. Connect an agent client (optional)

Claude Code and Codex on this computer can read the feed and library through
the MCP endpoint at `http://127.0.0.1:8787/mcp`. A trial connects them with a
token. Sign-in through OAuth and the claude.ai connector need a deployment
with a public HTTPS address.

```sh
litscout token create --name claude-code --scopes read,write
```

The command prints the token once. Export it as `LITSCOUT_TOKEN`, then
register the server:

```sh
claude mcp add --transport http litscout http://127.0.0.1:8787/mcp \
  --header "Authorization: Bearer $LITSCOUT_TOKEN"
```

For Codex, use
`codex mcp add litscout --url http://127.0.0.1:8787/mcp --bearer-token-env-var LITSCOUT_TOKEN`.
The [tool list](self-host.md#tools-and-example-arguments) shows what a client
can ask for.

## 9. Update, move on or remove

**Update.** Stop the server, then:

```sh
cd "$REPO"
git pull
pnpm install --frozen-lockfile
pnpm build
node "$REPO/apps/cli/dist/server.js" migrate --config ~/litscout/etc/server.json
```

Start the server again as in step 4.

**Move to a deployment.** Export your library, notes and reading state, set
up LitScout [on Cloudflare](self-host.md) or
[on a server](self-host-server.md), and restore the export there. The export
needs a token with write access.

```sh
cd ~/litscout/etc
litscout token create --name export --scopes read,write --save-only
litscout backup --out ~/litscout-export.json
```

[Restore an export](self-host.md#restore-an-export) has the other half. The
daily paper lists are not part of an export; the new instance fetches its
own.

**Remove.** Stop the server and delete `~/litscout`, `~/.config/litscout`
and `~/.cache/litscout`. Remove the cron entry if you added one.

## How a trial stays private

The server listens on `127.0.0.1`, which other machines cannot reach, and
`server.js` refuses to start a trial on any other address. It also refuses a
request that names the computer by anything but `127.0.0.1`, `localhost` or
`[::1]`, so a web page on another site cannot reach your papers by pointing
its own name at this computer. Writes from another site's page are refused
as well, and so is a request that reaches the server through a reverse proxy
or a tunnel: a trial is not something to put behind a public address. The
CLI and MCP clients still need a token.

Steps 1 to 5, `doctor`, these refusals and the export are checked in a clean
Ubuntu 24.04 container by `tools/try-locally-check.sh`.
