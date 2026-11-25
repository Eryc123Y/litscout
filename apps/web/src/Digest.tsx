import { useId, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { radarProjectTitle } from "@litscout/pipeline/radar-project";
import { Link } from "react-router";
import type {
  WebFeed,
  DigestReference as Reference,
} from "@litscout/pipeline/web-contracts";
import type { useDigest } from "./api";
import { referenceKey, useDigestRows, type DigestRows } from "./useDigestRows";
import { digestSections } from "./digest-sections";
import { Suggestions } from "./Suggestions";
import { Markdown } from "./Markdown";
import { DigestPicks, referenceHref } from "./DigestPicks";
import { TopicLabel } from "./TopicLabel";
import { Card, CardHeader, CardTitle, CardContent } from "./components/ui/card";
import { EmptyState, LoadingState } from "./ReaderState";
import { formatCount, formatTimestamp } from "./format";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { cn } from "./lib/utils";
import { useMediaQuery } from "./useMediaQuery";
import { MathText, plainMath } from "./math-text";
const languageNames: Record<string, string> = { en: "English", zh: "Chinese" };
/** A note when the digest is not in the instance language, or null. */
export function digestLanguageNote(lang: string | undefined, language: string) {
  return lang && lang !== language
    ? "Written in " + (languageNames[lang] ?? lang)
    : null;
}

export function Digest({
  query,
  feed,
  topics,
  timezone,
  language = "en",
  inPane = false,
}: {
  query: Pick<ReturnType<typeof useDigest>, "isPending" | "error" | "data">;
  feed: WebFeed;
  topics: string[];
  timezone: string;
  language?: string;
  /** Shown in the reader column beside the list: one column, always open. */
  inPane?: boolean;
}) {
  const languageNote = digestLanguageNote(query.data?.lang, language);
  const wideScreen = useMediaQuery("(width >= 64.0625rem)");
  // In the rail the brief reads like a narrow screen's: one column, three
  // radar items before "more".
  const desktop = wideScreen || inPane;
  const [extraRadar, setExtraRadar] = useState(0);
  const [radarExpanded, setRadarExpanded] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // Desktop: the brief can be collapsed once read; it stays collapsed for
  // that day in this browser.
  const [storedCollapsed, setCollapsed] = useBriefCollapsed(feed.day);
  const collapsed = !inPane && storedCollapsed;
  const contentsId = useId();
  const radarId = useId();
  const [fullOpen, setFullOpen] = useState(false);
  const bodyMd = query.data?.bodyMd ?? "";
  const topicsKey = topics.join("\n");
  const sections = useMemo(
    () => digestSections(bodyMd, topicsKey ? topicsKey.split("\n") : []),
    [bodyMd, topicsKey],
  );
  const noListing = feed.status === "empty";
  const radar = query.data?.radar ?? [],
    picks = (query.data?.picks ?? []).filter(
      (ref) => !radar.some((item) => referenceKey(item) === referenceKey(ref)),
    );
  const longRadar = desktop && !inPane && radar.length > 3;
  const compactRadar = longRadar && !radarExpanded;
  const visibleRadar = (desktop ? 5 : 3) + extraRadar;
  const { rows, pending } = useDigestRows(
    feed.day,
    [...picks.slice(0, 24), ...radar.slice(0, visibleRadar)],
    feed,
  );
  return (
    <section aria-label="Morning brief" className="morning-brief">
      <Card
        className={cn(
          "max-md:gap-0 max-md:py-0",
          // In the rail: the topics card's padding and title style.
          inPane
            ? "gap-4 border-0 bg-transparent py-0 shadow-none lg:gap-4 lg:py-0"
            : "lg:gap-2.5 lg:py-3",
        )}
      >
        {inPane ? null : (
          <button
            type="button"
            className="phone-brief-toggle md:hidden"
            aria-expanded={expanded}
            aria-controls={contentsId}
            onClick={() => setExpanded((value) => !value)}
          >
            <span className="font-semibold">Morning brief</span>
            <span className="ml-auto text-sm text-primary">
              {expanded ? "Collapse" : "Expand"}
            </span>
            <ChevronDown className="size-4" aria-hidden="true" />
          </button>
        )}
        <CardHeader
          className={cn(
            "max-md:hidden",
            inPane
              ? "flex flex-wrap items-baseline gap-x-4 gap-y-0.5 px-0"
              : "lg:flex lg:flex-wrap lg:items-baseline lg:gap-x-4",
          )}
        >
          <CardTitle className={inPane ? "font-serif text-2xl" : undefined}>
            <h2>Morning brief</h2>
          </CardTitle>
          {languageNote ? (
            <p className={cn("text-xs text-muted-foreground")}>
              {languageNote}
            </p>
          ) : null}
          {query.data?.createdAt ? (
            <p className={cn("text-xs text-muted-foreground")}>
              Digest completed{" "}
              <time dateTime={query.data.createdAt}>
                {formatTimestamp(query.data.createdAt, timezone)}
              </time>
            </p>
          ) : null}
          {inPane ? null : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-auto text-subtle"
              aria-expanded={!collapsed}
              aria-controls={contentsId}
              onClick={() => setCollapsed(!collapsed)}
            >
              {collapsed ? "Expand" : "Collapse"}
              <ChevronDown
                aria-hidden="true"
                className={cn(
                  "transition-transform",
                  !collapsed && "rotate-180",
                )}
              />
            </Button>
          )}
        </CardHeader>
        <CardContent
          id={contentsId}
          className={cn(
            expanded ? "max-md:px-3.5 max-md:pb-4" : "max-md:hidden",
            collapsed && "md:hidden",
            inPane && "px-0",
          )}
        >
          {query.isPending ? (
            <LoadingState compact label="Loading the morning brief…" />
          ) : query.error || !query.data ? (
            <EmptyState
              compact
              role={query.error ? "alert" : undefined}
              title={
                query.error
                  ? "Brief unavailable"
                  : noListing
                    ? "No digest for this day"
                    : "Digest pending"
              }
              description={
                query.error?.message ??
                (noListing
                  ? "There was no listing on this date."
                  : inPane
                    ? "The papers can be read while the morning brief is prepared."
                    : "Papers can be read below while the morning brief is prepared.")
              }
            />
          ) : (
            <>
              <div
                className={cn(
                  "grid items-start gap-5",
                  !inPane && "lg:grid-cols-3",
                )}
              >
                <section
                  aria-label="Radar"
                  className="flex min-w-0 flex-col gap-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-x-2 lg:min-h-6">
                    <h3 className="text-xs font-semibold text-radar">
                      Radar for your projects
                    </h3>
                    {longRadar ? (
                      <Button
                        size="xs"
                        variant="link"
                        className="px-0"
                        aria-expanded={radarExpanded}
                        aria-controls={radarId}
                        onClick={() => setRadarExpanded((value) => !value)}
                      >
                        {radarExpanded
                          ? "Hide radar details"
                          : "Show radar details"}
                      </Button>
                    ) : null}
                  </div>
                  {radar.length ? (
                    <div
                      id={radarId}
                      className={cn(
                        "grid grid-cols-1 gap-3",
                        compactRadar && "gap-1.5",
                      )}
                    >
                      {radar.slice(0, visibleRadar).map((item) => {
                        const projectTitle = radarProjectTitle(item);
                        return (
                          <article
                            key={referenceKey(item)}
                            className={cn(
                              "flex min-w-0 flex-col gap-1.5 rounded-sm bg-radar-soft px-3 py-2.5",
                              compactRadar &&
                                "flex-row items-baseline px-2.5 py-1.5",
                            )}
                          >
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge variant="radar">{item.level}</Badge>
                              {!compactRadar && projectTitle ? (
                                <span className="text-xs font-medium text-radar">
                                  {projectTitle}
                                </span>
                              ) : null}
                              {!compactRadar && item.lookBack ? (
                                <span className="text-xs text-radar">
                                  Look back
                                </span>
                              ) : null}
                            </div>
                            <DigestReference
                              reference={item}
                              rows={rows}
                              topics={topics}
                              pending={pending}
                              compact={compactRadar}
                            />
                            {!compactRadar ? (
                              <>
                                <p className="text-[13px] text-subtle">
                                  {item.reason}
                                </p>
                                {item.relevance ? (
                                  <div className="text-[13px]">
                                    <p className="text-xs font-medium text-radar">
                                      Why it matters
                                    </p>
                                    <p className="text-subtle">
                                      {item.relevance}
                                    </p>
                                  </div>
                                ) : null}
                                {item.angles.length ? (
                                  <div className="text-[13px]">
                                    <p
                                      id={`${radarId}-${referenceKey(item)}-ways`}
                                      className="text-xs font-medium text-radar"
                                    >
                                      Ways it could help
                                    </p>
                                    <ul
                                      aria-labelledby={`${radarId}-${referenceKey(item)}-ways`}
                                      className="list-disc pl-4 text-subtle"
                                    >
                                      {item.angles.map((angle) => (
                                        <li key={angle}>{angle}</li>
                                      ))}
                                    </ul>
                                  </div>
                                ) : null}
                                {item.action ? (
                                  <p className="text-[13px] text-subtle">
                                    {item.action}
                                  </p>
                                ) : null}
                              </>
                            ) : null}
                          </article>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="rounded-sm bg-radar-soft px-3 py-2.5 text-radar">
                      {sections.radar ? (
                        <Markdown text={sections.radar} />
                      ) : (
                        <EmptyState
                          compact
                          title="No radar hits in this digest."
                        />
                      )}
                    </div>
                  )}
                  {radar.length > visibleRadar ? (
                    <div className="flex flex-col items-start gap-2">
                      <p className="text-xs text-muted-foreground">
                        and {formatCount(radar.length - visibleRadar)} more
                      </p>
                      <Button
                        variant="ghost"
                        onClick={() => setExtraRadar((count) => count + 3)}
                      >
                        Show more radar hits
                      </Button>
                    </div>
                  ) : null}
                </section>
                <section
                  aria-label="Picks per topic"
                  className="flex min-w-0 flex-col gap-3"
                >
                  <h3 className="text-xs font-semibold text-subtle lg:flex lg:min-h-6 lg:items-center">
                    Picks per topic
                  </h3>
                  {picks.length ? (
                    <DigestPicks
                      references={picks}
                      rows={rows}
                      pending={pending}
                      topics={topics}
                    />
                  ) : sections.picks ? (
                    <Markdown text={sections.picks} />
                  ) : (
                    <EmptyState
                      compact
                      title="No topic picks in this digest."
                    />
                  )}
                </section>
                <Suggestions
                  day={feed.day}
                  preview
                  fallback={
                    sections.suggestions ? (
                      <Markdown text={sections.suggestions} />
                    ) : undefined
                  }
                />
              </div>
              {query.data.bodyMd.trim() ? (
                <details
                  className="mt-5 lg:mt-2"
                  onToggle={(event) => setFullOpen(event.currentTarget.open)}
                >
                  <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                    Read the complete digest
                  </summary>
                  {/* Parsed only while open: a closed digest costs nothing. */}
                  {fullOpen ? (
                    <div className="mt-3">
                      <Markdown text={query.data.bodyMd} />
                    </div>
                  ) : null}
                </details>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
function useBriefCollapsed(day: string) {
  const key = "litscout-brief-collapsed";
  const [collapsed, setState] = useState(() => {
    try {
      return localStorage.getItem(key) === day;
    } catch {
      return false;
    }
  });
  const set = (next: boolean) => {
    setState(next);
    try {
      if (next) localStorage.setItem(key, day);
      else localStorage.removeItem(key);
    } catch {
      /* The choice lasts for this visit when storage is off. */
    }
  };
  return [collapsed, set] as const;
}
function DigestReference({
  reference,
  rows,
  topics,
  pending,
  compact,
}: {
  reference: Reference;
  rows: DigestRows;
  topics: string[];
  pending: boolean;
  compact: boolean;
}) {
  const paper = rows.get(referenceKey(reference));
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {paper ? (
        <>
          {!compact ? (
            <div className="flex flex-wrap gap-x-2">
              {paper.topics.map((topic) => (
                <TopicLabel key={topic} topic={topic} topics={topics} />
              ))}
            </div>
          ) : null}
          <Link
            className={cn(
              "font-serif text-base leading-snug font-semibold text-foreground hover:text-primary",
              compact && "truncate text-sm",
            )}
            title={compact ? plainMath(paper.title) : undefined}
            to={referenceHref(reference)}
          >
            <MathText text={paper.title} />
          </Link>
        </>
      ) : pending ? (
        <LoadingState compact label="Loading paper…" />
      ) : (
        <Link className="text-primary" to={referenceHref(reference)}>
          Open paper record
        </Link>
      )}
    </div>
  );
}
