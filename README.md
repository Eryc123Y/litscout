# LitScout

LitScout is a paper feed and research library for one researcher, which you
host yourself. Each day it collects new papers from arXiv and from the
journals and conferences you watch, sorts them into your topics, and puts the
matches first. You read the feed in a web app and keep the papers you care
about in a library. Agent clients such as Claude Code, claude.ai and Codex
reach the same data through a remote MCP server.

You run your own copy. There is no hosted service and no shared account.

**This is a first public test version.** LitScout runs every day for its
author, and the trial and own-server guides have been followed on clean
machines, but few other people have set it up yet. If a step fails or
something is unclear, please
[open an issue](https://github.com/Eryc123Y/litscout-app/issues).

## What it does

- **Daily feed.** LitScout reads the arXiv listing for the categories you
  choose, Hugging Face daily papers, and a watchlist of journals and
  conferences. A missed day is filled in on a later run.
- **Topics and shortlist.** You name your topics and give each one keywords.
  A keyword in a paper's title or abstract tags the paper with that topic and
  puts it on the day's shortlist.
- **Summaries and a morning brief (optional).** A model writes a short summary
  of each paper and a daily brief, with picks per topic and a radar of papers
  close to your projects. The model work runs through an agent CLI you are
  already signed in to (Claude Code, Codex or Antigravity), or through your
  own API key. Without either, LitScout runs in keyword-only mode and shows
  abstracts.
- **Library.** Save any paper by DOI, arXiv ID, URL or title, with or without
  a PDF. LitScout keeps metadata, identifiers and links, not files. You can
  rate, star and annotate papers, import a Zotero export and mirror an
  alphaXiv library.
- **Ideas and vault sync (optional).** If you keep research notes in Obsidian,
  LitScout reads an index of your project, idea and draft notes and shows them
  next to the papers. Ideas you capture and papers you link while reading wait
  in a queue until the next sync writes them into the vault. The vault keeps
  your notes; LitScout keeps the papers.
- **MCP and CLI.** The `/mcp` endpoint lets agent clients read the feed and
  library and save papers and notes. Clients connect with OAuth or a token.
  The `litscout` command-line tool sets LitScout up, runs the daily jobs and
  does maintenance.

The web reader has pages for today's feed, past days, monthly trends, the
library, ideas and working papers. A Health page shows whether each day's run
finished on time. Everything is private by default: the browser signs in
through Cloudflare Access, and the CLI and MCP clients use tokens or OAuth. A
public, read-only feed is opt-in.

LitScout is not a chat app or a research agent. Discussion and writing happen
in your agent client. It does not store PDFs.

## How it fits together

LitScout has two parts.

1. **The server** holds the database and serves the web reader, the JSON API
   (`/api/v1`) and the MCP endpoint (`/mcp`). It is a Cloudflare Worker that
   can run on Cloudflare or on your own Linux server.
2. **The `litscout` CLI** does the daily work on a schedule. It fetches
   papers, asks your agent CLI for summaries and the brief, syncs the vault and
   uploads the results to the server.

The two ways to run LitScout differ in where these parts run.

## Try it first

To see LitScout with your own topics before you set anything up, run all of
it on your own computer: [Try LitScout on your own computer](docs/try-locally.md).
A trial needs Node and pnpm. It has no sign-in and is
reachable from that computer only, so it suits a look around, not daily use
on several devices.

## Choose how to run it

|                    | On Cloudflare                                                                                                    | On your own Linux server                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| The server         | A Cloudflare Worker with a D1 database, on the Workers Free plan                                                 | The same Worker code on workerd, with its data in one folder, run by systemd                                     |
| The daily schedule | Your own computer, through cron or a scheduled task in an agent app. It must be on when a run is due.            | The server, through systemd timers                                                                               |
| You need           | A Cloudflare account. For private browser access, a domain in that account and Cloudflare Zero Trust.            | Linux with systemd, about 1 GB of free memory and 5 GB of disk, and a person who can run a few `sudo` lines once |
| Public address     | A workers.dev address comes with the Worker. The reader uses a custom domain of yours.                           | Yours to add: a Cloudflare Tunnel with Access, or your own reverse proxy with TLS and a login                    |
| Storage            | 500 MB per D1 database and 100,000 rows written a day on the Free plan. Papers older than 45 days are compacted. | A 5 GB cap on the LitScout user's files, including Node and the agent CLIs, with nightly snapshots               |
| Guide              | [Self-hosting LitScout](docs/self-host.md)                                                                       | [Self-hosting on your own server](docs/self-host-server.md)                                                      |

- Choose **Cloudflare** if you do not want to look after a server and you have
  a computer that is on each morning for the run.
- Choose **your own server** if you have a Linux machine that is always on, or
  if you expect more papers than the Free plan's database size and daily writes
  allow. [ADR 0004](docs/adr/0004-own-server-runtime.md) explains this trade.
- To move an existing Cloudflare deployment and its data to a server, use the
  [own-server runbook](docs/runbook/own-server.md).

## What you need

- **To build LitScout:** a clone of this repository, Node 22.13 or later, and
  pnpm at the version in [`package.json`](package.json). On the own-server
  path this can be a separate machine; the server needs no build tools.
- **For summaries and the brief (optional):** an agent CLI signed in on the
  machine that runs the schedule, such as Claude Code, Codex or Antigravity.
  The Cloudflare guide also covers
  [your own API key](docs/self-host.md#use-your-own-api-key-for-the-writing-agent)
  for an OpenAI or Anthropic API.
- **For agent clients (optional):** an MCP client that supports remote HTTP
  servers with OAuth, such as Claude Code, claude.ai or Codex.
- **For vault sync (optional):** an Obsidian vault on the machine that runs
  the sync.
- **Source API keys (optional):** keys for Semantic Scholar, OpenAlex or CORE
  can be added later. The feed works without them.

## First run

Both guides take you through the same first run. This is its outline; your
guide has the exact commands.

1. **Build.** In the repository, run `pnpm install --frozen-lockfile` and
   `pnpm build`.
2. **Write a config.** Run `litscout init` in a private folder outside the
   repository. It writes `litscout.config.ts`, `venues.json` and scheduler
   examples. Set your time zone, the arXiv categories you follow and your
   topics. The starter config is in keyword-only mode:

   ```ts
   instance: { timezone: "UTC", language: "en", publicFeed: false },
   sources: { arxiv: { categories: ["cs.CV", "cs.CL"] } },
   topics: [
     { name: "Computer vision", keywords: ["depth estimation", "3D reconstruction"] },
   ],
   agent: { mode: "none" }, // "client" turns on summaries and the brief
   ```

   List the journals and conferences to watch in `venues.json`. It starts
   empty. The [watchlist format](docs/self-host.md#venue-watchlist) says
   which identifiers each kind of venue takes.

3. **Deploy.** On Cloudflare, `litscout deploy` creates the database and the
   Worker; then you put Cloudflare Access in front of the reader. On a server,
   you install a release, run `litscout server init` and the database
   migration, start the service and give it an HTTPS address.
4. **Create the scheduler token.**
   `litscout token create --name scheduler --scopes read,ingest --save-only`
   stores a token for the daily runs without printing it. Add `vault` to the
   scopes if the schedule will sync a vault.
5. **Fetch the first day by hand.** `$CONFIG` is the path of your
   `litscout.config.ts`.

   ```sh
   litscout daily fetch --config "$CONFIG" --json
   litscout daily status --config "$CONFIG" --json
   ```

   Open `/app/days` at your reader's address, sign in, and pick the listing
   date the fetch reported. Keyword matches lead the list, with their
   abstracts.

6. **Check the setup.** `litscout doctor --config "$CONFIG"` checks the
   config, the server, the token's scopes, the agent clients and the vault. It
   prints a fix for each failed check.

When the first day looks right, continue in your guide:

| Next step                               | On Cloudflare                                                                | On your own server                                                                       |
| --------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Turn on the daily schedule              | [Add a scheduler](docs/self-host.md#8-add-a-scheduler)                       | [Scheduled runs](docs/self-host-server.md#12-scheduled-runs-and-snapshots-administrator) |
| Add summaries and the brief             | [Edit the config](docs/self-host.md#7-edit-the-config-and-update-deployment) | [Agent clients](docs/self-host-server.md#11-agent-clients-optional)                      |
| Connect Claude Code, claude.ai or Codex | [Pair an MCP client](docs/self-host.md#10-pair-an-mcp-client)                | [The same steps](docs/self-host.md#10-pair-an-mcp-client), with your server's address    |
| Sync an Obsidian vault                  | [Obsidian vault sync](docs/self-host.md#obsidian-vault-sync)                 | [The same reference](docs/self-host.md#obsidian-vault-sync)                              |

## Documentation

| Read                                                        | For                                                                                  |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [Try LitScout on your own computer](docs/try-locally.md)    | A trial on one computer, with no account, domain or server                           |
| [Self-hosting LitScout](docs/self-host.md)                  | Setup on Cloudflare, MCP pairing and tools, vault sync, backups and Free plan limits |
| [Self-hosting on your own server](docs/self-host-server.md) | Setup on a Linux server                                                              |
| [Own-server runbook](docs/runbook/own-server.md)            | Server layout, updates, storage limits and moving from Cloudflare                    |
| [Using LitScout](docs/guide/using-litscout.md)              | The pages, a reading day, Zotero import and asking an agent client for help          |
| [Daily runbook](docs/runbook/daily.md)                      | The daily commands in order and what to do when a run fails                          |
| [Decisions](docs/adr/)                                      | Why LitScout is built this way                                                       |
| [Development](docs/development.md)                          | Working on the code                                                                  |

## Development

LitScout is a TypeScript pnpm workspace.

| Path                  | What it holds                                                                |
| --------------------- | ---------------------------------------------------------------------------- |
| `apps/worker`         | The Worker: web assets, JSON API, MCP endpoint with OAuth, sign-in checks    |
| `apps/web`            | The React web reader                                                         |
| `apps/cli`            | The `litscout` CLI: setup, deployment, daily runs, sync and maintenance      |
| `apps/server`         | The own-server runtime, release bundle, systemd units and operations scripts |
| `packages/core`       | Paper types, identifiers, merging and the config schema                      |
| `packages/sources`    | Paper source clients and the venue watch                                     |
| `packages/db`         | Database schema, migrations and repositories                                 |
| `packages/pipeline`   | Daily pipeline steps, the agent chain and command contracts                  |
| `packages/sync`       | Vault sync, the alphaXiv mirror and legacy import                            |
| `packages/mcp`        | MCP tool definitions                                                         |
| `packages/i18n`       | Report strings in English and Chinese                                        |
| `templates/self-host` | The starter config and scheduler examples that `litscout init` copies        |

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm web:local
nice -n 10 pnpm verify
```

`pnpm web:local` serves the reader with fixture data at
`http://127.0.0.1:4173`, with no credentials and no outbound network.
`pnpm verify` is the merge gate: every change passes it locally before it
merges. It runs the dependency audit, type checks, lint, tests with coverage
gates, the build, browser tests, formatting, the repository audit, smoke
tests and an offline rehearsal of the daily run.
[Development](docs/development.md) has the details.

## Licence

LitScout is free software under the GNU Affero General Public License,
version 3 or (at your option) any later version (AGPL-3.0-or-later). If you
run a modified copy for others over a network, you must offer them its source.
The full text is in [LICENSE](LICENSE).
