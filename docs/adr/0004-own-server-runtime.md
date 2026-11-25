# ADR 0004: Run LitScout on the owner's server

- Status: accepted (2026-11-22) and built: the server runtime is `apps/server`.
- Supersedes, once M5 is done: the host decision in the v0 spec, §4.3 ("v0 runs on Cloudflare") and the scheduler in §4.1 and §4.2 (a scheduled agent on the owner's laptop).

## Context

- **The laptop is a single point of failure.** The daily run (crawl, summaries, digest, sync, prune, legacy import) runs through a scheduled agent on the owner's laptop. When the laptop is off, asleep, packed for travel or being moved, nothing runs, not even the crawl.
- **The first week missed its target.** From 2026-11-16 to 11-20 every listing day was late or missed in Health:
  - the D1 write budget ran out twice on 11-19, pausing the crawl;
  - an agent client failure stopped the digest on 11-20, after summaries had fallen back to another client;
  - a one-day backlog persisted because each run handled one target day.

  A run that was not behind took about 20 minutes for a whole day (11-20, 10:20–10:42).

- **The volume is higher than §4.3 assumed.** November listing days carried 372 to 1,254 papers, about 725 on average (arXiv plus journals and conferences). §4.3 assumed 328 a day. At the measured 8.6 KB per full paper, a year at this volume reaches about 0.6 GB even with the retention below. D1 Free allows 500 MB per database.
- **A free container sandbox was rejected.** It was tried for the scheduler and failed on three counts:
  - no init system, no cron and no autostart;
  - processes stop on every restart;
  - its node's disk was full on the first day, so no file could be written.
- **The owner has an always-on VM:** Ubuntu 24.04 with systemd, 2 vCPU, 2.4 GiB RAM and 20 GB free, up for months. It also runs network services the owner depends on daily, so LitScout must not be able to disturb them.

## Decision

1. **Order of the move.**
   - Scheduled work moves to the owner's VM first. It runs against the existing Worker and D1, so no data moves.
   - The backend follows once the scheduler has run cleanly for one to two weeks: web app, API, MCP and the database, as Node with SQLite.
   - Data moves by export and restore. The template keeps the Cloudflare deployment; a server deployment becomes a second documented target.
2. **Model work uses subscription CLIs only**, as one ordered chain: Antigravity, then Codex, then Claude Code.
   - The first client that passes its login check runs. Missing or signed-out clients are skipped.
   - There is no paid API fallback (2026-11-22).
   - If no client is usable, the day waits for the retries and the owner is notified.
3. **One fixed schedule in the instance time zone.**
   - The main run is at 09:45, after the arXiv announcement (09:00, or 08:00 during US daylight saving time) and the D1 write-budget reset (08:00).
   - Retries at 13:45 and 21:45 only finish missing steps.
   - One run catches up every pending day in order. Legacy import and backfill run only after the current day is complete.
   - The on-time target becomes the same calendar day instead of 11:30. Reading a day on the next day is acceptable (2026-11-22).
4. **Notifications are pushed only when the owner should act:**
   - a fallback was used;
   - a step failed;
   - a day had no digest after its last retry;
   - a login check failed;
   - a client update failed;
   - the server did not start its run;
   - storage crossed its warning level.

   The Worker's daily Cron checks that the server started its run, so a dead server is noticed from outside it. Details stay in Health and the MCP status tool; raw logs stay on the server.

5. **Isolation on a shared host.**
   - A dedicated unprivileged user without sudo runs LitScout and the agent CLIs.
   - systemd units cap a run at 1 GiB of memory and one CPU core, at low priority.
   - LitScout never edits the host's other services or their configuration.
   - Builds happen elsewhere; only built output is copied to the server.
   - The backend later gets its own tunnel rather than sharing an existing one.
6. **Storage and retention.** LitScout's footprint on the server is capped at 5 GB, with a warning at 4 GB. Above the cap, the oldest non-kept feed days are deleted first, with a notification.

   | Data                                                                            | Kept for                                                                              |
   | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
   | Full records of feed papers                                                     | 60 days (`storage.fullDays: 60` in the owner's config; the template default stays 45) |
   | Compact index rows and feed occurrences                                         | 12 months, enough for Trends and finding an older title                               |
   | The kept set: library, reading activity, digest picks and radar, research links | Indefinitely. Vault notes link to these papers                                        |
   | Digests                                                                         | 12 months                                                                             |
   | Run reports                                                                     | 30 days                                                                               |
   | Agent session transcripts                                                       | 14 days                                                                               |
   | Logs                                                                            | 200 MB                                                                                |
   | Backups                                                                         | 3 on the server, 14 off the server                                                    |

## Estimates (2026-11-22)

**Basis:**

- about 725 papers per listing day and about 530 per calendar day (weekends have no arXiv listing);
- 8.6 KB per full paper and 1.0 KB per compact paper (measured on a 1,000-paper replay);
- staging was 36.6 MB for 4,983 feed items (7.3 KB each) on 11-21.

| Item                                | Size                                                     |
| ----------------------------------- | -------------------------------------------------------- |
| Growth with no pruning              | about 4–5 MB a day, about 1.5 GB a year                  |
| Full window (60 days)               | about 275 MB                                             |
| Compact rows (months 3–12)          | about 155 MB                                             |
| Kept set                            | about 125 MB a year, assuming about 40 kept papers a day |
| Other tables                        | about 20 MB                                              |
| **Database at the end of year one** | **about 0.6 GB**, then about 0.15 GB a year              |
| Node, LitScout and three agent CLIs | about 1 GB                                               |
| Transcripts, logs and three backups | about 0.8 GB                                             |
| **Total in year one**               | **about 2.4 GB**, under the 5 GB cap for many years      |

**Memory:** one agent runs at a time. A run should peak below 1 GiB (the CLI plus one agent), within the 1.5 GiB available and the cap. The later backend should stay resident at about 0.2 GiB.

## Consequences

- **Cloudflare limits:** the free-plan limits (write budget, 10 ms CPU, 500 MB per database) stop applying when the backend moves. Until then they still do.
- **A shared dependency:** the VM serves both the owner's network and LitScout. The isolation and caps above protect the former.
- **Logins:** renewing a subscription CLI's login cannot be automated. Nightly checks and notifications surface it early.
- **Vault ownership ([ADR 0003](0003-vault-first-ownership.md)) is unchanged.** The vault holds the owner's writing. LitScout keeps machine-made content with bounded retention and is not the long-term archive.

## Update 2026-11-22: the backend moves first

The owner asked for the database move before the scheduler. Two changes to decision 1:

- **Order.** The backend is prepared and its data copied first. The hostname switch waits for the owner (a tunnel and DNS change on his account); scheduled work moves after it, so the server's scheduler writes to the server's database from its first run.
- **Runtime.** The server runs the unchanged Worker bundle on workerd through Miniflare (`apps/server`), not a Node port. D1, KV and Durable Objects keep their APIs and are stored as SQLite files in one state folder, so the Worker code and its tests stay the same on both targets. Durable Object storage is not copied: OAuth MCP clients pair again after the switch. Setup, data move, switch and rollback: [own-server runbook](../runbook/own-server.md).

## Update 2026-11-22: storage limits on the server

- **What counts.** The 5 GB cap and the 4 GB warning apply to the LitScout user's home: the LitScout folder, Node, the agent CLIs and their state. On 2026-11-22 that was about 2.8 GB, most of it Node, the clients and the releases. Releases (about 340 MB each with their dependencies) and npm's download cache (about 600 MB) were the biggest items, so they get limits too: the live release and the two newest others, and the cache emptied above 200 MB.
- **Compact rows** expire 12 months after their last listing (`storage.compactMonths`), unless a reference without a foreign key still points at them. Over the cap, `prune --over-cap` removes the oldest week of them per run, never inside the full-record window.
- **Digests stay** beyond 12 months. They are about 10 KB a day (4 MB a year), and deleting one would take its picks and radar papers out of the kept set.
- **Backups.** The server keeps seven nightly snapshots rather than three. They are about 6.5 MB each, and a week of them covers more than a day of deploys.
- Setup and the full table: [own-server runbook](../runbook/own-server.md#storage-limits).
