# Self-hosting LitScout

Set up a private paper feed, read it in your browser, and connect an MCP client
to the same Cloudflare Worker. The starter config runs in keyword-only mode.
It fetches papers, puts keyword matches first and shows abstracts without
requiring a model subscription.

To run LitScout on your own Linux server instead, without a Cloudflare
Worker or D1, follow [Self-hosting on your own server](self-host-server.md).
To move an existing Cloudflare deployment there, use the
[own-server runbook](runbook/own-server.md).

## 1. Requirements

- A Cloudflare account with Workers, D1 and KV enabled on the Free plan. For
  private browser access, use a domain on a DNS zone in that account and enable
  Cloudflare Zero Trust.
- Node 22.13 or later and pnpm. Use the pnpm version in `package.json`.
- A checkout you can build. Keep it at a stable path if you will schedule runs.
- For optional summaries and digests, install Claude Code, Codex, Antigravity,
  or another supported CLI and configure it under `agent`.
- To pair a client, use one that supports remote HTTP servers and OAuth. The
  paper feed also works on its own.

## 2. Create your configuration

From the repository, install dependencies and build the CLI, Worker, and web
assets. Keep the generated configuration in a private folder outside the
checkout. The commands below assume a POSIX shell.

```sh
pnpm install --frozen-lockfile
pnpm build
REPO="$PWD"
SETUP="$HOME/litscout-setup"
mkdir -p "$SETUP"
export PATH="$REPO/node_modules/.bin:$PATH"
cd "$SETUP"
litscout init
CONFIG="$SETUP/litscout.config.ts"
cd "$REPO"
```

Vault sync is optional. Create or select a vault when you set up Obsidian
sync. Reuse the same `CONFIG` path throughout setup and scheduling.
`init` refuses to overwrite existing starter files.

## 3. Sign in to Wrangler

```sh
pnpm exec wrangler login
pnpm exec wrangler whoami
```

Complete authorization in the browser and check that Wrangler lists the
intended account. If it lists multiple accounts, set
`CLOUDFLARE_ACCOUNT_ID` to the target account's ID before deployment. In the
Workers dashboard, choose a workers.dev subdomain for the account if
Cloudflare asks you to set one up.

## 4. Deploy the Worker

Preview, then apply. Use the same Worker name and config on subsequent deploys.
`--skip-keys` is enough to get the feed and MCP running. Optional source API
keys may be added later.

```sh
litscout deploy --config "$CONFIG" --skip-keys --dry-run
litscout deploy --config "$CONFIG" --skip-keys
```

The preview uses Wrangler to read the pending D1 migrations, their estimated
writes and the remaining daily write budget. It leaves Cloudflare and local
deployment files unchanged. Deployment finds or creates the D1 database and
OAuth KV namespace, charges the migrations to the daily budget, uploads Worker
secrets, and deploys the Worker and web assets. It records the resulting
workers.dev URL locally. Save
that HTTPS origin from the output, excluding the trailing `/mcp`. Local
deployment state and tokens live under `~/.config/litscout`. Run subsequent
commands as the same operating-system user.

If the estimate exceeds the available writes, retry just after the displayed
00:00 UTC reset. Table rebuilds need room for the entire copy in one
transaction. For large rebuilds, deploy shows how many days of writes the copy
represents at the current headroom. When the rebuild exceeds a full day's
allowance, successive resets leave the same problem. Arrange enough Cloudflare
quota for the whole copy before using `--allow-over-budget`. That flag
overrides LitScout's 80,000-write cap. Cloudflare's own quota still applies.
`litscout budget` shows the migration charge within the day's usage.

## 5. Set up browser access for one email

1. In **Workers & Pages**, open your Worker. Under **Settings → Domains &
   Routes**, add a **Custom Domain**, such as `reader.example.com`. Keep the
   workers.dev route enabled.
2. In the **Zero Trust** dashboard, enable **One-time PIN** under the
   authentication settings if needed. Open **Access → Applications**, choose
   **Add an application → Self-hosted**, and add public hostname entries for
   `HOST/app` and `HOST/api/v1`, replacing `HOST` with the custom domain.
3. Add an **Allow** policy. Under **Include**, choose **Emails** and enter the
   one email address you intend to use. Enable One-time PIN for the app.
   Save the app and copy its **Application Audience (AUD) Tag**. Also note
   your team domain from the Zero Trust dashboard, in the form
   `YOUR-TEAM.cloudflareaccess.com`.
4. Add a second **Self-hosted** app on the same hostname with the more
   specific paths `HOST/api/v1/public` and `HOST/api/v1/instance`. Give it a
   **Bypass** policy with **Include → Everyone**. This keeps the instance
   endpoint and any enabled public feed reachable without an Access login.
5. Keep the Access apps on the custom domain. Use workers.dev for the CLI and
   MCP OAuth. The next config edit and redeploy connect the Worker to the
   private app's AUD.

## 6. Create the scheduler token

Use `read,ingest,vault` if the scheduler runs `sync`, as shown below.
For a schedule without vault sync, pass `--scopes read,ingest` instead.

```sh
litscout token create --config "$CONFIG" --name scheduler --scopes read,ingest,vault --save-only --dry-run
litscout token create --config "$CONFIG" --name scheduler --scopes read,ingest,vault --save-only
```

The token is saved in a private local file, and the scheduler on this machine
uses it automatically. With `--save-only` the command prints only the token's
ID and where it was saved, so the token never reaches a terminal log or an
agent's transcript. Without it the token is printed once, for a client on
another machine. Keep that output out of logs and chat.
The `read` scope reads the feed, `ingest` uploads crawl results, and `vault`
allows the CLI to sync the vault index and work through queued requests.
A separate `write` scope is needed for CLI library edits and captures.

Existing ingest tokens retain vault access during the upgrade. After deploying
the update, create a replacement with the scopes above, run
`litscout doctor --config "$CONFIG"`, then revoke the old token by ID. Doctor
warns if the current token still has legacy vault access.

## 7. Edit the config and update deployment

Open `"$CONFIG"` in your editor.

