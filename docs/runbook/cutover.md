# LitScout cutover and rollback

The owner approves the switch. The owner or the maintainer runs these commands from the stable
LitScout checkout with the scheduling account and the same trusted config and
token used by Antigravity. Use the CLI and Worker from the same reviewed build.
Keep the original sidecar backup, the shadow reports and the old checkout
available throughout the switch.

```sh
SIDECAR="$HOME/.gemini/config/sidecars/litscout-daily/sidecar.json"
CONFIG="/absolute/path/to/litscout.config.ts"
BACKUP="/absolute/path/to/verified-litscout-backup.json.gz"
TARGET="Claude/Scheduled/litscout-daily/digests"
```

## Confirm readiness

- Use a scheduler token with `read,ingest,vault` for the cutover check and a
  runbook that includes `sync`. For a schedule without sync, use `read,ingest`.
  Rotate an older ingest token if doctor reports legacy vault access.
- The owner compares both digests across two weeks. The M1 gate is five consecutive
  weekdays with the new digest beside the old one by **11:30 in
  `instance.timezone`**, for the same reading day. Review pick overlap against
  the old pipeline, radar differences, the client used and any budget stop.
  Sign off the parity checklist and reconcile legacy counts. Complete the fixed
  legacy import before cutover.
  [Shadow reports](daily.md#save-the-weekday-comparison).
- Create a fresh, private LitScout export with `pnpm exec litscout backup --out "$BACKUP" --config "$CONFIG"`
  using a token with `write` scope. Verify it with
  `pnpm exec litscout backup --verify "$BACKUP"`. Retain the export and the
  verification output. The export must belong to this instance and be at most
  seven days old. It does not contain local vault file bytes.
- Run the read-only check:

  ```sh
  pnpm exec litscout cutover check --config "$CONFIG" --backup "$BACKUP"
  ```

  Add `--json` for a record of the result. The check examines the five most
  recent weekdays through the latest 11:30 deadline, runs doctor and previews
  vault sync. The installed and expected schema versions must match.
  When Health has run records, the check uses the run that first reports
  writing the LitScout digest for each day. It checks that run's reading day,
  digest timestamp, digest client and budget status. Sidecar reports supply
  the old digest's reading day and timestamp and the pick comparison.
  When the instance has no run records, the sidecar reports supply all of
  that evidence. The output names the source.
  Both reading days must match the date of the comparison report. A missing
  report, unknown evidence, failed check or invalid export gives **NO-GO**
  and exit 1. The check prints pick counts and their overlap for each run.
  When the other checks pass and any overlap is below 0.2, **GO WITH REVIEW**
  lists those dates and exits 1. After the owner signs off on the low-overlap runs,
  repeat the check with `--accept-overlap`. A **GO** and exit 0 confirms the
  checks passed. The check defaults to the daily runbook's report directory.
  Use `--reports-dir DIR` for reports copied to another location. With no
  `--backup`, it looks for the newest default-named export in the current
  directory.

## Switch the scheduled task

Pause the schedule in Antigravity and wait for any active invocation to
finish. Preview the prompt and permission changes.

```sh
pnpm exec litscout sidecar cutover --file "$SIDECAR" --dry-run
```

Have the maintainer confirm every removed (`-`) and retained (indented) workspace
and grant in the preview. Cutover drops these legacy entries where present:

- Workspace URIs for `~/GitHub/litscout-daily` and paths under it.
- `read_file` and `write_file` grants for that checkout, paths under it, and
  `sidecar.before-m1b.json` beside the live file.
- `command(uv)`, `command(uvx)`, `command(git)`, `command(python)` and
  `command(python3)`.

Apply the change after the maintainer confirms the preview.

```sh
pnpm exec litscout sidecar cutover --file "$SIDECAR"
```

Keep the timestamped, mode-600 shadow backup printed by the command. The
original backup is `sidecar.before-m1b.json` beside the sidecar. Reload the
sidecar in Antigravity if needed and run it once. Confirm the report comes
from LitScout and the old pipeline did not run. Leave automatic scheduling
paused until the vault step is complete.

To roll back, preview and restore the shadow prompt. Choose `--to original`
in both lines for the original, old-only task. Reload the restored sidecar,
verify the task with one run, then resume it.

```sh
pnpm exec litscout sidecar rollback --file "$SIDECAR" --to shadow --dry-run
pnpm exec litscout sidecar rollback --file "$SIDECAR" --to shadow
```

Rollback saves the exact live file in a new private
`sidecar.json.before-rollback-<timestamp>.json` before replacing it. A sidecar
already in shadow mode needs no change when rolling back to shadow. If the
live file has unexpected changes, review the printed diff. Add `--force` only
after confirming those changes should be undone.

Once the old pipeline no longer runs, summaries no longer need its exact
prompt. To have formulas written as inline TeX (`$\ell_2$`) that the reader
and Obsidian render, set `agent: { summaries: { math: "tex" } }` in the config.
It affects only summaries written from then on. If the scheduled agent writes
summaries itself with `summaries put`, ask it for the same in its prompt.
Keep `"plain"` (the default) while a rollback to shadow mode is possible, and
set it back when rolling back.

Sidecar updates record the owner in `sidecar.json.litscout.lock`. The command
reports when it removes a stale lock. For an active lock, wait for the other
update to finish. Remove the printed lock path manually only after confirming
that no update is running.

## Enable vault writes

Keep Obsidian edits to the affected files paused during the first sync.
Take a private local snapshot of the vault before applying the command.
Keep a copy of the trusted config with its previous `vault.write` and
`vault.digestsDir` values. Use the real vault-relative digest folder as
`TARGET`. Both preview and apply require `--digests-dir` explicitly.

```sh
pnpm exec litscout vault enable-writes --config "$CONFIG" --digests-dir "$TARGET" --dry-run
pnpm exec litscout vault enable-writes --config "$CONFIG" --digests-dir "$TARGET"
```

The command checks a fresh preview against the current config, then checks
the target folder and previews its writes. Review the printed file paths
before applying. If the old folder still holds legacy files, retain them in
the snapshot and clear the destination before retrying, or approve sharing
the folder and add `--adopt` to both commands. Adopted files stay in place.
An old digest at the same date's destination blocks that write even with
`--adopt`. Resolve the collision explicitly or do the first sync on a day
with a free destination. If sharing is approved, include `--adopt` on each
subsequent normal sync.

The first sync publishes the index and writes digest files and managed blocks
as needed. Save the exact list of applied paths. After it succeeds, the owner or
The maintainer applies the printed `vault.write: true` and `digestsDir` values to the
trusted LitScout config. Resume the schedule after checking the report.
A later normal `litscout sync` processes the queued requests.

To roll back, pause the schedule and restore the previous two config values
first. Compare each path in the applied-file report with the private vault
snapshot. Restore the pre-existing files and move newly created files aside
after reviewing any intervening edits. Restore the old digest files to their
previous paths if they were moved. Preview an index refresh, then republish
the index from the restored vault.

```sh
pnpm exec litscout sync --only index --dry-run --config "$CONFIG"
pnpm exec litscout sync --only index --config "$CONFIG"
```

If the new schedule also needs to be reverted, restore the shadow or original
sidecar before resuming the schedule.

## Retire the old pipeline and archive its repository

The new-only prompt removes the old task from the shared schedule. Check that
any independently configured old runner is paused, and confirm that its
next planned invocation produces no new old-pipeline output. Retain its
configuration for rollback. If retiring that runner needs to be reversed,
resume it only after choosing a sidecar mode that avoids two old runs.

Archive the GitHub repository after the owner accepts the live schedule and vault
writes. Retain the local checkout and the backups. Preview the exact repository
and archive state before confirming the archive. Use the reviewed old repository
slug as `OLD_REPO`.

```sh
gh repo view "$OLD_REPO" --json nameWithOwner,isArchived
gh repo archive "$OLD_REPO"
```

To reverse the archive, check the repository and archive state with the same
`gh repo view` command, then run `gh repo unarchive "$OLD_REPO"`. Unarchiving
and resuming the old scheduler are separate actions.
