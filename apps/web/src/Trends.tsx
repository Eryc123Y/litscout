import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { PanelLink } from "./SidePanel";
import { useSearchParams } from "react-router";
import {
  shiftMonth,
  trendMonth,
  trendsPath,
  trendsQuery,
  trendsResponse,
  trendsPaperPageSize,
  risingMinimumDays,
  type TrendsResponse,
} from "@litscout/pipeline/trends-contracts";
import { formatMonth } from "@litscout/pipeline/display-time";
import type { InstanceInfo } from "@litscout/pipeline/web-contracts";
import { apiGet } from "./api";
import { countOf, formatCount } from "./format";
import { today } from "./model";
import { QueryState } from "./Notice";
import { PageHeader } from "./PageHeader";
import { EmptyState } from "./ReaderState";
import { Button } from "./components/ui/button";
import {
  NativeSelect,
  NativeSelectOption,
} from "./components/ui/native-select";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { MathText } from "./math-text";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "./lib/utils";
import {
  ColumnChart,
  Meter,
  RankedBars,
  SegmentedBar,
  changeText,
} from "./trend-charts";

type Detail = NonNullable<TrendsResponse["detail"]>;

export function Trends({ instance }: { instance: InstanceInfo }) {
  const [search, setSearch] = useSearchParams();
  const currentMonth = today(instance.timezone).slice(0, 7);
  const requested = trendsQuery.safeParse(Object.fromEntries(search)).data;
  const pickedTopic = requested?.topic;
  const topic =
    pickedTopic && instance.topics.includes(pickedTopic)
      ? pickedTopic
      : instance.topics[0];
  const month =
    requested?.month && requested.month <= currentMonth
      ? requested.month
      : currentMonth;
  const pickOffset = requested?.pickOffset ?? 0;
  const activityOffset = requested?.activityOffset ?? 0;
  const params = new URLSearchParams({ month, ...(topic && { topic }) });
  const query = useQuery<TrendsResponse>({
    queryKey: ["trends", topic, month, pickOffset, activityOffset],
    enabled: Boolean(topic),
    // Another month, topic or page keeps the one on screen until its answer
    // is in: the page changes once, with no loading step between.
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => {
      const filters = new URLSearchParams(params);
      if (pickOffset) filters.set("pickOffset", String(pickOffset));
      if (activityOffset) filters.set("activityOffset", String(activityOffset));
      return apiGet(trendsPath + "?" + filters, trendsResponse, signal);
    },
  });
  const select = (value: { month: string; topic?: string }) =>
    setSearch(
      new URLSearchParams({
        month: value.month,
        ...(value.topic && { topic: value.topic }),
      }),
    );
  const page = (name: "pickOffset" | "activityOffset", offset: number) => {
    const next = new URLSearchParams(params);
    if (pickOffset) next.set("pickOffset", String(pickOffset));
    if (activityOffset) next.set("activityOffset", String(activityOffset));
    if (offset) next.set(name, String(offset));
    else next.delete(name);
    setSearch(next, { preventScrollReset: true });
  };
  const detail = query.data?.detail;
  // The month the numbers on screen belong to (the last one, while the next
  // loads).
  const shownMonth = query.data?.month ?? month;
  return (
    <main
      id="main"
      className="reader-page min-w-0"
      aria-busy={Boolean(topic) && query.isFetching}
    >
      <PageHeader
        title="Trends"
        description="Monthly reading activity and recurring research terms by topic."
      />
      {topic ? (
        <>
          <div className="flex flex-wrap gap-x-4 gap-y-3">
            <div className="grid min-w-0 gap-1.5 text-sm font-medium">
              <label htmlFor="trends-topic">Topic</label>
              <NativeSelect
                id="trends-topic"
                value={topic}
                className="min-h-11"
                onChange={(event) =>
                  select({ month, topic: event.target.value })
                }
              >
                {[...new Set(instance.topics)].map((name) => (
                  <NativeSelectOption key={name} value={name}>
                    {name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <fieldset className="m-0 min-w-0 border-0 p-0">
              <legend className="mb-1.5 p-0 text-sm font-medium">Month</legend>
              <div className="flex items-end gap-1">
                <Button
                  type="button"
                  variant="secondary"
                  size="icon"
                  aria-label="Previous month"
                  className="min-h-11 min-w-11"
                  onClick={() =>
                    select({ month: shiftMonth(month, -1), topic })
                  }
                >
                  <ChevronLeft aria-hidden="true" />
                </Button>
                <input
                  type="month"
                  aria-label="Month"
                  value={month}
                  min="0001-01"
                  max={currentMonth}
                  className="min-h-11 rounded-md border border-input bg-card px-3 text-sm focus-visible:outline-ring"
                  onChange={(event) => {
                    const next = trendMonth.safeParse(event.target.value);
                    if (next.success && next.data <= currentMonth)
                      select({ month: next.data, topic });
                  }}
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="icon"
                  aria-label="Next month"
                  className="min-h-11 min-w-11"
                  disabled={month >= currentMonth}
                  onClick={() => select({ month: shiftMonth(month, 1), topic })}
                >
                  <ChevronRight aria-hidden="true" />
                </Button>
              </div>
            </fieldset>
          </div>
          {query.isPending || query.isError ? (
            <QueryState
              query={query}
              label="Loading trends…"
              errorTitle="Trends unavailable"
            />
          ) : (
            <>
              {/* The month first, so its numbers below are read as its own. */}
              <h2 className="text-lg font-semibold">
                {formatMonth(shownMonth)}
              </h2>
              <Overview
                data={query.data}
                onMonth={(value) => select({ month: value, topic })}
              />
              {query.data.history.length > 0 && (
                <details className="rounded-lg bg-card">
                  <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
                    Show as table
                  </summary>
                  <div className="border-t p-2">
                    <MonthlyTotals
                      data={query.data}
                      onMonth={(value) => select({ month: value, topic })}
                    />
                  </div>
                </details>
              )}
              {detail ? (
                <section
                  aria-label="Selected month"
                  className="grid min-w-0 gap-4"
                >
                  <div className="grid min-w-0 gap-4 xl:grid-cols-2">
                    <TermList
                      title="Recurring terms"
                      terms={detail.recurring}
                      params={params}
                    />
                    <TermList
                      title="Rising terms"
                      terms={detail.rising}
                      params={params}
                      {...risingBaseline(detail)}
                    />
                    <TrendPapers
                      title="Digest picks"
                      papers={detail.picks}
                      offset={pickOffset}
                      nextOffset={detail.nextPickOffset}
                      onPage={(value) => page("pickOffset", value)}
                      busy={query.isFetching}
                    />
                    <TrendPapers
                      title="Saved and rated papers"
                      papers={detail.activity}
                      offset={activityOffset}
                      nextOffset={detail.nextActivityOffset}
                      onPage={(value) => page("activityOffset", value)}
                      busy={query.isFetching}
                    />
                  </div>
                </section>
              ) : (
                <EmptyState
                  title={`No trends for ${formatMonth(shownMonth)}`}
                  description={
                    shownMonth === currentMonth
                      ? "This month will appear with the first refresh after a daily digest."
                      : "The first refresh after a daily digest prepares the current month. Earlier months appear as backfill completes."
                  }
                />
              )}
            </>
          )}
        </>
      ) : (
        <EmptyState
          title="No topics configured"
          description="Add a topic to LitScout’s configuration. The first month will appear after the next digest and trends refresh."
        />
      )}
    </main>
  );
}

function MonthlyTotals({
  data,
  onMonth,
}: {
  data: TrendsResponse;
  onMonth: (month: string) => void;
}) {
  const months = Array.from({ length: 12 }, (_, index) =>
    shiftMonth(data.currentMonth, -index),
  );
  const totals = new Map(data.history.map((row) => [row.month, row]));
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>
          <h2>Monthly totals</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div
          role="region"
          aria-label="Monthly totals"
          tabIndex={0}
          className="max-w-full overflow-x-auto rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
        >
          <table className="w-full text-sm tabular-nums">
            <thead>
              <tr className="border-b">
                <th
                  scope="col"
                  className="sticky left-0 bg-card py-2 pr-3 text-left"
                >
                  <span className="sr-only">Metric</span>
                </th>
                {months.map((month) => (
                  <th
                    key={month}
                    scope="col"
                    className={data.month === month ? "bg-accent" : undefined}
                  >
                    <Button
                      variant="ghost"
                      aria-current={data.month === month ? "true" : undefined}
                      className="min-h-11 whitespace-nowrap px-2 text-xs text-primary md:min-h-8"
                      onClick={() => onMonth(month)}
                    >
                      <span className="whitespace-nowrap">
                        {formatMonth(month, true)}
                      </span>
                    </Button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {(
                [
                  ["Papers", "volume"],
                  ["Picks", "picks"],
                  ["Radar hits", "radarHits"],
                ] as const
              ).map(([label, metric]) => (
                <tr key={metric}>
                  <th
                    scope="row"
                    className="sticky left-0 bg-card py-2 pr-3 text-left font-medium whitespace-nowrap"
                  >
                    {label}
                  </th>
                  {months.map((month) => {
                    const value = totals.get(month)?.[metric];
                    return (
                      <td
                        key={month}
                        className={
                          month === data.month
                            ? "bg-accent px-2 text-center"
                            : "px-2 text-center"
                        }
                      >
                        {value === undefined ? (
                          <span aria-label="Refresh pending">—</span>
                        ) : (
                          formatCount(value)
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

const monthName = new Intl.DateTimeFormat("en-GB", {
  month: "long",
  timeZone: "UTC",
});
const shortDay = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});
const dayLabel = (day: string) => shortDay.format(new Date(day + "T00:00:00Z"));

/** What rising terms compare with, or why last month is too thin to say. */
function risingBaseline({
  month,
  comparison,
}: Pick<Detail, "month" | "comparison">) {
  // Rows written before the comparison was recorded keep their list.
  if (!comparison) return {};
  const name = monthName.format(
    new Date(shiftMonth(month, -1) + "-01T00:00:00Z"),
  );
  if (comparison.days < risingMinimumDays)
    return {
      hidden: true,
      note: `Rising terms need at least ${risingMinimumDays} days of last month; ${name} has ${comparison.days}.`,
    };
  const range =
    comparison.first === comparison.last
      ? dayLabel(comparison.first!)
      : `${dayLabel(comparison.first!)}–${dayLabel(comparison.last!)}`;
  return {
    note: `Compared with ${comparison.days} days of ${name} (${range}).`,
  };
}

function TermList({
  title,
  terms,
  params,
  note,
  hidden = false,
}: {
  title: string;
  terms: Detail["recurring"];
  params: URLSearchParams;
  /** A line under the title: what the list compares with, or why it is hidden. */
  note?: string;
  hidden?: boolean;
}) {
  return (
    <Card className="min-w-0">
      <CardHeader>
        {/* Below the month heading, as small as the chart titles. */}
        <CardTitle className="text-sm font-semibold">
          <h3>{title}</h3>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {note && <p className="text-sm text-muted-foreground">{note}</p>}
        {hidden ? null : terms.length ? (
          <RankedBars
            items={terms.map(({ term, count }) => ({
              term,
              count,
              href: `/app/days?${new URLSearchParams({ ...Object.fromEntries(params), term })}`,
            }))}
          />
        ) : (
          <p className="text-sm text-muted-foreground">No terms yet.</p>
        )}
      </CardContent>
    </Card>
  );
}

function TrendPapers({
  title,
  papers,
  offset,
  nextOffset,
  busy,
  onPage,
}: {
  title: string;
  papers: (Detail["picks"][number] | Detail["activity"][number])[];
  offset: number;
  nextOffset: number | null;
  busy: boolean;
  onPage: (offset: number) => void;
}) {
  return (
    <Card className="min-w-0">
      <CardHeader>
        {/* Below the month heading, as small as the chart titles. */}
        <CardTitle className="text-sm font-semibold">
          <h3>{title}</h3>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {papers.length ? (
          <ul className="reader-list divide-y">
            {papers.map((paper) => (
              <li className="reader-row wrap-anywhere" key={paper.paperId}>
                {paper.title === null ? (
                  <span className="text-muted-foreground">
                    Paper unavailable
                  </span>
                ) : (
                  <PanelLink
                    target={{ kind: "paper", id: paper.paperId }}
                    className="font-medium text-primary"
                  >
                    <MathText text={paper.title} />
                  </PanelLink>
                )}
                {"saved" in paper && (
                  <p className="text-xs text-muted-foreground">
                    {[
                      paper.saved ? "Saved" : "",
                      paper.rating === "up"
                        ? "Rated up"
                        : paper.rating === "down"
                          ? "Rated down"
                          : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            No papers in this month.
          </p>
        )}
        {Boolean(offset || nextOffset) && (
          <div className="mt-3 flex flex-wrap gap-2">
            {offset > 0 && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  onPage(Math.max(0, offset - trendsPaperPageSize))
                }
              >
                Previous papers
              </Button>
            )}
            {nextOffset !== null && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => onPage(nextOffset)}
              >
                More papers
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const radarSegments = (detail: Detail) => [
  {
    label: "High",
    value: detail.radar.high,
    className: "bg-radar text-on-radar",
  },
  {
    label: "Medium",
    value: detail.radar.medium,
    className: "bg-radar-mid text-on-radar-mid",
  },
  {
    label: "Borrow",
    value: detail.radar.borrow,
    className: "bg-radar-low text-on-radar-low",
  },
];

/** The selected month said once (papers, share on the reader's topics, radar
 * grades, picks, saves), then papers and radar hits over twelve months.
 * Picks are a handful a month, so they stay a number. Nothing is charted
 * before the first month is refreshed. */
function Overview({
  data,
  onMonth,
}: {
  data: TrendsResponse;
  onMonth: (month: string) => void;
}) {
  const months = Array.from({ length: 12 }, (_, index) =>
    shiftMonth(data.currentMonth, index - 11),
  );
  const totals = new Map(data.history.map((row) => [row.month, row]));
  const detail = data.detail;
  const previous = totals.get(shiftMonth(data.month, -1));
  const previousLabel = formatMonth(shiftMonth(data.month, -1), true).split(
    " ",
  )[0]!;
  const column = (metric: "volume" | "radarHits") =>
    months.map((month) => ({
      month,
      label: formatMonth(month, true),
      value: totals.get(month)?.[metric],
    }));
  return (
    <section aria-label="Overview" className="flex min-w-0 flex-col gap-3">
      {detail && (
        <MonthSummary
          month={data.month}
          detail={detail}
          change={changeText(detail.volume, previous?.volume, previousLabel)}
        />
      )}
      {data.history.length > 0 && (
        <div className="grid gap-3 lg:grid-cols-2">
          <ColumnChart
            title="Papers per month"
            noun={(value) => countOf(value, "paper")}
            columns={column("volume")}
            selected={data.month}
            onSelect={onMonth}
          />
          <ColumnChart
            title="Radar hits per month"
            noun={(value) => countOf(value, "radar hit")}
            columns={column("radarHits")}
            selected={data.month}
            onSelect={onMonth}
          />
        </div>
      )}
    </section>
  );
}

function MonthSummary({
  month,
  detail,
  change,
}: {
  month: string;
  detail: Detail;
  change: string | null;
}) {
  const share = detail.volume ? detail.shortlisted / detail.volume : 0;
  const radar = detail.radar.high + detail.radar.medium + detail.radar.borrow;
  return (
    <section
      aria-label={`${formatMonth(month)} summary`}
      className="grid min-w-0 gap-x-10 gap-y-5 rounded-xl border bg-card p-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]"
    >
      <div className="flex min-w-0 flex-col gap-1.5">
        <p className="m-0 flex items-baseline gap-2">
          <span className="text-4xl leading-none font-semibold tracking-tight tabular-nums">
            {formatCount(detail.volume)}
          </span>
          <span className="text-sm text-subtle">papers</span>
        </p>
        {change && <p className="m-0 text-sm text-subtle">{change}</p>}
        <div className="mt-2 flex max-w-72 flex-col gap-1.5">
          <Meter share={share} />
          <p className="m-0 text-xs text-subtle tabular-nums">
            {formatCount(detail.shortlisted)} on your topics (
            {Math.round(100 * share)}%)
          </p>
        </div>
      </div>
      <dl className="m-0 grid min-w-0 gap-x-8 gap-y-4 sm:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <dt className="text-xs font-semibold text-subtle">Radar hits</dt>
          <dd className="m-0 text-2xl leading-none font-semibold tabular-nums">
            {formatCount(radar)}
          </dd>
          <dd className="m-0">
            <SegmentedBar segments={radarSegments(detail)} />
          </dd>
          {radar > 0 && (
            <dd className="m-0">
              <ul
                aria-label="Radar grades"
                className="m-0 flex list-none flex-wrap gap-x-3 gap-y-0.5 p-0 text-xs text-subtle"
              >
                {radarSegments(detail)
                  .filter((segment) => segment.value > 0)
                  .map((segment) => (
                    <li
                      key={segment.label}
                      className="flex items-center gap-1.5"
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          "size-2 rounded-[2px]",
                          segment.className,
                        )}
                      />
                      {formatCount(segment.value)} {segment.label.toLowerCase()}
                    </li>
                  ))}
              </ul>
            </dd>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <dt className="text-xs font-semibold text-subtle">Digest picks</dt>
          <dd className="m-0 text-2xl leading-none font-semibold tabular-nums">
            {formatCount(detail.pickCount)}
          </dd>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <dt className="text-xs font-semibold text-subtle">Your activity</dt>
          <dd className="m-0 text-2xl leading-none font-semibold tabular-nums">
            {formatCount(detail.saveCount)}
            <span className="ml-1.5 text-sm font-normal text-subtle">
              saved
            </span>
          </dd>
          <dd className="m-0 text-xs text-subtle">
            {countOf(detail.ratingCount, "rating")}
          </dd>
        </div>
      </dl>
    </section>
  );
}
