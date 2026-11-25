import { useQuery } from "@tanstack/react-query";
import { dueText } from "./health-due";
import { runSteps, runSummary } from "./health-runs";
import { useEffect } from "react";
import type { z } from "zod";
import {
  healthSchema,
  type DailyRunView,
} from "@litscout/pipeline/health-contracts";
import { apiGet } from "./api";
import { countOf, formatCount, formatDay, formatTimestamp } from "./format";
import { Notice } from "./Notice";
import { PageHeader } from "./PageHeader";
import { DeliveryCalendar } from "./HealthCalendar";
import { ServerTile } from "./HealthServer";
import { EmptyState, usePageAnnouncement } from "./ReaderState";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./components/ui/card";
import { cn } from "./lib/utils";

type HealthData = z.output<typeof healthSchema>;
const clients = {
  claude: "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
  gemini: "Gemini",
  cmd: "Custom command",
  api: "API",
};
const errorLabels = {
  budget: "Write budget reached",
  "client-unavailable": "Client unavailable",
  "source-unavailable": "Source unavailable",
  "invalid-output": "Invalid output",
  "operation-failed": "Operation failed",
};
const stepLabels = {
  fetch: "Fetch",
  summaries: "Summaries",
  digest: "Digest",
  sync: "Sync",
  legacy: "Legacy",
};
const description = "Daily runs, digest delivery and database use.";