- Set `instance.webUrl` to the HTTPS custom browser origin. The recorded
  `workers.dev` origin is the default for `instance.publicUrl`. If you set it
  explicitly, use the very same origin so the scheduler finds its token.
- Set `access.teamDomain` to your team hostname without `https://` and
  `access.aud` to the **private** Access app's AUD.
- Set `instance.timezone` and `instance.language` (`en` or `zh`). Leave
  `instance.publicFeed` false for a private feed. Setting it true publishes
  the paper feed and topic names.
- Choose `sources.arxiv.categories` and edit `topics` with your topic names
  and keywords. A title or abstract match puts a paper on the shortlist. Edit
  `venues.json` to change the venue watchlist.
- Leave `agent.mode: "none"` for keyword-only mode. To generate summaries and
  digest text, set it to `"client"`. Choose installed clients or [API mode](#use-your-own-api-key-for-the-writing-agent)
  under `agent.summaries` and `agent.digest`. Use `fallback: []` on each if you
  have one client. The digest agent's context comes from vault notes
  (`vault.projects`, `vault.ideaTag`, `vault.briefs`) and `digest.briefFiles`;
  `research.contextBodies` decides whether note bodies are sent, and
  `vault.exclude` keeps notes out of every vault read.
- To use vault sync, configure `vault.root` and the destination folders. Keep
  `vault.write: false` while reviewing the setup. See the
  [vault reference](#obsidian-vault-sync).

```sh
litscout deploy --config "$CONFIG" --skip-keys --dry-run
litscout deploy --config "$CONFIG" --skip-keys
```

Deploy again when you change the browser-visible settings, Access values or
agent mode. Keep using the same config path.

### Use your own API key for the writing agent

Local clients such as Claude Code and Codex use the scheduler account's
existing CLI sign-in. API mode works without these clients and charges
requests to your own account with the selected API provider. To opt in, add
`agent.api` and select `"api"` as the client for either step, or put it in
that step's `fallback` list to try local clients first.

```ts
agent: {
  mode: "client",
  summaries: { client: "api", fallback: [] },
  digest: { client: "api", fallback: [] },
  api: {
    provider: "openai",
    model: "gpt-4.1-mini",
    keyEnv: "OPENAI_API_KEY",
    maxRequestsPerDay: 40,
    maxTokensPerDay: 300_000,
    maxRequestsPerRun: 20,
    maxTokensPerRun: 150_000,
  },
},
```

- Choose `provider: "anthropic"` for Anthropic Messages, which defaults to
  `claude-haiku-4-5`. The default for `"openai"` is `gpt-4.1-mini`. For an
  OpenAI-compatible service, set `baseUrl` to its HTTPS API base
  (for example, `https://gateway.example/v1`), add its exact hostname to
  `trustedHosts: ["gateway.example"]`, and set its model and key variable.
  Custom hosts must resolve only to public addresses.
- Set the variable named by `keyEnv` in the environment of the local CLI
  process or scheduler, using your scheduler's secret mechanism. Put only the
  variable name in the config. It must end in `_API_KEY` or `_KEY`.
  Names beginning with `LITSCOUT_`, `CLOUDFLARE_`, `CF_`, `AWS_`,
  `GITHUB_`, `GH_`, `GOOGLE_`, `AZURE_` or `NPM_` are reserved.
  The provider receives the prompt, including the paper text and any configured
  digest context.
- Both daily caps are required and apply to all API requests using the local
  CLI cache under `~/.cache/litscout`. They reset at midnight UTC.
  Deleting the cache directory also resets the daily tally. Optional
  per-run caps apply to each command and default to the daily values. HTTP
  retries and the JSON repair each count as requests. LitScout reserves
  estimated input tokens plus the maximum output before sending, then uses the
  provider's reported tokens when available. An attempt with unknown usage
  keeps its reservation. Custom endpoints must report `usage` for exact
  accounting. If it is missing or invalid, LitScout warns and charges the
  full token reservation. Spending limits depend on the custom provider
  honouring `max_tokens`. If another call would exceed a cap, the step reports
  `budget-short`. Keep the cache for scheduled runs and configure a spending
  limit with the provider if you share an account across machines.

```sh
litscout summaries run --dry-run --config "$CONFIG"
litscout digest run --dry-run --config "$CONFIG"
litscout doctor --config "$CONFIG"
```

Dry runs show the configured API hostname, read the feed from your Worker
and estimate each initial API call and the total. They use prompt size and
the output limit for each call, and make no agent calls or feed writes. If API
is a fallback, the estimate assumes it handles all planned calls. Without the
API in its chain, `digest run --dry-run` instead runs the configured clients
on the real prompt, checks the draft as a real run does, and prints its counts
without writing anything, even for a day that already has a digest. It spends
those clients' quota. Add
`agent.api.prices: { inputPerToken: ..., outputPerToken: ... }` with your
provider's USD prices per token to estimate cost. Your bill depends on
actual token usage and any retries or repair calls.

By default, doctor shows the API hostname and checks whether the
scheduler has the key variable. `litscout doctor --live --config "$CONFIG"`
sends one small, potentially billable request when API is in an active
client chain and the caps allow it.

## 8. Add a scheduler

Pick one of the examples that `init` copied into your setup folder. Replace all
placeholder paths and choose a time after the arXiv announcement you want to
catch. Use the same operating-system account, Node, pnpm and config as in setup.
Leave the schedule paused while you try the first manual run.

| Example                    | Setup                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------- |
| `cron.md`                  | For keyword-only mode. Copy the entry into your user crontab and create the log folder. |
| `antigravity-sidecar.json` | For an Antigravity cron sidecar. Use an absolute repo URI and create the run directory. |
| `claude-scheduled-task.md` | Create a local scheduled task in Claude Code with the example directory and prompt.     |
| `codex-exec.md`            | Use the example Codex command as a scheduled job.                                       |

For scheduled agents, create `~/.cache/litscout/run` with mode 700 and follow
the [daily runbook's self-host instructions](runbook/daily.md#self-host-runs).
The scheduler runs the CLI with its local credential and needs access to the
paper sources and the Worker.

## 9. Run the first crawl by hand

```sh
litscout daily fetch --config "$CONFIG" --json
litscout daily status --config "$CONFIG" --json
```

Open `https://HOST/app/days` on the custom domain. Sign in with the allowed
email and its one-time PIN. Select the arXiv listing date reported by the
crawl. In keyword-only mode, keyword matches lead the list and entries show
their abstracts. `summaries`, `digest` and `weekly` report
`skipped-no-llm`; the scheduler can stop after the crawl.

If the next announcement is pending, look for the latest available listing
in the crawl result or the Days page. To request a known recent listing
explicitly, replace the example date below with its actual date from arXiv.

```sh
litscout daily fetch --config "$CONFIG" --day 2026-11-16 --json
```

For agent mode, continue with the summaries and digest steps in the daily
runbook. Enable the scheduler after confirming your manual run works.

## 10. Pair an MCP client

Set the URL to the HTTPS endpoint on your Worker origin. Use the same
`/mcp` URL with each client.

```sh
export LITSCOUT_MCP_URL='https://WORKER.workers.dev/mcp'
```

For OAuth, run the following once per connector. Enter the one-time code on
LitScout's consent page and approve the requested access. The code expires
after ten minutes. See [scope choices](#pairing-mcp-clients-for-library-writes).

```sh
litscout pair
```

### Claude Code

For OAuth, register the HTTP server, then select **Authenticate** for
`litscout` in Claude Code's `/mcp` menu and complete consent.

```sh
claude mcp add --transport http litscout "$LITSCOUT_MCP_URL"
```

For bearer authentication, create a dedicated read token and export it as
`LITSCOUT_TOKEN` from your shell or secret manager. Claude Code stores the
supplied header in its local MCP configuration. Use `--scopes read,write`
when the client also needs write tools.

```sh
litscout token create --config "$CONFIG" --name claude-code --scopes read
claude mcp add --transport http litscout-token "$LITSCOUT_MCP_URL" \
  --header "Authorization: Bearer $LITSCOUT_TOKEN"
```

### claude.ai

In **Settings → Connectors**, add a custom connector named **LitScout** and
paste the `https://WORKER.workers.dev/mcp` URL. Select **Connect** to start
OAuth. LitScout supplies discovery metadata and supports dynamic client
registration. Enter the pairing code on the consent page. Enable the
connector in the chat's tools menu.

### Codex

Register the streamable HTTP server and complete OAuth when prompted.
If the server is registered and still needs authorization, run
`codex mcp login litscout`.

```sh
codex mcp add litscout --url "$LITSCOUT_MCP_URL"
```

For bearer authentication, create a dedicated token and make
`LITSCOUT_TOKEN` available in the environment where Codex runs.

```sh
litscout token create --config "$CONFIG" --name codex --scopes read
codex mcp add litscout-token --url "$LITSCOUT_MCP_URL" \
  --bearer-token-env-var LITSCOUT_TOKEN
```

### Tools and example arguments

With read access, verify the connection by calling `lookup_paper` or call
`get_paper` with an arXiv ID from your feed to verify private library access.
For a write-only connection, use the `save_paper` preview with an arXiv ID
from your feed. In the write examples, replace
`pap_EXAMPLE` with a LitScout paper ID from `get_paper` or `search_library`.
Replace `IDEA_ID`, `DRAFT_ID` and `SUGGESTION_ID` with IDs from the corresponding
`list_*` tools.

**Public paper lookup** (`read`)

| Tool           | Use                        | Example arguments      |
| -------------- | -------------------------- | ---------------------- |
| `lookup_paper` | Look up public paper data. | `{"ids":"1706.03762"}` |

**Library read** (`read`)

| Tool             | Use                                              | Example arguments                      |
| ---------------- | ------------------------------------------------ | -------------------------------------- |
| `search_library` | Search saved and alphaXiv papers.                | `{"q":"transformer"}`                  |
| `get_trends`     | Read private monthly topic trends.               | `{"topic":"Vision","month":"2026-11"}` |
| `get_paper`      | Read a record, its summary and notes.            | `{"ids":"1706.03762"}`                 |
| `list_notes`     | List a paper's quick notes with their revisions. | `{"target":"pap_EXAMPLE"}`             |

**Daily reading** (`read`)

| Tool         | Use                                                                                                                     | Example arguments                       |
| ------------ | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `list_days`  | List reading days with their status and counts, and mark behind days.                                                   | `{"limit":7}`                           |
| `get_day`    | Read a day's morning brief, counts and a page of papers, or its triage queue (`queue`). Filter by `code` or `decision`. | `{"day":"2026-11-19","topic":"Vision"}` |
| `get_status` | Check the write budget, recent runs, behind days and vault sync.                                                        | `{"days":3}`                            |

**Library write** (`write`)

| Tool                  | Use                                                                               | Example arguments                                                  |
| --------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `save_paper`          | Save a paper. Use `dry_run` to preview; `status` `to_read` queues it for reading. | `{"query":"1706.03762","dry_run":true}`                            |
| `add_note`            | Add a Markdown note to a paper.                                                   | `{"target":"pap_EXAMPLE","bodyMd":"Review section 3."}`            |
| `mark_paper`          | Mark read, star, unstar, skip, unskip, or set a rating.                           | `{"paperId":"pap_EXAMPLE","action":"rate","rating":"up"}`          |
| `update_library_item` | Change a saved paper's status or tags (with its rev).                             | `{"paperId":"pap_EXAMPLE","if_rev":3,"status":"reading"}`          |
| `remove_from_library` | Remove a paper from the library (with its rev).                                   | `{"paperId":"pap_EXAMPLE","if_rev":4}`                             |
| `edit_note`           | Replace a quick note's text (with its rev).                                       | `{"id":"note_EXAMPLE","if_rev":1,"bodyMd":"Read section 4 next."}` |
| `delete_note`         | Delete a quick note (with its rev).                                               | `{"id":"note_EXAMPLE","if_rev":2}`                                 |

Set `mcp.researchTools: true` in the instance config and redeploy to add the
tools below. The setting defaults off.

**Public research** (`read`)

| Tool           | Use                                            | Example arguments                                        |
| -------------- | ---------------------------------------------- | -------------------------------------------------------- |
| `search`       | Search publications by keyword.                | `{"query":"stereo depth estimation","limit":5}`          |
| `paper_links`  | Find citations, references or recommendations. | `{"id":"1706.03762","direction":"references"}`           |
| `get_author`   | Look up an author and optionally their papers. | `{"name_or_id":"Ashish Vaswani","include_papers":true}`  |
| `coauthorship` | Find papers shared by two to six authors.      | `{"authors":["Ashish Vaswani","Noam Shazeer"]}`          |
| `reviews`      | Find public OpenReview reviews.                | `{"query":"https://openreview.net/forum?id=YicbFdNTTy"}` |
| `venue`        | Look up a venue's rankings.                    | `{"query":"CVPR"}`                                       |

**Private research read** (`read`)

| Tool                  | Use                                          | Example arguments    |
| --------------------- | -------------------------------------------- | -------------------- |
| `research_context`    | List projects, ideas, papers and radar hits. | `{}`                 |
| `list_ideas`          | List indexed ideas and their paths.          | `{}`                 |
| `get_idea`            | Read an indexed idea.                        | `{"id":"IDEA_ID"}`   |
| `get_note`            | Read a project, idea or draft note's body.   | `{"id":"IDEA_ID"}`   |
| `list_suggestions`    | List private digest suggestions.             | `{"status":"new"}`   |
| `list_working_papers` | List indexed working papers.                 | `{}`                 |
| `get_working_paper`   | Read a draft's index and reading list.       | `{"id":"DRAFT_ID"}`  |
| `list_vault_requests` | List requests queued for the vault.          | `{"kind":"capture"}` |

**Private research write** (`write`)

| Tool                   | Use                                                                                  | Example arguments                                     |
| ---------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `capture_idea`         | Queue an idea for the vault Inbox.                                                   | `{"title":"Compare stereo baselines"}`                |
| `request_link`         | Queue a paper link for an indexed idea.                                              | `{"targetNoteId":"IDEA_ID","paperId":"pap_EXAMPLE"}`  |
| `resolve_suggestion`   | Accept or dismiss a private digest suggestion.                                       | `{"id":"SUGGESTION_ID","action":"accept"}`            |
| `set_idea_status`      | Queue a new status (seed, exploring, in-paper, parked, dropped) for an indexed idea. | `{"targetNoteId":"IDEA_ID","status":"exploring"}`     |
| `add_reading`          | Queue a paper for a working paper's reading list.                                    | `{"targetNoteId":"DRAFT_ID","paperId":"pap_EXAMPLE"}` |
| `make_paper_note`      | Queue a vault note for a paper.                                                      | `{"paperId":"pap_EXAMPLE","topic":"Vision"}`          |
| `cancel_vault_request` | Cancel a queued request before vault sync applies it.                                | `{"id":"REQUEST_ID"}`                                 |

## 11. Troubleshoot with doctor

```sh
litscout doctor --config "$CONFIG"
litscout doctor --config "$CONFIG" --json
```

Run it as the scheduler's user. Review the fix hint on each failed check. It
checks the config, Node, Wrangler login, Worker reachability and schema,
bindings, Access settings, scheduler token scopes, configured agent clients
and the vault directory. Use the authenticated health check through doctor
to see the expected and installed D1 schema versions. `doctor` checks the
local Access configuration. Verify the login policy itself in a private
browser window on the custom domain.

- **Access loops or private API requests return 401.** Check that the Allow
  app covers both private paths and that the Worker was redeployed with its
  AUD. Before signing in, visit `https://HOST/app/` in a private window and
  confirm the Access login appears.
- **The CLI or MCP opens an Access login.** Confirm the configured workers.dev
  origin has no Access app and use the `/mcp` connector address returned by
  pairing.
- **Token scope check fails.** Create a token with `read,ingest,vault` if the
  scheduler runs vault sync, or `read,ingest` otherwise. Rerun doctor using
  the same config and operating-system user.
- **Missing abstracts or an empty day.** Check the listing date and the crawl
  warnings. Abstracts appear as sources make them available.
- **Agent authentication fails.** Sign in from the scheduler's account or use
  keyword-only mode.

### Rehearse the daily runbook locally

From the repository root with dependencies installed, run
`nice -n 10 node --import tsx tools/rehearsal.mjs`. It builds the CLI and
starts a local Worker with a fresh database, fixture sources, and stub agents.
The rehearsal checks scheduled run reports in Health and verifies a backup
export.
It needs Node 22.13 or later, Git, and OpenSSL. Read
`.artifacts/rehearsal.json` for command results and timings. `pnpm verify`
includes it.

### Checks before merging

Run the merge gate locally before merging a change.

```sh
nice -n 10 pnpm verify
```

It runs the dependency audit, `pnpm check` (typecheck, lint, unit tests with
coverage gates, build, Playwright, formatting and the repository audit), the
Worker and CLI bundle smoke tests, and the offline rehearsal. The GitHub
workflow runs the same command on every pull request and on pushes to
`main`.
[Scripts](../package.json) · [Workflow](../.github/workflows/ci.yml)

## Access layout for browser, CLI and MCP

| Application       | Paths                                        | Policy                  |
| ----------------- | -------------------------------------------- | ----------------------- |
| Private browser   | `HOST/app`, `HOST/api/v1`                    | Allow one email via PIN |
| Public exceptions | `HOST/api/v1/public`, `HOST/api/v1/instance` | Bypass for Everyone     |

Access injects `Cf-Access-Jwt-Assertion` on protected routes. Protect the
private API paths as well as the app so browser API calls receive the
assertion. The more specific public exceptions take priority. LitScout's
Worker still controls which data the public routes serve. The public feed
routes are disabled by default.

The CLI uses an `lsk_` bearer token on the workers.dev origin. MCP supports a
scoped `lsk_` token or an OAuth grant on that origin. Keep `instance.webUrl` on the browser host.
When it is omitted, digest links can use `instance.publicUrl` or the recorded
deployment URL if it is a plain HTTPS origin. Links target `/app/days/…` for
private feeds and `/public/days/…` for public feeds.

## Health and exports

Open **Health** in the private reader for the last 30 completed local days.
The page compares the first saved daily digest for each arXiv reading day to
`schedule.onTimeBy` (11:30 by default, in `instance.timezone`). It also shows
run reports, the write budget, storage, unchecked links and the last completed
alphaXiv mirror. The write budget resets at 00:00 UTC. The migration for run
reports is `0015_daily_runs.sql`. Apply `0016_backup_export.sql` for the covering
identifier index (schema version 15).

In **Settings**, choose **Download export bundle**. You can cancel while the
browser is reading and compressing the data. From the CLI, use a token with
`write` scope. Each token and the signed-in Settings page can start an export
once every 10 minutes. The CLI and Settings show the remaining wait.

```sh
litscout backup --out research.json.gz --config "$CONFIG"
litscout backup --verify research.json.gz
```

Without `--out`, the CLI writes a timestamped file in the current directory.
Use `--json` for machine-readable results. Offline verification needs only the
export file. It checks section counts, the SHA-256 checksum, unique record keys
and paper references. It prints the bundle version, counts at export start and
counts in the file. A difference between those two sets of counts produces a
“changed during export” warning. Exports include a compact record when a
personal reference points to an archived paper. Use a D1 snapshot for full
database recovery, including feed history.

### Restore an export

The `backup restore` command loads a verified export into a new, empty instance,
for example on a new account or after the database was deleted. Deploy the
instance first, then use a token with `write` scope.

```sh
litscout backup restore research.json.gz --dry-run --config "$CONFIG"
litscout backup restore research.json.gz --keep-rows 2000 --config "$CONFIG"
```

The command verifies the file offline first, as `--verify` does. It refuses an
instance that already holds personal rows: the library, alphaXiv mirror,
paper state, quick notes, digests, projects, vault index, captures, requests
and suggestions. Topics and crawled papers do not count. The dry run lists the
rows per section, the pages, the most rows the restore can write, and today's
balance.

Each page reserves its rows against the daily write budget before it writes.
A restore larger than the day's budget pauses and saves its place under the
CLI state directory. Run the same command after the 00:00 UTC reset to
continue. `--keep-rows N` leaves N rows of today's balance for other work, and
`--max-rows N` sets a fixed cap.

Restored rows keep their keys, revisions and timestamps. The restore never
replaces a row, so a rerun inserts nothing and counts every row as skipped. A
row whose paper or vault note is missing is skipped and counted. A project or
request link to a missing note is cleared. Feed history and summaries are not
in the export. The daily crawl fills new days, and the next vault sync
refreshes the vault index.

The bundle contains private research data, including quick notes, captures and
the synced vault index. It omits instance credentials, tokens, OAuth grants
and Access configuration. Keep it with your private backups. The export reads
successive pages, so concurrent edits can appear in some pages and not others.
Configured topics carry their display names. Keyword lists in the local config
stay on the Mac.
Keep a separate backup of the Obsidian files themselves.

## Import a legacy feed

Set `LEGACY_REPO` to the legacy checkout and `LEGACY_FROM` and `LEGACY_TO`
to the approved date window. Preview locally with
`litscout legacy import --repo "$LEGACY_REPO" --from "$LEGACY_FROM" --to "$LEGACY_TO" --dry-run --json`.
The preview lists per-day counts and estimated rows from the source.
To apply, replace `--dry-run` with `--keep-rows N` to leave N rows of the
day's live balance for later work, or `--max-rows N` for a fixed cap (with
both, the smaller wins). The importer checks whether each whole date
or linked group fits and reports what completed and when the remaining dates
could finish. Use the same source and date window when resuming.

For a scheduled run, put the approved window in the config so the run needs no
arguments, then run `litscout legacy import --keep-rows 2000` (see the daily
runbook, step 10):

```ts
legacy: {
  repo: "/path/to/legacy-checkout",
  from: "2026-10-30",
  to: "2026-11-16",
  // dir: "/path/to/old/digest-folder", // optional private reports
},
```

Relative paths in the block are read from the config file's folder. Explicit
`--repo` and date arguments override the block; `--dir` alone does not (set
`legacy.dir` instead). When the configured window has finished, the command
answers `alreadyDone` without reading the source again. An explicit window
imports again whenever you run it.
`litscout doctor` reports the window and whether it is done under
`checks.legacy`, and fails when the configured folders are not readable.
[CLI options](../apps/cli/src/legacy-command.ts) · [Preview output](../packages/sync/src/legacy.ts) · [Budgeted importer](../packages/sync/src/legacy-budgeted.ts) · [Daily runbook](runbook/daily.md#command-order)

## Paper retention

The daily Mac runbook runs `litscout prune` after the digest and other scheduled
writes. The Worker handles up to ten papers per request. The default Worker
Cron records its invocation and expires run reports. Local CPU measurements
put paper pruning in separate requests from the Mac. [Prune command](../apps/cli/src/prune-command.ts) · [Scheduled handler](../apps/worker/src/app.ts)

```ts
storage: {
  fullDays: 45,
  prune: true,
  pruneRowsPerDay: 30_000,
  compactMonths: 12,
}
```

These are the storage defaults. Set `prune: false` in the scheduler and
deployment configs to turn the job off. The window uses the instance timezone
and the latest day each paper appeared in the feed. The job preserves library
and alphaXiv papers, reading activity,
digest picks and radar records, and papers referenced in research. Archived
papers keep their titles, available arXiv ID and DOI, topics, venue and feed
occurrences. [Storage defaults](../packages/core/src/config.ts)

After compacting, `prune` removes archived papers and their feed occurrences
once their last listing is `compactMonths` (12) months old, oldest first. It
keeps the archived papers that something still points at: digest picks,
suggestions, ideas and working papers, idea links, notes, captures, queued
vault requests and paper notes in the vault. It charges the same daily cap.
`prune --over-cap`, which an own server's final run calls when the server is
above its 5 GB cap, removes the oldest week of archived papers earlier, but
never papers inside the `fullDays` window. [Expiry](../packages/db/src/compact-expiry.ts) · [Horizon](../apps/worker/src/compact-expiry.ts)

Before the first run, apply migrations through `0026_compact_expiry.sql`. Check
their estimates with `litscout deploy --dry-run`. Migration `0023_retention.sql` rebuilds the feed-occurrence table to
preserve that history when a full paper is deleted. The estimate grows with
the number of stored feed occurrences and indexed references.

`litscout prune --dry-run --json` reports overlapping kept reasons, a sample of
up to ten titles and the estimated number waiting for budget without pruning.
Its `expiry` field lists what would expire: the horizon, the count, the oldest
listing day and up to ten titles.
The cap and the 41,000-row reserve for daily work use the same UTC clock as the write
ledger. Health reports the last run and `litscout doctor` shows the prunable
count and database bytes against the 500 MB limit. [Prune command](../apps/cli/src/prune-command.ts) · [Worker budget guards](../apps/worker/src/retention.ts)

## Pairing MCP clients for library writes

Run `litscout pair` to get a one-time code. To save papers, add notes or change
reading state, configure the connector to request the OAuth `write` scope when
it starts authorization. Request `read write` if the connector also needs to
read the library and notes. Verify that the consent page offers **Change library
and notes**, then enter the code and approve. Pair again if a previously
approved connector needs additional access. Newly paired connectors that omit
the scope can use the read tools. Clients with grants issued before library
permissions were introduced need to pair again to use the tools.

Each credential has up to 20 save attempts and 60 activity attempts per
minute. Browser and API requests and all MCP clients share an instance
allowance of 200 save attempts and 2,000 activity attempts per UTC day. Activity
includes library edits and removals, notes, reading state (opening, rating and
starring papers), vault requests and suggestion actions. Save previews count toward the save allowance.

## Obsidian vault sync

If you are replacing an existing shadow schedule, follow the
[cutover runbook](runbook/cutover.md) before directing it to the live vault.

The CLI reads the vault on your Mac. Cloudflare stores the index and the request
queue. Leave `vault.write` off for initial review. `litscout sync --dry-run` also
skips index uploads, request claims, resolutions and status reports. Run a
regular `litscout sync` with `vault.write: false` to publish the index and show
planned changes on the private Vault sync page.

```ts
vault: {
  root: "./vault",
  // name: "Research vault", // Obsidian name if different from the folder name
  write: false,
  projects: ["Research/Projects/*.md"],
  exclude: ["**/.*", "**/*NDA*", "Research/Private/**"],
  uploadDescriptions: true,
  // uploadBodies: true, // read project, idea and draft notes on the web
  // bodyExclude: ["Research/Partners/**"], // bodies that stay in the vault
  ideaTag: "type/idea", // or a list, e.g. ["type/idea", "type/synthesis"]
  workingPaperTag: "type/working-paper",
  // guideUrl: "https://…/self-host.md#vault-conventions", // linked from the Vault pages
  inbox: "Inbox.md",
  paperNotes: {
    dirs: { "Computer vision": "Research/Papers" },
    // template: "./vault-paper-template.md",
  },
  digestsDir: "LitScout/Digests",
  // digestTemplate: "./vault-digest-template.md",
},
```

- Use an absolute `root` or one relative to the config file. Set `vault.name`
  when the name in Obsidian differs from the final folder name in `root`.
  Deploy the Worker with that setting to enable the matching Obsidian links.
  The inbox and
  output folders are relative to the vault. The two optional template paths
  are relative to the config file. The destination keys in `paperNotes.dirs`
  are the exact LitScout topic names. Without a matching folder the request
  is rejected and appears on the Vault sync page.
- Use `vault.exclude` globs for private material. Defaults exclude dotfiles,
  hidden directories, and files or folders with `NDA` anywhere in the name.
  Matching ignores case and treats canonically equivalent Unicode names alike.
  A custom exclusion list replaces the defaults, so include these patterns
  when extending it.
- The index uploads project and idea descriptions by default. Set
  `vault.uploadDescriptions: false` to omit both. To exclude one note entirely
  from the live index, add `litscout: private` to its YAML frontmatter.
  Use an exclusion glob for a note whose filename must also stay out of error
  reports, even if its frontmatter is unreadable. Other indexed fields include
  titles, relative paths and hashes. Note bodies remain in the vault unless
  you set `vault.uploadBodies: true`: then sync also uploads the Markdown body
  of each project, idea and working paper note (up to 32,000 characters,
  without frontmatter) so the Projects, Ideas and working paper pages and the
  `get_note` MCP tool can show it read-only. Paper notes never upload their
  body. Add globs to `vault.bodyExclude` for notes whose body must stay local
  while their title still indexes. Edit notes in Obsidian; the next sync
  updates the copy, and turning the setting off clears the uploaded bodies.
  Sync leaves out Obsidian `%%comments%%` and HTML comments, and cuts a
  longer body with a line saying it continues in the vault. Any token with
  `read` scope, including an MCP client's, can read uploaded bodies. Deploy
  the Worker version that supports bodies before turning the setting on. A
  restored backup holds no bodies; the next sync uploads them again.
  `vault.briefs` can index the titles, paths and hashes of additional notes.
- Sync skips unreadable or malformed candidate notes and reports their relative
  paths and reasons in the CLI output and on the Vault sync page. Other notes
  still sync.
- The digest command reads eligible idea and project notes on the scheduling
  machine. `digest.suggestionsPerDay` defaults to 3, accepts at most 10 and
  can be set to 0 to disable suggestions and the local digest vault scan.
  By default, `research.contextBodies: false` sends only idea and project
  metadata to the digest agent. Setting it to `true` gives the agent more
  context for suggestions and exposes the selected note bodies to the
  configured agent provider. In either mode, the CLI drops suggestions
  that reproduce 40 or more consecutive characters from those bodies after
  normalising whitespace, and reports how many it dropped.
  Acceptance on Today or Ideas queues work for `litscout sync`.
- Templates are Markdown with YAML frontmatter. Use `{{frontmatter}}` on its
  own line between the opening and closing `---` to insert the built-in
  fields. Paper templates also accept `{{heading}}` for Markdown and
  `{{title}}`, `{{litscout_id}}`, `{{arxiv}}` and `{{doi}}` as YAML-quoted
  values. Digest templates accept `{{date}}` for display and `{{day}}` as a
  YAML-quoted value. The built-in paper and digest templates set `type`, a
  matching `type/*` tag, `description` and `ai-first`. Include
  `{{frontmatter}}` to use these defaults in a custom layout.
- Sync checks relative paths, ancestor directories, symlinks and exclusions
  before publishing complete files atomically. It preserves surrounding
  note bytes and leaves edited LitScout blocks in place. Status requests
  compare the current note with the hash captured at queue time. Paper links
  only extend the appropriate list. Creating a paper note uses an unused
  filename when the title collides. Atomic replacement preserves the original
  file's permission bits. It replaces the file object, so extended attributes
  such as Finder tags are lost on a rewritten file.
- During a shadow run, set `digestsDir` to the separate new output folder.
  Sync refuses a directory with foreign files. Pass `--adopt` to let
  the two pipelines' files coexist in a directory after review. A same-date
  file from the old pipeline is kept even with `--adopt`.
- Sync uses the ingest scope. `ideas list` and `ideas show <id>` use read
  scope, as do the private HTTP routes `/ideas`, `/projects` and
  `/vault/paper-note/:paperId`. `ideas capture "<title>"` uses write scope.
  To offer vault tools over MCP, explicitly set `mcp.researchTools: true`
  in the instance config. This setting defaults off. MCP `research_context`
  uses read scope, and `capture_idea` and `request_link` require a connector
  approved for write access.
- `--only index|requests|blocks|digests` limits the work to one step.
  The digest date follows `instance.timezone`. A run can process up to 50
  queued requests and index up to 1,000 notes.
- `research.vaultIndex: true` lets a machine without the vault (an own
  server) read projects and ideas for the digest from the instance's vault
  index, which `litscout sync` publishes. Off by default.

### Vault conventions

Put tags and keys in the YAML frontmatter at the top of the note.

| Note          | What LitScout reads                                                                                                | How to start                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Idea          | Any tag in `vault.ideaTag` (default `type/idea`), plus `status`, `description`, `project` and `papers`             | Add a configured tag to an idea note.                                                                     |
| Working paper | Any tag in `vault.workingPaperTag` (default `type/working-paper`), plus `status`, `project`, `ideas` and `papers`  | Add a configured tag to a draft. Use `ideas` for ordered Obsidian links.                                  |
| Project       | Paths matching `vault.projects` (empty by default), plus `status` and `description`                                | Add a path pattern for your project notes. Mark those notes with `type: project` or a `type/project` tag. |
| Paper note    | `type/paper` with a valid `arxiv` or `doi` key, plus optional `maturity`                                           | Add the identifier to match an existing LitScout paper.                                                   |
| Private note  | `litscout: private` opts out of the index and the convention path list                                             | Set the key on the note or use `vault.exclude` to skip its path.                                          |
| Template      | Frontmatter with a `{{…}}` (core Templates) or `<% … %>` (Templater) placeholder: skipped and listed as a template | Nothing to do. Notes created from a template no longer hold the placeholders.                             |

`vault.ideaTag` and `vault.workingPaperTag` each take one tag or a list of up
to 20. A list lets existing notes count without retagging them: for example,
`ideaTag: ["type/idea", "type/synthesis"]` treats synthesis notes as ideas.
Matching ignores a leading `#` and letter case. A note outside the project
paths that carries both an idea tag and a working-paper tag is skipped and
reported as a file issue, so it never lands in the wrong kind. With a list,
`litscout sync --dry-run` prints the matches for each tag, for example
`ideas: 3 (type/idea 1, type/synthesis 2)`, and `--json` adds `tagCounts`.

The Vault, Ideas, Working papers and Projects pages link to these conventions
at `vault.guideUrl` when it is set (an `http` or `https` address, for example
this section in your own copy of the repository); without it they name this
section of `docs/self-host.md`.
The per-tag counts stay on your machine; the Vault sync page shows the
totals. [Tag matching](../packages/sync/src/vault-source.ts)

Run `litscout sync --dry-run` and read the convention report in your terminal.
Run `litscout sync` to publish the counts and up to 50 paths of paper notes
without usable identifiers to the private Vault sync page. The report gives
only counts for excluded folders, excluded Markdown files encountered during
the scan, and notes marked private. Sync skips excluded folders entirely.
Review the possible non-project count if your project folder contains other
notes. Narrow `vault.projects` or add those files to `vault.exclude`.

## Venue watchlist

`venues.json` lists the journals and conferences LitScout reads beside
arXiv. `sources.venues.watchlist` in the config points to it. Each entry
needs a `name`, a `kind` (`"journal"` or `"conference"`) and one field that
says where the venue's papers are listed:

```json
{
  "venues": [
    { "name": "TPAMI", "kind": "journal", "issn": ["0162-8828"] },
    { "name": "CVPR", "kind": "conference", "openalex_source": "S4210176548" },
    { "name": "ACL", "kind": "conference", "acl_anthology": "acl" }
  ]
}
```

| Field             | Value                                                                             | Read from                               |
| ----------------- | --------------------------------------------------------------------------------- | --------------------------------------- |
| `issn`            | A list of the journal's ISSNs                                                     | Crossref, by DOI registration date      |
| `openalex_source` | The venue's OpenAlex source id                                                    | OpenAlex, by the date it added the work |
| `acl_anthology`   | `acl`, `emnlp`, `naacl`, `eacl`, `conll`, `tacl`, `cl` or `mol`                   | The ACL Anthology                       |
| `pmlr`            | A PMLR series as PMLR names it, such as `COLT` or `AISTATS`                       | PMLR's volume index                     |
| `doi_prefix`      | A DOI prefix, such as `10.4230/LIPIcs.ITP`                                        | Crossref or DataCite                    |
| `container_title` | The proceedings title exactly as Crossref writes it; `{year}` stands for the year | Crossref                                |
| `openreview`      | An OpenReview venue id or a list of them; `{year}` stands for the year            | OpenReview, accepted papers             |
| `jmlr`            | `true`                                                                            | JMLR's RSS feed                         |

When an entry has several of these fields, the most precise one is used, in
this order: `jmlr`, `acl_anthology`, `pmlr`, `doi_prefix`, `container_title`,
`openreview`, then `issn` for a journal or `openalex_source` for a
conference. An entry with none of them is skipped with a warning. Optional
fields: `top: true` marks a venue for the reader's top-venue filter, and
`sources` limits an entry to the named sources. OpenAlex lookups work better
with `OPENALEX_API_KEY` set, and OpenReview needs a login or token.

## Cloudflare Free plan

LitScout v0 targets Workers Free. Workers Paid is optional, and is not required
for the daily workflow. These limits are Cloudflare's values of 2026-11-17; other applications on the
account share daily quotas and storage.

| Limit                     | Free                                   | How LitScout fits                                                                                                                         |
| ------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP Worker CPU           | 10 ms/request                          | CLI defaults to five papers, twenty summaries or twenty legacy/radar records per request.                                                 |
| Cron Worker CPU           | 10 ms/trigger                          | Cron records its invocation and expires old Health run reports in bounded batches                                                         |
| Worker requests           | 100,000/day/account, reset 00:00 UTC   | Local scheduling and bounded work; public API reads share a per-IP 60 requests/minute limit                                               |
| Subrequests               | 50/invocation                          | Ingest has no external fetches; D1 statements use transactional batches                                                                   |
| D1 queries                | 50/invocation; `batch()` counts as one | The local rehearsal targets at most 40 calls per checked request.                                                                         |
| D1 bound parameters       | 100/statement                          | Counted in tests, including a full 100-day archive                                                                                        |
| D1 statement length       | 100 KB                                 | Counted in tests; values are bound separately                                                                                             |
| D1 rows written           | 100,000/day/account, reset 00:00 UTC   | Atomic reservations enforce an 80,000-row application budget, including accounting writes                                                 |
| D1 rows read              | 5,000,000/day/account                  | M4i models about 468,000 rows per UTC day (9.4%) for one instance. `doctor` reports rolling D1 metrics.                                   |
| D1 size / account storage | 500 MB / 5 GB                          | `doctor` warns at 300 MB. The Mac's retention job compacts eligible papers beyond 45 days by default. [Paper retention](#paper-retention) |
| Cron triggers             | 5/account                              | The template defines one daily trigger for run reports.                                                                                   |

Every CLI upload goes through the same limiter, including radar, feed-day,
legacy and digest writes. Set `instance.limits.ingest` to override the M4i
defaults shown below. [Upload limits](../packages/core/src/ingest-limits.ts) · [CLI batching](../packages/pipeline/src/ingest-batching.ts)

```ts
instance: {
  limits: {
    ingest: { papers: 5, summaries: 20, legacy: 20, radar: 20, bytes: 262144 },
  },
},
```

You may lower or raise these values up to 40 papers, 50 summaries, 40 total
legacy records, 40 radar records and 524,288 JSON bytes. The server rejects
larger requests before full record validation. The CLI counts UTF-8 bytes,
including the JSON envelope. Feed-day and digest writes are individual bounded
records. A record larger than the byte cap is recorded as failed without being
sent.

A 503, Cloudflare 1102/CPU/resource-limit response, or connection failure halves
the batch and replays the same items. Unchanged upserts write zero content rows.
A failed singleton is recorded and the run continues. JSON `data.ingest` includes
`requests` (path, item count, bytes), `retries`, and item `failures`; do not treat a
reported failure as an uploaded record.

The server is authoritative. Daily ingest reads its ingest-scoped `/api/v1/budget`
before the first write. The local `write-budget.json` caches only the last server
answer for offline diagnostics; local reservations are not persisted and never
overrule the server. A stale or damaged cache does not block a healthy server.

Use `litscout budget --json` to recover stale reservations and see the current
UTC day, used and reserved rows, and effective limit. Abandoned ten-minute
reservations and uncertain settlements charge the full reservation plus
accounting writes. A late settlement adds any excess once to the lease's
original UTC day.

`litscout budget --reconcile` and `litscout doctor` also check D1 Analytics for
the deployed database when Wrangler can identify it and
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` are available. The token
needs account Analytics read access and Wrangler credentials must permit D1
execution for the ledger update. Analytics is per database and may lag.
Wrangler's rolling 24-hour numbers are warnings only. When reconciliation
finds additional writes, it records the difference in `unaccounted`.
Unaccounted writes or an exceeded estimate reduce the day's effective limit
from 80,000 to 75,000 until 00:00 UTC. The Health page shows the same limit.

| What you see                                 | Action                                                                                                                                   |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| CLI `budget-stop` with `resumeAt`            | Keep checkpoints; rerun the same command after reset (00:00 UTC, 08:00 Malaysia/Shanghai). Use `budget` if abandoned leases may be stale |
| HTTP 413                                     | Lower the batch or JSON byte limit; split large records where their contract permits it                                                  |
| HTTP 429 with write-budget fields            | CLI shrinks to the largest affordable batch, down to one item, or returns `budget-stop`                                                  |
| HTTP 429 with `Retry-After` on public routes | Wait for the per-IP minute bucket to recover                                                                                             |
| Cloudflare error 1027                        | Account request allowance is exhausted; wait until 00:00 UTC. This is outside LitScout's write budget                                    |

For local CPU estimates run `pnpm --filter @litscout/worker bench:ingest`.
An operator checks actual
`cpuTime` after deployment; local timing cannot establish the production CPU cost.
