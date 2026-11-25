# Developing LitScout

This page is for people who change LitScout's code. To run LitScout, start
with the [README](../README.md).

## Setup

LitScout needs Node 22.13 or later (`.nvmrc` selects Node 22) and the pnpm
version in [`package.json`](../package.json).

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
```

On Linux, install Chromium with its system libraries:
`pnpm exec playwright install --with-deps chromium`.

The workspace layout is in the [README](../README.md#development). The
[decision records](adr/) describe why the code is built the way it is.

## The merge gate

Every change passes `pnpm verify` locally before it merges. GitHub Actions
runs the same command on every pull request and on pushes to `main`.

```sh
nice -n 10 pnpm verify
```

It runs, in order:

1. `pnpm audit --audit-level high`, the dependency audit.
2. `pnpm check`: strict type checks, lint, unit and integration tests with
   coverage gates, the build, desktop and phone Playwright flows, the
   formatting check (`pnpm format:check`) and the repository audit
   (`tools/audit.mjs`).
3. The Worker and CLI bundle smoke tests.
4. The offline rehearsal of the daily run
   ([what it checks](self-host.md#rehearse-the-daily-runbook-locally)).

The GitHub workflow runs the same command when dispatched by hand from the
Actions tab. [Workflow](../.github/workflows/ci.yml)

Tests block external network calls. D1 tests use a local workerd.

Coverage must reach 80% for lines, functions, branches and statements overall
and in the web app, and 90% in `packages/core`, `packages/db`, `packages/sync`
and the pipeline contracts (`packages/pipeline/src/contracts`). Line coverage of
the imported MCP code must stay at or above 94.51%.

The repository audit rejects token-shaped strings and email addresses in any
tracked file, and relative imports that cross from one package into another.
Keep credentials, account names and private paths out of the repository.

## Local reading app

`pnpm web:local` builds the web app and serves it with a local Miniflare Worker
at `http://127.0.0.1:4173`. It seeds recorded paper metadata, synthetic
summaries and private test markers into a temporary in-memory D1. Outbound
Worker requests are blocked, `LOCAL_DEV=true` is set, and no credentials or
deployment are involved. The fixture day is 2026-11-17: open
`/app/days/2026-11-17`. `pnpm test:e2e` starts and stops this server itself and
checks desktop and phone viewports.

Never set `LOCAL_DEV=true` in a deployment. Production relies on same-origin
Cloudflare Access cookies.

## Builds

`pnpm build` writes:

- `apps/web/dist`: the web app.
- `apps/worker/dist/bundle/worker.js`: the Worker.
- `apps/cli/dist`: the CLI, with the Worker, web assets, migrations and
  templates it needs for setup.

`node apps/server/scripts/bundle.mjs DIR` turns a build into an own-server
release ([guide](self-host-server.md#3-build-a-release-build-machine)).

## CLI conventions

- Commands accept `--json` for a machine-readable envelope. The `watch` and
  `abstracts` commands, inherited from the earlier MCP project, print JSON
  Lines instead and do not load the application config. `litscout --help`
  shows their arguments, and the watch list's fields are in
  [Venue watchlist](self-host.md#venue-watchlist).
- Exit codes: 0 when the command completed, 2 when there was no work, 1 on an
  error.
- Config discovery walks up from the current directory and stops at the first
  `.git` directory or file, or at the home directory. Setup commands
  (`deploy`, `doctor`, `token`) accept `--config PATH` for a file you trust.
  `doctor` prints the resolved path, and JSON envelopes include
  `meta.configPath` (null when no config was used).
- `deploy --skip-keys` deploys without source API keys; add them later with
  `litscout keys`. `deploy --keys-from-env` reads nonempty `S2_API_KEY`,
  `OPENALEX_API_KEY` and `CORE_API_KEY` from the environment instead of
  prompting. The two flags exclude each other. A real deployment without
  either needs a terminal and fails before it changes anything. `--dry-run`
  never reads keys.
- Changing `deploy --name` creates separate pairing state and keeps the
  previous local profile in a private backup.

## Tokens and health

- Public `/health` returns only `{ "ok": true }` or `false`. Details are at
  `/api/v1/health` with a read-scoped token.
- `token create --name NAME --scopes read --expires-in 30` sets an expiry in
  whole days. Without `--expires-in` the token does not expire. `doctor` warns
  before a token expires and about old tokens without an expiry.
- Local token writes take an exclusive lock, recover from a stale owner and
  write mode-600 files atomically before the remote insert. A failed insert
  removes its pending local entry.

## Public feed and Worker settings

The deploy config derives `PUBLIC_FEED` and the safe `INSTANCE_CONFIG` from
`instance` and the topic names. `instance.publicFeed` defaults to `false`
([decision](adr/0002-private-feed-default.md)). Without `PUBLIC_FEED=true`,
public endpoints fail closed and the root shows a sign-in page.

- Public JSON is under `/api/v1/public/days` and `/api/v1/public/days/:day`.
  It never includes private digest text.
- With a private feed, a signed-out `/api/v1/instance` returns only
  `{"name": "LitScout"}`. Callers with a verified Access login or a read-scoped
  token get the full instance settings.
- Public reads share a limit of 60 requests a minute per IP address. An
  optional Cloudflare WAF rule is in the
  [daily runbook](runbook/daily.md#optional-cloudflare-waf-rate-limit).

## More local checks

```sh
pnpm test:migrations
pnpm exec tsx packages/db/scripts/size-estimate.ts 1000
pnpm --filter litscout test:eval
```

The evaluation command exits with 2 and explains what is missing until a
recorded sample is supplied. Live research checks run only on request, with
`pnpm --filter litscout test:live`, and never in CI.
