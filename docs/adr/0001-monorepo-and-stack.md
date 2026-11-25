# ADR 0001: monorepo and foundations

Status: accepted for M0, 2026-11-17.

**2026-11-18 update.** The merge gate now runs locally with `pnpm verify`.
The Actions workflow runs the same command on manual dispatch. The original
M0 CI decision is recorded below. [Merge checks](../self-host.md#checks-before-merging)

## Decision

Use pnpm workspaces, TypeScript 5.9 strict mode, ESM and Node ≥22.13. Package imports cross workspace boundaries through package names. Separate reusable paper/source/database/MCP code from the Worker, CLI and web app.

The Worker uses Hono, Zod 4, `@modelcontextprotocol/server` 2.3.1, `@cloudflare/workers-oauth-provider` 1.2.3 and `agents` 0.28.1. The existing OAuth provider, pairing store and MCP server remain mounted together; Access middleware protects private web/API paths and never wraps the OAuth routes. A hashed-token repository supplies CLI authentication. Static assets and the daily Cron stub share the Worker.

Drizzle describes all 27 business tables. Repositories accept a Drizzle SQLite/D1 database and use parameterised SQL, optimistic revisions, soft deletion and atomic identity merges. SQLite transactions and D1 batches provide the same write boundary. The pinned Drizzle D1 raw-query batch path fails when binding parameters; the repository compiles SQL using Drizzle's dialect and sends the atomic batch through its underlying D1 client instead. Both adapters are tested. An internal `litscout_schema` table records the applied version because local D1 rejects writing `PRAGMA user_version`.

FTS5 external-content tables and synchronisation triggers are raw SQL migrations. Drizzle metadata is checked against the migration columns, indexes and foreign keys. The slim `paper_index` deliberately has no cascading paper foreign key so retention can keep it after removing a full record.

React 19 and Vite provide the minimal page. React Router, TanStack Query and Playwright remain the planned choices for the interactive web milestones; M0 does not add unused routing, data fetching or end-to-end UI infrastructure.

Vitest 5 projects cover every workspace member, with V8 coverage. Miniflare runs D1 and Worker checks in local workerd. ESLint 9 with typescript-eslint and Prettier share workspace settings. GitHub Actions runs Node 22, the complete check and a separate empty-D1 migration check without secrets.

## History import and licence

Import `litscout-mcp-v01` main at `7f5a12f` using an unsquashed local `git subtree add`, then move its files using `git mv` in one refactor commit. Subsequent commits repair boundaries. The original commits remain reachable; neither reference repository is modified. Its historical documentation is kept with the working notes and is not the current operating guide.

At the owner's explicit instruction, remove the imported MIT licence file: all imported commits are his own. This repository stays private until published, and will use AGPL-3.0 on publication. Update 2026-11-25: The owner chose AGPL-3.0-or-later; `LICENSE` and every package's `license` field carry it, and the repository audit checks both (R1). The code ported from the old fork `litscout-daily` (arXiv parsers, topic presets, styles, sources) is the owner's own by `git blame`; the fork's upstream licence (Apache-2.0 with an added disclaimer) does not reach it. M0 neither publishes nor grants a new public licence.

## Consequences and limits

The same repositories run on local SQLite and D1. Source adapters and MCP depend on a small source binding interface rather than the Worker app, avoiding a runtime dependency cycle. New code has small functions; imported factories and the unchanged OAuth implementation retain their existing structure (recorded as an M0 deviation).

Doctor labels Wrangler's rolling 24-hour, per-database metrics accurately; it cannot obtain midnight-UTC account totals from `d1 info`. Synthetic SQLite size/change counts are capacity warnings rather than D1 billing measurements. Staging verification and account configuration belong to the maintainer after local review. No deployment, push, publication or Cloudflare account change is part of M0.

## Round 2 review amendments

Private/static routes now use an allowlist and pre-routing path checks. Public health is boolean-only; detailed health requires a read token. Consent attempts are isolated by handle, while separate hashed-IP instances of the existing PairingStore provide transactional authorize/admin budgets. Generic public failures retain static diagnostic reasons only in structured logs.

Tokens support optional expiry. Local credential writes take an exclusive, stale-owner-aware lock, save before remote insertion and roll back only their own failed entry. Executable config discovery stops at Git/home boundaries; explicit trusted overrides and resolved-path output make that choice visible. Optional validated Access config is exported into Worker vars.

Before first deployment, initial migrations were edited in place. All three FTS indexes use column detail without column-size storage; the paper index retains title and TL;DR, with safe all-word matching. The smaller measured variant costs 8,466.432 B/paper and 29.176 SQLite row changes in the deterministic workload. Storage/budget projections use these labelled proxies, not D1 billing claims. The build report records both variants, limitations and regression evidence.