export function Health() {
  const announce = usePageAnnouncement();
  const query = useQuery({
    queryKey: ["operations", "health"],
    queryFn: ({ signal }) => apiGet("/operations/health", healthSchema, signal),
    // Runs change a few times a day; a revisit within minutes need not reread
    // thirty days of operations.
    staleTime: 5 * 60_000,
  });
  const loaded = query.data !== undefined;
  useEffect(() => {
    if (loaded) announce?.("Health loaded.");
  }, [announce, loaded]);

  if (!query.data)
    return (
      <Notice
        query={query}
        title="Health"
        description={description}
        label="Loading Health…"
        errorTitle="Health unavailable"
        actions={
          <Button asChild variant="outline">
            <a href="/app/today">Sign in</a>
          </Button>
        }
      />
    );

  const {
    days,
    runs,
    budget,
    storage,
    links,
    mirror,
    pruning,
    timezone,
    onTimeBy,
    firstRunDay,
    runtime,
    server,
  } = query.data;
  const when = (at: string) => formatTimestamp(at, timezone);
  const percentage = Math.min(
    100,
    Math.round((100 * (budget.used + budget.reserved)) / budget.limit),
  );
  const { unaccounted = 0, estimateOverrun = 0 } = budget;
  const safetyMargin = (budget.baseLimit ?? budget.limit) - budget.limit;
  return (
    <main id="main" className="reader-page">
      <PageHeader
        title="Health"
        description={`A digest is due ${dueText(onTimeBy)} (${timezone}).`}
      />
      <StatusLine days={days} runs={runs} firstRunDay={firstRunDay} />
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <section
          aria-labelledby="delivery-heading"
          className="flex flex-col gap-2"
        >
          <h2 id="delivery-heading" className="text-sm font-semibold">
            Digest delivery
          </h2>
          <p className="text-xs text-muted-foreground">
            Last 30 completed days · Due {dueText(onTimeBy)} ({timezone}) ·
            weekends have no listing
          </p>
          <DeliveryCalendar days={days} timezone={timezone} />
        </section>
        <div className="grid items-start gap-3 sm:grid-cols-2">
          <Card className={tile}>
            <CardHeader className="gap-1">
              <CardTitle>
                <h2>Write budget</h2>
              </CardTitle>
              <CardDescription>
                UTC day · Resets {when(budget.resetAt)}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p>
                <b className="tabular-nums">{formatCount(budget.used)}</b> used
                / {formatCount(budget.limit)}
              </p>
              <progress
                className="meter"
                value={percentage}
                max={100}
                aria-label="Write budget used or reserved"
              />
              <p className="text-subtle">
                {formatCount(budget.reserved)} reserved
              </p>
              {safetyMargin > 0 ? (
                <p className="text-subtle">
                  Safety margin: {countOf(safetyMargin, "write")}
                  {unaccounted > 0
                    ? ` · ${countOf(unaccounted, "unaccounted write")}`
                    : ""}
                  {estimateOverrun > 0
                    ? ` · ${countOf(estimateOverrun, "write")} above estimates`
                    : ""}
                </p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                {budget.rowsRead === null
                  ? "Health query reads unavailable"
                  : `${countOf(budget.rowsRead, "row")} read for this Health query`}
              </p>
            </CardContent>
          </Card>
          <Card className={tile}>
            <CardHeader className="gap-1">
              <CardTitle>
                <h2>Database storage</h2>
              </CardTitle>
              <CardDescription>
                {storage.sizeBytes === null
                  ? "Database size unavailable"
                  : `${(storage.sizeBytes / 1_000_000).toLocaleString("en", { maximumFractionDigits: 2 })} MB used`}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p>
                {countOf(storage.feedItems, "feed row")} ·{" "}
                {formatCount(storage.summaries)} summarised
              </p>
              <p className="text-xs text-muted-foreground">
                From the last 30 completed days
              </p>
              <p>{countOf(storage.vaultNotes, "indexed vault note")}</p>
              {pruning && (
                <div className="space-y-1">
                  <h3 className="font-medium">Last retention run</h3>
                  <p>{when(pruning.lastAt)}</p>
                  <p>
                    {formatCount(pruning.papersPruned)} pruned ·{" "}
                    {countOf(pruning.rowsUsed, "write row")} used
                  </p>
                  <p>
                    {pruning.waiting === null
                      ? "Waiting count unavailable"
                      : `${countOf(pruning.waiting, "paper")} waiting`}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
          <LastRunTile runs={runs} />
          {runtime === "server" && (
            <ServerTile server={server} timezone={timezone} className={tile} />
          )}
          <Card className={tile}>
            <CardHeader className="gap-1">
              <CardTitle>
                <h2>Links and mirror</h2>
              </CardTitle>
              <CardDescription>
                Paper links and alphaXiv library
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p>
                {formatCount(links.unchecked)}
                {links.capped ? "+" : ""} unchecked links
              </p>
              <p>
                {mirror.completedAt
                  ? `Mirror completed ${when(mirror.completedAt)}`
                  : "Mirror has no completed sync"}
              </p>
              {mirror.activeAt &&
              (!mirror.completedAt || mirror.activeAt > mirror.completedAt) ? (
                <Badge variant="radar">Newer snapshot incomplete</Badge>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>
      <Card className="gap-3 py-4">
        <CardHeader className="gap-1">
          <CardTitle>
            <h2>Recent runs</h2>
          </CardTitle>
          <CardDescription>Run times in {timezone}</CardDescription>
        </CardHeader>
        <CardContent>
          {runs.length ? (
            <ul className="divide-y">
              {runs.map((run) => (
                <li key={run.id}>
                  <Run run={run} when={when} />
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState compact title="No scheduled runs recorded yet." />
          )}
        </CardContent>
      </Card>
    </main>
  );
}

function Run({
  run,
  when,
}: {
  run: DailyRunView;
  when: (at: string) => string;
}) {
  const summary = runSummary(run);
  return (
    <div className="flex flex-col gap-1 py-2.5 text-sm">
      {/* One line per run: when, how it went, and for which reading day. */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 sm:grid-cols-[14.5rem_minmax(0,1fr)_auto]">
        <span className="font-medium tabular-nums max-sm:col-span-2">
          {when(run.startedAt)}
        </span>
        <span className="flex min-w-0 items-baseline gap-2">
          <span
            aria-hidden="true"
            className={cn(
              "size-2 shrink-0 translate-y-[-1px] rounded-full",
              summary.tone === "ok"
                ? "bg-good"
                : summary.tone === "warn"
                  ? "bg-late"
                  : "bg-destructive",
            )}
          />
          <span className="min-w-0">
            {summary.text}
            <span className="text-muted-foreground">
              {" "}
              · for{" "}
              <time dateTime={run.targetDay}>{formatDay(run.targetDay)}</time>
            </span>
          </span>
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {run.rowsWritten !== null
            ? `${countOf(run.rowsWritten, "row")} written`
            : ""}
        </span>
      </div>
      {run.steps ? (
        <details className="text-xs sm:ml-[calc(14.5rem+1rem)]">
          <summary className="w-fit cursor-pointer text-muted-foreground">
            Steps
            {run.finishedAt ? ` · finished ${when(run.finishedAt)}` : ""}
          </summary>
          <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
            {(Object.keys(runSteps) as (keyof typeof runSteps)[]).map(
              (name) => {
                const step = run.steps![name];
                return (
                  <div
                    key={name}
                    className="flex flex-wrap items-center gap-1.5 text-xs"
                  >
                    <dt className="font-medium">{runSteps[name]}</dt>
                    <dd>
                      <Badge
                        variant={
                          step.status === "failed"
                            ? "destructive"
                            : step.status === "paused"
                              ? "radar"
                              : "outline"
                        }
                      >
                        {step.status}
                      </Badge>
                    </dd>
                    {step.client ? (
                      <dd className="text-subtle">
                        {clients[step.client]}
                        {step.fallback ? " (fallback)" : ""}
                      </dd>
                    ) : null}
                    {step.error ? (
                      <dd className="text-subtle">
                        {step.error === "budget" && step.client === "api"
                          ? "Budget reached"
                          : errorLabels[step.error]}
                      </dd>
                    ) : null}
                  </div>
                );
              },
            )}
          </dl>
        </details>
      ) : null}
    </div>
  );
}

/** Health's small tiles share the calendar's look: a thin inset outline. */
const tile =
  "gap-2 rounded-sm border-0 py-3 shadow-none ring-1 ring-border ring-inset";

const judged = new Set(["on-time", "late", "missed"]);
const startDay = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

/** "4 of 5 listing days late, 1 missed": the larger count leads. */
function deliveryCounts(listing: HealthData["days"], since: boolean) {
  const missed = listing.filter((day) => day.status === "missed").length;
  const late = listing.filter((day) => day.status === "late").length;
  const total = since
    ? countOf(listing.length, "listing day")
    : `the last ${countOf(listing.length, "listing day")}`;
  const [lead, other] = (
    [
      [missed, "missed"],
      [late, "late"],
    ] as const
  )
    .filter(([count]) => count > 0)
    .sort((a, b) => b[0] - a[0]);
  if (!lead) return `${total} on time`;
  return `${formatCount(lead[0])} of ${total} ${lead[1]}${other ? `, ${formatCount(other[0])} ${other[1]}` : ""}`;
}

/** One sentence: are digests arriving, and did the last run stop early?
 * Only days since LitScout's first run count; earlier days were the old
 * pipeline's. */
function StatusLine({
  days,
  runs,
  firstRunDay,
}: Pick<HealthData, "days" | "runs" | "firstRunDay">) {
  if (firstRunDay === null)
    return (
      <p className="text-sm">
        <b className="font-semibold">Not started.</b>{" "}
        <span className="text-subtle">LitScout has no recorded runs yet.</span>
      </p>
    );
  const listing = days.filter((day) => judged.has(day.status));
  // Say the start only when it falls inside the 30 days shown.
  const since = firstRunDay > days[0]!.day;
  const lastRun = runs.find((run) => run.steps);
  const stopped =
    lastRun?.steps &&
    Object.entries(lastRun.steps).find(
      ([name, step]) =>
        name !== "legacy" &&
        (step.status === "paused" || step.status === "failed"),
    );
  const sentence = `${deliveryCounts(listing, since)}${stopped ? `; the last run's ${stopped[0]} step ${stopped[1].status === "paused" ? "paused" : "failed"}` : ""}.`;
  const problem = since
    ? `Since LitScout started on ${startDay.format(new Date(firstRunDay + "T00:00:00Z"))}: ${sentence}`
    : sentence[0]!.toUpperCase() + sentence.slice(1);
  const recent = listing.slice(-5);
  const ok = !stopped && recent.every((day) => day.status === "on-time");
  return (
    <p className="flex items-baseline gap-2.5 text-sm">
      <span
        aria-hidden="true"
        className={cn(
          "size-2 shrink-0 translate-y-[-1px] rounded-full",
          ok ? "bg-good" : "bg-late",
        )}
      />
      <span>
        <b className="font-semibold">{ok ? "All good." : "Needs attention."}</b>{" "}
        <span className="text-subtle">
          {!ok
            ? problem
            : recent.length
              ? `The last ${countOf(recent.length, "digest")} arrived on time.`
              : "No listing days since LitScout started yet."}
        </span>
      </span>
    </p>
  );
}

const stageNames = ["fetch", "summaries", "digest", "sync"] as const;
const stageStatus = {
  done: "Done",
  skipped: "Skipped",
  pending: "Pending",
  paused: "Paused",
  failed: "Failed",
};
const stageStyle: Record<string, string> = {
  done: "bg-good text-on-good",
  paused:
    "text-foreground ring-[1.5px] ring-late ring-inset bg-[linear-gradient(to_top,var(--late)_42%,transparent_42%)]",
  failed: "text-subtle ring-[1.5px] ring-missed ring-inset",
  pending: "bg-control text-muted-foreground",
  skipped: "bg-control text-muted-foreground",
};

/** The last run's four stages as cells, like the calendar. */
function LastRunTile({ runs }: Pick<HealthData, "runs">) {
  const run = runs.find((item) => item.steps);
  return (
    <Card className={tile}>
      <CardHeader className="gap-1">
        <CardTitle>
          <h2>Last run</h2>
        </CardTitle>
        <CardDescription>
          {run ? `For ${run.targetDay}` : "No completed run yet"}
        </CardDescription>
      </CardHeader>
      {run?.steps && (
        <CardContent>
          {/* One step per row: the name and its status stacked beside the
              cell, so long names never run into each other. */}
          <ol
            aria-label="Last run stages"
            className="m-0 grid list-none gap-1.5 p-0 text-xs"
          >
            {stageNames.map((name) => {
              const status = run.steps![name].status;
              return (
                <li key={name} className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className={cn(
                      "grid size-7 shrink-0 place-items-center rounded-xs",
                      stageStyle[status],
                    )}
                  >
                    {status === "done"
                      ? "✓"
                      : status === "paused"
                        ? "◷"
                        : status === "failed"
                          ? "×"
                          : "–"}
                  </span>
                  <span className="flex min-w-0 flex-col leading-tight">
                    <span className="font-medium">{stepLabels[name]}</span>
                    <span className="text-muted-foreground">
                      {stageStatus[status]}
                    </span>
                  </span>
                </li>
              );
            })}
          </ol>
        </CardContent>
      )}
    </Card>
  );
}
