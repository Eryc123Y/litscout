# LitScout cron schedule

For keyword-only mode, set `agent.mode` to `"none"`. Replace the paths and
create a private log directory. Copy the following into your user crontab.
The example runs at 13:30 on weekdays in the scheduler's local time.

```text
PATH=/ABSOLUTE/NODE/bin:/ABSOLUTE/PNPM/bin:/usr/bin:/bin
30 13 * * 1-5 cd "/ABSOLUTE/REPO" && pnpm exec litscout daily fetch --json --config "/ABSOLUTE/CONFIG/litscout.config.ts" >> "/ABSOLUTE/LOGS/daily.log" 2>&1
```
