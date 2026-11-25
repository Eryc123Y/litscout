import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { trendSearchQuery } from "@litscout/pipeline/trends-contracts";
import { TrendSearch } from "./TrendSearch";
import type { WebDay } from "@litscout/pipeline/web-contracts";
import { useDays } from "./api";
import { dayLabels, today } from "./model";
import { Notice } from "./Notice";
import { Calendar } from "./components/ui/calendar";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "./components/ui/card";
import { PageHeader } from "./PageHeader";
import { EmptyState } from "./ReaderState";
import { countOf, formatCount, formatDay } from "./format";
const dayButtonDate = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});
type DaysProps = { isPublic: boolean; timezone: string; keywordOnly?: boolean };

export function Days(props: DaysProps) {
  const [search] = useSearchParams();
  const filter = trendSearchQuery.safeParse(Object.fromEntries(search));
  return !props.isPublic && filter.success ? (
    <TrendSearch {...filter.data} />
  ) : (
    <DayArchive {...props} />
  );
}

function DayArchive({ isPublic, timezone, keywordOnly = false }: DaysProps) {
  const base = isPublic ? "/public" : "/app",
    navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const before = search.get("before") ?? undefined;
  const setBefore = (value?: string) => {
    const next = new URLSearchParams(search);
    if (value) next.set("before", value);
    else next.delete("before");
    setSearch(next);
  };
  const days = useDays(isPublic, before);
  const current = today(timezone),
    [month, setMonth] = useState(() => new Date(`${current}T12:00:00`));
  if (days.isPending || days.isError)
    return (
      <Notice
        query={days}
        title="Days"
        description="A reading archive, one day at a time."
        label="Loading days…"
        errorTitle="Days unavailable"
      />
    );
  const statuses = dayLabels(days.data.items, keywordOnly, !before);
  // Calendar marks: a day with a digest, and a day with papers but none.
  // Keyword mode writes no digest, so every listed day counts as ready.
  const noon = (day: string) => new Date(`${day}T12:00:00`);
  const listed = days.data.items.filter((d) => d.counts.total > 0);
  const ready = (d: WebDay) =>
    keywordOnly || d.status === "digested" || d.status === "final";
  const marks = {
    digest: listed.filter(ready).map((d) => noon(d.day)),
    listing: listed.filter((d) => !ready(d)).map((d) => noon(d.day)),
  };
  return (
    <main id="main" aria-busy={days.isFetching} className="reader-page">
      <PageHeader
        title="Days"
        description="A reading archive, one day at a time."
        actions={
          <Button asChild variant="outline" className="max-md:hidden">
            <Link to={`${base}/today`}>Back to Today</Link>
          </Button>
        }
      />
      <div className="grid items-start gap-5 xl:grid-cols-[340px_minmax(0,1fr)]">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>
              <h2>Choose a day</h2>
            </CardTitle>
            <CardDescription>
              Open any date, including days still awaiting an announcement.
            </CardDescription>
          </CardHeader>
          <CardContent className="max-md:px-2">
            <section aria-label="Calendar">
              <Calendar
                className="w-full p-0 [--cell-size:clamp(28px,4vw,36px)] max-md:[--cell-size:44px]"
                mode="single"
                month={month}
                onMonthChange={setMonth}
                weekStartsOn={1}
                modifiers={marks}
                modifiersClassNames={{
                  digest: "day-digest",
                  listing: "day-listing",
                }}
                today={new Date(`${current}T12:00:00`)}
                onSelect={(date) => {
                  if (date) navigate(`${base}/days/${localDate(date)}`);
                }}
                labels={{
                  labelPrevious: () => "Previous month",
                  labelNext: () => "Next month",
                  // Lead with the visible day number (WCAG 2.5.3).
                  labelDayButton: (date) =>
                    `${dayButtonDate.format(date)}: ${statuses.get(localDate(date)) ?? "Status not loaded"}`,
                }}
              />
              <ul
                aria-label="Calendar marks"
                className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"
              >
                <li className="day-mark day-mark-digest">
                  {keywordOnly ? "Papers listed" : "Digest ready"}
                </li>
                {keywordOnly ? null : (
                  <li className="day-mark day-mark-listing">
                    Papers, no digest
                  </li>
                )}
              </ul>
            </section>
          </CardContent>
        </Card>
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>
              <h2>{before ? "Earlier listings" : "Recent listings"}</h2>
            </CardTitle>
            <CardDescription>
              {isPublic
                ? "Papers on the feed's topics, day by day."
                : "Papers on your topics, and how many are left to read."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {days.data.items.length ? (
              <DayList
                days={days.data.items}
                base={base}
                statuses={statuses}
                keywordOnly={keywordOnly}
              />
            ) : (
              <EmptyState
                compact
                title="No recorded days"
                description="Choose a date in the calendar to check its announcement."
              />
            )}
            <div className="mt-5 flex flex-wrap gap-2">
              {days.data.nextBefore ? (
                <Button
                  variant="outline"
                  disabled={days.isFetching}
                  onClick={() => setBefore(days.data.nextBefore!)}
                >
                  Older days
                </Button>
              ) : null}
              {before ? (
                <Button variant="ghost" onClick={() => setBefore(undefined)}>
                  Back to recent days
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
function localDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function DayList({
  days,
  base,
  statuses,
  keywordOnly,
}: {
  days: WebDay[];
  base: string;
  statuses: ReadonlyMap<string, string>;
  keywordOnly: boolean;
}) {
  return (
    <ul className="reader-list divide-y">
      {days.map((day) => (
        <li
          key={day.day}
          className="reader-row flex flex-wrap items-center gap-3"
        >
          <div className="flex min-w-40 flex-1 flex-col gap-1">
            <Link
              className="font-medium text-primary"
              to={`${base}/days/${day.day}`}
            >
              <time dateTime={day.day}>{formatDay(day.day)}</time>
            </Link>
            <DayCounts counts={day.counts} keywordOnly={keywordOnly} />
          </div>
          <Badge variant="secondary">{statuses.get(day.day)}</Badge>
        </li>
      ))}
    </ul>
  );
}
/** A day in one line, in the day page's own words: the papers on the
 * reader's topics, then what is left to read (signed in) or the size of the
 * listing. */
function DayCounts({
  counts,
  keywordOnly,
}: {
  counts: WebDay["counts"];
  keywordOnly: boolean;
}) {
  if (!counts.total)
    return (
      <span className="text-xs text-muted-foreground">No papers listed</span>
    );
  const matched = counts.shortlisted ?? 0;
  const listing = `${formatCount(counts.total)} in the listing`;
  if (!matched)
    return (
      <span className="text-xs text-muted-foreground">
        {keywordOnly
          ? "No keyword matches yet"
          : "No papers on your topics yet"}{" "}
        · {listing}
      </span>
    );
  const label = keywordOnly
    ? countOf(matched, "keyword match", "keyword matches")
    : `${countOf(matched, "paper")} on your topics`;
  if (counts.read === undefined)
    return (
      <span className="text-xs text-muted-foreground">
        {label} · {listing}
      </span>
    );
  const read = Math.min(counts.read, matched);
  const left = matched - read;
  return (
    <>
      <span className="text-xs text-muted-foreground">
        {label} · {left ? `${formatCount(left)} unread` : "all read"}
      </span>
      <progress
        className="meter day-meter"
        value={read}
        max={matched}
        aria-label={`${formatCount(read)} of ${formatCount(matched)} read`}
      />
    </>
  );
}
