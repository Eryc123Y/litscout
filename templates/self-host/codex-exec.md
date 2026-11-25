# Schedule LitScout with Codex

Set a schedule in your system scheduler and run this command under the same
user that set up LitScout. Use your scheduler's absolute path to `codex`.

```sh
codex exec --cd /ABSOLUTE/REPO --sandbox workspace-write \
  --add-dir /ABSOLUTE/HOME/.config/litscout \
  --add-dir /ABSOLUTE/HOME/.cache/litscout/run \
  -c 'sandbox_workspace_write.network_access=true' \
  'Follow docs/runbook/daily.md in self-host mode. Pass --config /ABSOLUTE/CONFIG/litscout.config.ts to every LitScout command. Use summaries run and digest run for agent output. End with the run report.'
```

Allow the scheduled task to reach the paper sources and your Worker and to write
LitScout's local state and cache directories. The writing agents that LitScout
starts for summaries and digests get separate, restricted settings.
