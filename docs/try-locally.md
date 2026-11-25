# Try LitScout on your own computer

A trial runs all of LitScout on one computer: the server, the web reader and
the `litscout` CLI. It needs no Cloudflare account, no domain and no server.
Use it to see whether LitScout suits you. For daily use, move to one of the
two deployments in the [README](../README.md#choose-how-to-run-it); an export
takes your library with you (step 8).

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

## 2. Answer a few questions

Keep the config in a private folder outside the repository.

```sh
mkdir -p ~/litscout/etc
cd ~/litscout/etc
litscout init
```

`init` asks a few questions. Press Enter to take the suggestion in
brackets.

- **How you will run LitScout.** Choose 1, a trial on this computer.
- **Time zone.** It suggests the one this computer is set to.
- **Language** for summaries and the morning brief: English or Chinese.
- **arXiv categories.** Pick numbers from a list of common ones, or type any
  arXiv code, such as `cs.CV` or `q-bio.NC`.
- **Topics.** Name each topic and give a few keywords or phrases. A keyword
  in a paper's title or abstract puts the paper under that topic and on the
  day's shortlist.
- **Summaries.** If Claude Code, Codex or Antigravity is installed and
  signed in, `init` offers to write summaries and a morning brief with it.
  Otherwise LitScout runs in keyword mode, with the papers' abstracts.
- **Journals and conferences** to watch beside arXiv, chosen by area. You
  can skip this.

`init` then writes `litscout.config.ts` and `venues.json` in this folder
from your answers, with scheduler examples beside them. For a trial it also
prepares the server: the `~/litscout` folders, `etc/server.json` (the
server's settings), `etc/secrets.env` (a new management token) and
`~/.config/litscout/state.json` (the same token, for the CLI). It ends by
printing the next commands.

Everything it wrote can be changed later: see
[Change your setup](#change-your-setup). To edit a starter config by hand
instead of answering questions, run `litscout init --defaults`.

If `~/.config/litscout/state.json` already belongs to another LitScout
instance, `init` says so and leaves the server's settings unwritten. Move
that file aside, then run `litscout server init --local`.

## 3. Start LitScout

```sh
node "$REPO/apps/cli/dist/server.js" serve --config ~/litscout/etc/server.json
```

On a trial, `serve` creates or updates the database first, then prints the
address and keeps running. Leave it in this terminal and stop it with Ctrl-C.
Do the next steps in a second terminal.

Open <http://127.0.0.1:8787/app> now: until the first fetch, the reader
shows a welcome page with your topics and the commands for the next step.

## 4. Fetch the first day

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

## 5. Fetch every day

Run `litscout daily fetch --json` from `~/litscout/etc` each morning, or let
cron do it: `cron.md` in the same folder has an entry to copy. The server
from step 3 must be running when the fetch runs. A missed day is filled in
by a later fetch.

## 6. Summaries and the morning brief (optional)

A model can write a short summary of each paper and a daily brief with picks
per topic. The model work runs through an agent CLI you are signed in to on
this computer, such as Claude Code or Codex.

If you said yes to summaries in `init`, the config is already set. To turn
them on later:

1. In `litscout.config.ts`, set `agent.mode: "client"` and choose the client
   under `agent.summaries` and `agent.digest`. The Cloudflare guide's
   [config step](self-host.md#7-edit-the-config-and-update-deployment)
   describes these fields.
2. Apply the change as in [Change your setup](#change-your-setup).

After each fetch, run the summary and digest steps of the
[daily runbook](runbook/daily.md#self-host-runs).

## 7. Connect an agent client (optional)

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

## 8. Update, move on or remove

**Update.** Stop the server, then:

```sh
cd "$REPO"
git pull
pnpm install --frozen-lockfile
pnpm build
```

Start the server again as in step 3; it updates the database itself.

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

## Change your setup

Your topics, categories, language and agent settings are in
`~/litscout/etc/litscout.config.ts`, and the journals and conferences in
`venues.json` beside it. Edit them, then apply the change and restart the
server:

```sh
cd ~/litscout/etc
litscout server init --local --force
```

Stop the server with Ctrl-C and start it again as in step 3. The next fetch
uses the new categories, topics and venues. `--force` keeps the token and
the data; it rewrites only the server's settings.

A trial needs no keys. To add an OpenAlex or Semantic Scholar key, or an
OpenReview login for venues such as ICLR, see
[Paper sources and their keys](sources.md#in-a-trial-on-your-own-computer).

## How a trial stays private

The server listens on `127.0.0.1`, which other machines cannot reach, and
`server.js` refuses to start a trial on any other address. It also refuses a
request that names the computer by anything but `127.0.0.1`, `localhost` or
`[::1]`, so a web page on another site cannot reach your papers by pointing
its own name at this computer. Writes from another site's page are refused
as well, and so is a request that reaches the server through a reverse proxy
or a tunnel: a trial is not something to put behind a public address. The
CLI and MCP clients still need a token.

Steps 1 to 4, with typed answers to `init`, then `doctor`, these refusals
and the export are checked in a clean Ubuntu 24.04 container by
`tools/try-locally-check.sh`.
