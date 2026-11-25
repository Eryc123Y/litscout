import type { ListPaper } from "@litscout/pipeline/read-contracts";
import {
  Fragment,
  memo,
  useEffect,
  useRef,
  type MouseEvent,
  type RefObject,
} from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { readOrigin } from "./origin";
import { useDays } from "./api";
import type { WebFeed, WebPaper } from "@litscout/pipeline/web-contracts";
import { Paper } from "./Paper";
import { dayLabel } from "./model";
import { TopicLabel } from "./TopicLabel";
import { Button } from "./components/ui/button";
import {
  EmptyState,
  PageAnnouncements,
  usePageAnnouncement,
} from "./ReaderState";
import { PageHeader } from "./PageHeader";
import { TopBarActions, useTopBar } from "./AppShell";
import { usePhoneLayout } from "./useMediaQuery";
import { countOf, formatCount, formatDay, relativeDay } from "./format";
import { Badge } from "./components/ui/badge";
import {
  ArrowLeft,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import type { ReactNode } from "react";
import { MathText } from "./math-text";
import { decisionLabels, decisionOf } from "./decisions";
/** Why the brief chose a paper, for its row. */
export type BriefMark = "radar" | "pick";
export function DayHeading({
  feed,
  base,
  today,
  search,
  keywordOnly,
  onIntent,
}: {
  feed: WebFeed;
  base: string;
  /** Today in the instance's time zone, to say how old this listing is. */
  today?: string;
  search: ReactNode;
  keywordOnly?: boolean;
  /** The pointer or focus is on the link to this day: a good moment to
   * fetch it, so the page opens with no loading step. */
  onIntent?: (day: string) => void;
}) {
  const date = new Date(`${feed.day}T12:00:00Z`);
  const adjacent = (delta: number) =>
    new Date(date.getTime() + delta * 86400000).toISOString().slice(0, 10);
  /** Handlers for a Previous / Next link; none for a day after today. */
  const intent = (delta: number) => {
    const day = adjacent(delta);
    if (!onIntent || (today && day > today)) return {};
    const fetch = () => onIntent(day);
    return { onPointerEnter: fetch, onFocus: fetch };
  };
  const phone = usePhoneLayout();
  // One count everywhere: the papers on the reader's topics, which the list
  // shows ("All N"). The whole listing comes second, and not on a phone.
  const matched = keywordOnly
    ? countOf(feed.counts.shortlisted, "keyword match", "keyword matches")
    : `${countOf(feed.counts.shortlisted, "paper")} on your topics`;
  const parts = [
    matched,
    ...(phone ? [] : [`${formatCount(feed.counts.total)} in the listing`]),
    dayLabel(feed.status, keywordOnly),
  ];
  const summary = parts.join(" · ");
  const announce = usePageAnnouncement();
  useEffect(() => {
    announce?.(summary);
  }, [announce, summary]);
  const topBar = useTopBar();
  const chooseDay = (
    <Button
      asChild
      variant="outline"
      className="text-foreground max-md:w-11 max-md:px-0"
    >
      <Link to={`${base}/days`}>
        <CalendarDays data-icon="inline-start" />
        <span className="max-md:sr-only">Choose a day</span>
      </Link>
    </Button>
  );
  const dayActions = (
    <>
      {search}
      {chooseDay}
    </>
  );
  return (
    <>
      {/* Desktop: search and Choose a day sit in the top bar. Phone: search
          sits in the header and the day is chosen from the date switcher. */}
      {topBar && <TopBarActions>{phone ? search : dayActions}</TopBarActions>}
      <PageHeader
        className="listing-header"
        title={formatDay(feed.day, "heading")}
        description={
          <>
            {/* Each phrase keeps its words together in a narrow column. */}
            {parts.map((part, index) => (
              <Fragment key={part}>
                {index > 0 && " · "}
                <span data-slot="summary-part" className="whitespace-nowrap">
                  {part}
                </span>
              </Fragment>
            ))}
            {base === "/public" && (
              <>
                {" "}
                · <span>Public feed · Read only</span>
              </>
            )}
          </>
        }
        context={
          phone ? (
            <nav
              aria-label="Day"
              className="flex w-full items-center justify-between rounded-md bg-control p-0.5"
            >
              <Button asChild variant="ghost" size="icon">
                <Link
                  to={`${base}/days/${adjacent(-1)}`}
                  aria-label="Previous day"
                  {...intent(-1)}
                >
                  <ChevronLeft />
                </Link>
              </Button>
              <Button asChild variant="ghost" className="text-foreground">
                <Link
                  to={`${base}/days`}
                  aria-label={`Choose a day, listing date ${formatDay(feed.day)}`}
                >
                  <CalendarDays data-icon="inline-start" />
                  <time dateTime={feed.day}>{formatDay(feed.day)}</time>
                </Link>
              </Button>
              <Button asChild variant="ghost" size="icon">
                <Link
                  to={`${base}/days/${adjacent(1)}`}
                  aria-label="Next day"
                  {...intent(1)}
                >
                  <ChevronRight />
                </Link>
              </Button>
            </nav>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                asChild
                variant="outline"
                size="icon"
                className="text-foreground"
              >
                <Link
                  to={`${base}/days/${adjacent(-1)}`}
                  aria-label="Previous day"
                  {...intent(-1)}
                >
                  <ChevronLeft />
                </Link>
              </Button>
              <Button
                asChild
                variant="outline"
                size="icon"
                className="text-foreground"
              >
                <Link
                  to={`${base}/days/${adjacent(1)}`}
                  aria-label="Next day"
                  {...intent(1)}
                >
                  <ChevronRight />
                </Link>
              </Button>
              <span>
                Listing date ·{" "}
                <time dateTime={feed.day}>{formatDay(feed.day)}</time>
              </span>
              {today ? (
                <Badge variant="secondary">
                  {relativeDay(feed.day, today)}
                </Badge>
              ) : null}
            </div>
          )
        }
        // Without a top bar (tests, start-up) the actions stay in the header.
        actions={topBar ? undefined : dayActions}
      />
    </>
  );
}
export function FullPaper({
  paper,
  base,
  day,
  language,
  timezone,
  topics,
  keywordOnly,
}: {
  paper?: WebPaper;
  base: string;
  day?: string;
  language: string;
  timezone: string;
  topics: string[];
  keywordOnly?: boolean;
}) {
  return (
    <main id="main" className="reader-page">
      <PaperBreadcrumb base={base} day={day} />
      {paper ? (
        <PageAnnouncements key={paper.paperId}>
          <Paper
            paper={paper}
            language={language}
            timezone={timezone}
            topics={topics}
            privateActions={base === "/app"}
            keywordOnly={keywordOnly}
          />
        </PageAnnouncements>
      ) : (
        <>
          <PageHeader
            title="Paper not found in this day."
            description="Choose its original date in Days."
            actions={
              <Button asChild variant="outline">
                <Link to={`${base}/days`}>Choose a day</Link>
              </Button>
            }
          />
          <div className="reader-panel">
            <EmptyState compact title="This paper record is unavailable." />
          </div>
        </>
      )}
    </main>
  );
}
/** The reader column on a day with nothing yet: says so, and points to the
 * latest day that has a digest. */
export function EmptyDay({
  day,
  status,
  today,
  base,
  isPublic,
}: {
  day: string;
  status: string;
  today: string;
  base: string;
  isPublic: boolean;
}) {
  const days = useDays(isPublic);
  const latest = days.data?.items
    .filter(
      (item) =>
        item.day < day &&
        item.counts.total > 0 &&
        (item.status === "digested" || item.status === "final"),
    )
    .sort((a, b) => b.day.localeCompare(a.day))[0];
  return (
    <EmptyState
      compact
      title={
        status === "empty"
          ? "arXiv made no announcement for this day."
          : status !== "pending"
            ? "No papers on this day."
            : day === today
              ? "No papers yet today."
              : isPublic
                ? "No papers yet for this day."
                : "No papers or digest yet for this day."
      }
      // The list beside it explains when papers arrive.
      actions={
        latest ? (
          <Button asChild variant="outline">
            <Link to={`${base}/days/${latest.day}`}>
              Read {formatDay(latest.day, "heading")}
            </Link>
          </Button>
        ) : undefined
      }
    />
  );
}
type ListProps = {
  papers: ListPaper[];
  selected?: { paperId: string; source: string };
  language: string;
  topics: string[];
  status: string;
  keywordOnly?: boolean;
  hasMore?: boolean;
  /** "/app" or "/public": where the empty-day links point. */
  base?: string;
  /** One or two lines a paper instead of four, for a long day. */
  compact?: boolean;
  /** The papers the brief chose, by paper ID. */
  marks?: ReadonlyMap<string, BriefMark>;
  /** Said when the list is empty for a reason of the page's own. */
  emptyTitle?: string;
  onOpen: (paper: ListPaper, element?: HTMLButtonElement) => void;
  /** The reader is likely to open this paper next (the pointer rests on its
   * row, is pressed on it, or focus is there): time to fetch its record. */
  onIntent?: (paper: ListPaper) => void;
  listRef: RefObject<HTMLElement | null>;
};
export function PaperList(props: ListProps) {
  return (
    <section
      ref={props.listRef}
      tabIndex={-1}
      aria-label="Paper list"
      className="min-w-0 overflow-hidden rounded-lg border bg-card"
    >
      {props.papers.length ? (
        <ol className="flex flex-col gap-0.5 p-1.5">
          {props.papers.map((paper) => (
            <li key={`${paper.paperId}:${paper.source}`}>
              <PaperRow
                paper={paper}
                selected={
                  props.selected?.paperId === paper.paperId &&
                  props.selected.source === paper.source
                }
                language={props.language}
                topics={props.topics}
                keywordOnly={props.keywordOnly}
                onOpen={props.onOpen}
                onIntent={props.onIntent}
                compact={props.compact}
                mark={props.marks?.get(paper.paperId)}
              />
            </li>
          ))}
        </ol>
      ) : (
        <EmptyState
          title={
            props.emptyTitle
              ? props.emptyTitle
              : props.hasMore
                ? "No papers match on this page."
                : props.status === "pending"
                  ? "Waiting for an announcement."
                  : props.status === "empty"
                    ? "No announcement for this day."
                    : "No papers match these filters."
          }
          description={
            props.hasMore
              ? "Load more to keep searching."
              : props.status === "pending"
                ? "arXiv announces new papers on weekday evenings, US Eastern time. The next scheduled run fetches them and writes the digest."
                : "Choose another day or change the filters."
          }
          actions={
            props.status === "pending" && !props.hasMore ? (
              <div className="flex flex-wrap gap-2">
                <Button asChild>
                  <Link to={`${props.base ?? "/app"}/days`}>
                    Choose another day
                  </Link>
                </Button>
                {(props.base ?? "/app") === "/app" && (
                  <Button asChild variant="secondary">
                    <Link to="/app/library">Library</Link>
                  </Button>
                )}
              </div>
            ) : undefined
          }
        />
      )}
    </section>
  );
}
/** A row's second line: the TL;DR, or why there is none yet. */
export function rowLead(
  paper: Pick<ListPaper, "abstract" | "tldr" | "hasAbstract">,
  language: string,
  keywordOnly?: boolean,
) {
  if (keywordOnly) return paper.abstract;
  const tldr = (paper.tldr.find((s) => s.lang === language) ?? paper.tldr[0])
    ?.text;
  if (tldr) return tldr;
  return paper.hasAbstract === false
    ? "No abstract, so no summary"
    : "Summary pending";
}
const intentDwellMs = 100;
const rowAuthorsMax = 4;
/** Memoised: opening a paper redraws its row and the one it left, not all
 * two hundred. */
const PaperRow = memo(function PaperRow({
  paper,
  selected,
  language,
  topics,
  onOpen,
  onIntent,
  keywordOnly,
  compact,
  mark,
}: Pick<
  ListProps,
  "language" | "topics" | "onOpen" | "onIntent" | "keywordOnly" | "compact"
> & {
  paper: ListPaper;
  selected: boolean;
  mark?: BriefMark;
}) {
  // The pointer has to rest on a row briefly: passing over rows on the way
  // down the list fetches nothing.
  const dwell = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(dwell.current), []);
  const intent = onIntent && {
    onPointerEnter: () => {
      window.clearTimeout(dwell.current);
      dwell.current = window.setTimeout(() => onIntent(paper), intentDwellMs);
    },
    onPointerLeave: () => window.clearTimeout(dwell.current),
    onPointerDown: () => onIntent(paper),
    onFocus: () => onIntent(paper),
  };
  const lead = rowLead(paper, language, keywordOnly);
  // A row names four authors; the record it carries may name more.
  const shown = paper.authors.slice(0, rowAuthorsMax);
  const unread = paper.readingState?.readAt === null;
  const read = typeof paper.readingState?.readAt === "string";
  const decision = decisionOf(paper.readingState);
  const hasCode = paper.links?.some((link) => link.kind === "code");
  const signals = (
    <>
      {mark && (
        <Badge variant={mark === "radar" ? "radar" : "secondary"}>
          {mark === "radar" ? "Radar" : "Brief pick"}
        </Badge>
      )}
      {hasCode && <Badge variant="outline">Code</Badge>}
      {decision !== "none" && (
        <Badge variant={decision === "skipped" ? "outline" : "default"}>
          {decisionLabels[decision]}
        </Badge>
      )}
    </>
  );
  const rowProps = {
    "aria-description": unread ? "Unread" : read ? "Read" : undefined,
    "aria-current": selected ? ("true" as const) : undefined,
    // A read or skipped paper's row fades as a whole (style.css).
    "data-read": read || decision === "skipped" ? "" : undefined,
    onClick: (e: MouseEvent<HTMLButtonElement>) =>
      onOpen(paper, e.currentTarget),
    ...intent,
  };
  if (compact)
    return (
      <button
        {...rowProps}
        data-density="compact"
        className="reader-row grid w-full grid-cols-[minmax(0,1fr)] gap-y-0.5 rounded-sm px-2.5 text-left hover:bg-control aria-current:bg-row-on"
      >
        <strong className="line-clamp-2 font-serif text-[15px] leading-snug font-semibold">
          <span className="sr-only">Read </span>
          <MathText text={paper.title} />
        </strong>
        <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
          {paper.topics.map((topic) => (
            <TopicLabel topic={topic} topics={topics} key={topic} />
          ))}
          <span>{paper.venue ?? paper.source}</span>
          {signals}
        </span>
      </button>
    );
  return (
    <button
      {...rowProps}
      className="reader-row grid w-full grid-cols-[minmax(0,1fr)] gap-y-1 rounded-sm px-2.5 text-left hover:bg-control aria-current:bg-row-on"
    >
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {paper.topics.map((topic) => (
          <TopicLabel topic={topic} topics={topics} key={topic} />
        ))}
        {paper.hfUpvotes ? (
          <span className="text-xs text-muted-foreground">
            ▲ {formatCount(paper.hfUpvotes)} HF
          </span>
        ) : null}
        {signals}
      </span>
      <strong className="font-serif text-base leading-snug font-semibold">
        {/* The row's name comes from its visible text (WCAG 2.5.3). */}
        <span className="sr-only">Read </span>
        <MathText text={paper.title} />
      </strong>
      <span className="text-[13px] text-muted-foreground">
        {shown.map((a) => a.name).join(", ")}
        {paper.authorCount > shown.length
          ? ` +${formatCount(paper.authorCount - shown.length)}`
          : ""}{" "}
        · {paper.venue ?? paper.source}
      </span>
      {lead && (
        <span className="line-clamp-2 text-[13px] text-subtle lg:line-clamp-1">
          <MathText text={lead} />
        </span>
      )}
    </button>
  );
});

/** Where the full paper sits: the page it was opened from (with a way back
 * to that page as it was), or else Today and the paper's listing day. */
function PaperBreadcrumb({ base, day }: { base: string; day?: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const from = readOrigin(location.state);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <nav
        aria-label="Breadcrumb"
        className="flex flex-wrap gap-2 text-xs text-muted-foreground max-md:items-center"
      >
        {from ? (
          <>
            <Link to={from.path} className="text-primary">
              {from.label}
            </Link>
            <span aria-hidden="true">/</span>
          </>
        ) : (
          <>
            <Link to={`${base}/today`} className="text-primary">
              Today
            </Link>
            <span aria-hidden="true">/</span>
            {day ? (
              <>
                <Link to={`${base}/days/${day}`} className="text-primary">
                  <time dateTime={day}>{formatDay(day)}</time>
                </Link>
                <span aria-hidden="true">/</span>
              </>
            ) : null}
          </>
        )}
        <span>Paper</span>
      </nav>
      {from ? (
        // History back returns to the page as it was, scroll and panel included.
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
          <ArrowLeft data-icon="inline-start" />
          Back to {from.label}
        </Button>
      ) : null}
    </div>
  );
}
