# LitScout daily scheduled task

- Name: LitScout daily
- Schedule: `30 13 * * 1-5` in your chosen time zone
- Working directory: `/ABSOLUTE/REPO`

## Task prompt

Follow `/ABSOLUTE/REPO/docs/runbook/daily.md` in self-host mode. Run the
commands from that repository and pass
`--config /ABSOLUTE/CONFIG/litscout.config.ts` to each LitScout command. Use
`summaries run` and `digest run` for agent output. End with the run report.
