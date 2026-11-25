import { Link, useParams, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";
import type { InstanceInfo, WebFeed } from "@litscout/pipeline/web-contracts";
import { daySchema } from "@litscout/pipeline/contracts/index";
import { useFeed, useDigest, usePaper, prefetchDay, openDecision } from "./api";
import { matchesPaper, today } from "./model";
import {
  TriageBar,
  TriageCard,
  TriageSummary,
  compactAbove,
  triageKeys,
  useTriage,
} from "./Triage";
import { DensityToggle, readDensity, saveDensity } from "./ListDensity";
import type { BriefMark } from "./FeedParts";
import { useReader, readFilters, readerShortcut } from "./useReader";
import { Filters } from "./Filters";
import { Paper, draftPaper } from "./Paper";
import { Notice, QueryState } from "./Notice";
import { DayHeading, EmptyDay, FullPaper, PaperList } from "./FeedParts";
import { Digest } from "./Digest";
import { SearchPapers } from "./SearchPapers";
import { Button } from "./components/ui/button";
import { EmptyState, LoadingState, PageAnnouncements } from "./ReaderState";
import { PageHeader } from "./PageHeader";
import { formatDay, formatTimestamp } from "./format";
import { useMediaQuery, usePhoneLayout } from "./useMediaQuery";
import { PdfPanel } from "./PdfPanel";
import { SplitHandle, readListWidth, saveListWidth } from "./SplitHandle";
import { arxivPdfUrl, paperPdfUrl } from "./PaperParts";
type Props = { isPublic: boolean; instance: InstanceInfo; paperPage?: boolean };
export function Feed({ isPublic, instance, paperPage = false }: Props) {
  const params = useParams(),
    [search] = useSearchParams();
  const specifiedDay = params.day ?? search.get("day");
  const parsed = daySchema.safeParse(specifiedDay ?? today(instance.timezone));
  const day = parsed.success ? parsed.data : today(instance.timezone),
    base = isPublic ? "/public" : "/app";
  if (!parsed.success)
    return (
      <main id="main" className="reader-page">
        <PageHeader
          title="Invalid date"
          description="Choose a listing date from the archive."
          actions={
            <Button asChild variant="outline">
              <Link to={`${base}/days`}>Choose a day</Link>
            </Button>
          }
        />
      </main>
    );
  return paperPage ? (
    <PaperPage
      scopedDay={specifiedDay ?? undefined}
      id={params.id!}
      source={search.get("source") ?? undefined}
      isPublic={isPublic}
      instance={instance}
    />
  ) : (
    <DayFeed key={day} day={day} isPublic={isPublic} instance={instance} />
  );
}
function PaperPage({
  scopedDay,
  id,
  isPublic,
  instance,
  source,
}: Props & { scopedDay?: string; id: string; source?: string }) {
  const paper = usePaper(id, scopedDay, isPublic, source);
  if (paper.isPending || paper.isError)
    return (
      <Notice
        query={paper}
        title="Paper"
        description="Read the paper record and its source links."
        label="Loading paper…"
        errorTitle="Paper unavailable"
      />
    );
  return (
    <FullPaper
      paper={paper.data ?? undefined}
      base={isPublic ? "/public" : "/app"}
      day={scopedDay}
      language={instance.language}
      timezone={instance.timezone}
      topics={instance.topics}
      keywordOnly={instance.keywordOnly}
    />
  );
}
function DayFeed({ day, isPublic, instance }: Props & { day: string }) {
  const [search] = useSearchParams();
  const filters = readFilters(search);
  // Only papers on the reader's topics; a search (3+ characters) covers the
  // whole listing so the others stay findable.
  const searching = Array.from(filters.q.trim()).length >= 3;
  const query = useFeed(day, isPublic, {
    ...filters,
    shortlisted: searching ? undefined : true,
    unread: isPublic ? undefined : filters.unread,
    // A search finds skipped papers too.
    ...(searching && !filters.decision
      ? { decision: undefined }
      : openDecision(isPublic, filters.decision)),
  });
  useFillSparsePages(query, `${day}?${search.toString()}`);
  // Start the brief with the feed, not after it: one wait instead of two.
  useDigest(day, isPublic || instance.keywordOnly === true, instance.language);
  if (query.isPending)
    return (
      // No visible title here: the day's own sits lower, in the list column,
      // and one drawn at the top would jump when the page arrives.
      <main id="main" className="reader-page" aria-busy="true">
        <h1 className="sr-only">{formatDay(day, "heading")}</h1>
        <LoadingState label="Loading papers…" />
      </main>
    );
  if (query.isError && !query.data)
    return (
      <Notice
        query={query}
        title={formatDay(day, "heading")}
        description="Papers from this listing date."
        label="Loading papers…"
        errorTitle="Feed unavailable"
      />
    );
  return <LoadedDay query={query} instance={instance} isPublic={isPublic} />;
}
/** The pages as one feed, rebuilt only when the data changes. */
function LoadedDay({
  query,
  instance,
  isPublic,
}: {
  query: ReturnType<typeof useFeed>;
  instance: InstanceInfo;
  isPublic: boolean;
}) {
  const pages = query.data!.pages;
  const feed = useMemo(
    () => ({ ...pages[0]!, items: pages.flatMap((page) => page.items) }),
    [pages],
  );
  return (
    <PageAnnouncements>
      <ReadingWorkspace
        feed={feed}
        instance={instance}
        isPublic={isPublic}
        query={query}
      />
    </PageAnnouncements>
  );
}
/** The server scans a bounded window of the ranking per request, so a
 * filtered page can come back empty or short while later windows still hold
 * matches. Keep loading until enough papers show or a cap is reached, rather
 * than show an empty list behind a Load more button. */
const fillTarget = 20;
const fillPagesMax = 5;
function useFillSparsePages(
  query: ReturnType<typeof useFeed>,
  filterKey: string,
) {
  const filled = useRef({ key: filterKey, pages: 0 });
  if (filled.current.key !== filterKey)
    filled.current = { key: filterKey, pages: 0 };
  const loaded =
    query.data?.pages.reduce((sum, page) => sum + page.items.length, 0) ?? 0;
  const { hasNextPage, isFetching, isError, fetchNextPage } = query;
  useEffect(() => {
    if (
      hasNextPage &&
      !isFetching &&
      !isError &&
      loaded < fillTarget &&
      filled.current.pages < fillPagesMax
    ) {
      filled.current.pages += 1;
      void fetchNextPage();
    }
  }, [hasNextPage, isFetching, isError, loaded, fetchNextPage]);
}
function ReadingWorkspace({
  feed,
  instance,
  isPublic,
  query,
}: {
  feed: WebFeed;
  instance: InstanceInfo;
  isPublic: boolean;
  query: ReturnType<typeof useFeed>;
}) {
  const phone = usePhoneLayout();
  const triage = useTriage(feed.day, !isPublic);
  // In triage the list is the queue, and the reader walks it.
  const shownFeed = useMemo(
    () => (triage.active ? { ...feed, items: triage.rows } : feed),
    [feed, triage.active, triage.rows],
  );
  const reader = useReader(shownFeed, isPublic, phone),
    base = isPublic ? "/public" : "/app";
  const triageAt = triage.active
    ? triage.rows.findIndex((row) => reader.id && matchesPaper(row, reader.id))
    : -1;
  const triagePaper = triage.rows[triageAt];
  const marks = useMemo(
    () =>
      new Map<string, BriefMark>(
        triage.all.flatMap((row) =>
          row.reason === "code" ? [] : [[row.paperId, row.reason]],
        ),
      ),
    [triage.all],
  );
  const [density, setDensity] = useState(readDensity);
  const compactRows =
    density === "compact" ||
    (density === "auto" && feed.counts.shortlisted > compactAbove);
  const phoneReading = phone && Boolean(reader.id);
  // A paper is open or loading. On a phone the reader covers the list; on
  // wider screens it takes the right column, where the brief sits otherwise.
  const paneOpen = Boolean(reader.id) || reader.detail.isError;
  const workspace = useRef<HTMLElement>(null);
  const pane = useRef<HTMLElement>(null);
  const listPane = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  // From 1280 px an arXiv PDF can open beside the summary; the list steps
  // aside until it closes.
  const wide = useMediaQuery("(width >= 80rem)");
  const [pdfOpen, setPdfOpen] = useState(false);
  const [listWidth, setListWidth] = useState(readListWidth);
  // While the next paper loads, the panel keeps the last one (no flicker
  // back to the brief between papers).
  const shownPaper = useRef(reader.selected);
  if (reader.selected) shownPaper.current = reader.selected;
  const pdfPaper =
    reader.selected ??
    (reader.detail.isPending ? shownPaper.current : undefined);
  // A reader closed any other way (a filter, Back) forgets the PDF too.
  useEffect(() => {
    if (!reader.id) setPdfOpen(false);
  }, [reader.id]);
  const selectedPdf = pdfPaper ? arxivPdfUrl(pdfPaper) : undefined;
  // PDF mode stays on across papers, but a paper without an arXiv PDF
  // reads in the normal two columns; the next one with a PDF shows it.
  const pdfShown = wide && pdfOpen && paneOpen && Boolean(selectedPdf);
  const closePdf = (refocus = false) => {
    setPdfOpen(false);
    // The Close button goes away with the panel; Read PDF takes focus.
    if (refocus)
      pane.current
        ?.querySelector<HTMLElement>('a[aria-keyshortcuts="o"]')
        ?.focus();
  };
  const closeReader = () => {
    setPdfOpen(false);
    reader.close();
  };
  const decideOpen = (to: (typeof triageKeys)[string]) => {
    if (!triagePaper) return;
    triage.decide(triagePaper, to);
    const next = triage.nextAfter(triagePaper.paperId);
    if (next) reader.open(next);
    else closeReader();
  };
  const undoDecision = () => {
    const paper = triage.undo();
    if (paper) reader.open(paper);
  };
  // CSSOM, not a style attribute, so the CSP stays strict. The phone and
  // wider layouts are different elements, so set it again after a switch.
  const applyListWidth = (width: number) =>
    workspace.current?.style.setProperty("--list-width", `${width}px`);
  useLayoutEffect(() => {
    workspace.current?.style.setProperty("--list-width", `${listWidth}px`);
  }, [listWidth, phone]);
  const wasPhoneReading = useRef(false);
  useLayoutEffect(() => {
    const opening = phoneReading && !wasPhoneReading.current;
    wasPhoneReading.current = phoneReading;
    if (phoneReading) {
      pane.current?.scrollTo?.(0, 0);
      // Previous and Next keep focus; opening starts at Back.
      if (opening) back.current?.focus({ preventScroll: true });
      return;
    }
    if (phone) return;
    // Each column scrolls on its own: a new paper starts at its top, and
    // the list only moves to keep the open paper's row in view (j / k).
    if (pane.current) pane.current.scrollTop = 0;
    // Only an open paper's row: closing it leaves the list where it was.
    if (reader.id)
      listPane.current
        ?.querySelector('[aria-label="Paper list"] [aria-current="true"]')
        ?.scrollIntoView?.({ block: "nearest" });
  }, [phone, phoneReading, reader.id]);
  const keywordOnly = instance.keywordOnly === true;
  const digest = useDigest(
    feed.day,
    isPublic || keywordOnly,
    instance.language,
  );
  // Stable between renders, so the list's rows are not redrawn for nothing.
  const topicsKey = [
    ...new Set([...instance.topics, ...Object.keys(feed.counts.topics)]),
  ].join("\n");
  const topics = useMemo(
    () => (topicsKey ? topicsKey.split("\n") : []),
    [topicsKey],
  );
  const openLatest = useRef(reader.open);
  openLatest.current = reader.open;
  const openPaper = useCallback<typeof reader.open>(
    (paper, element) => openLatest.current(paper, element),
    [],
  );
  const hasBrief = !isPublic && !keywordOnly;
  // Nothing to read yet: no papers, and no digest (or none on this feed).
  const nothingYet =
    feed.counts.total === 0 &&
    (!hasBrief || (digest.isSuccess && !digest.data));
  const emptyDay = (
    <EmptyDay
      day={feed.day}
      status={feed.status}
      today={today(instance.timezone)}
      base={base}
      isPublic={isPublic}
      topics={instance.topics}
      keywordOnly={keywordOnly}
    />
  );
  // The reader's keys work anywhere on the page: the list or the reader.
  const onKeyDown = (event: KeyboardEvent) =>
    readerShortcut(event, {
      move: reader.move,
      close: pdfShown ? () => closePdf() : reader.id ? closeReader : undefined,
      pdfUrl: reader.selected ? paperPdfUrl(reader.selected) : undefined,
      readPdf: wide && selectedPdf ? () => setPdfOpen(true) : undefined,
      extra: triagePaper
        ? {
            ...Object.fromEntries(
              Object.entries(triageKeys).map(([key, to]) => [
                key,
                () => decideOpen(to),
              ]),
            ),
            u: triage.canUndo ? undoDecision : undefined,
          }
        : undefined,
    });
  const brief = (inPane: boolean) =>
    hasBrief ? (
      <Digest
        query={digest}
        feed={feed}
        topics={topics}
        timezone={instance.timezone}
        language={instance.language}
        inPane={inPane}
      />
    ) : null;
  const client = useQueryClient();
  const prefetchNeighbour = useCallback(
    (day: string) => void prefetchDay(client, day, isPublic),
    [client, isPublic],
  );
  const dayHeading = (
    <DayHeading
      feed={feed}
      base={base}
      today={today(instance.timezone)}
      keywordOnly={keywordOnly}
      onIntent={prefetchNeighbour}
      search={
        <SearchPapers
          q={reader.value.q}
          onSearch={reader.onSearch}
          papers={reader.papers}
          onOpen={reader.open}
          searching={query.isFetching}
          shortcutDisabled={phoneReading}
          everyDay={!isPublic}
          day={feed.day}
          topVenues={instance.topVenues}
        />
      }
    />
  );
  const densityToggle = (
    <DensityToggle
      compact={compactRows}
      onChange={(value) => {
        setDensity(value);
        saveDensity(value);
      }}
    />
  );
  const papers = triage.active ? (
    <section aria-label="Papers" className="flex min-w-0 flex-col gap-4">
      <TriageCard triage={triage} onTopics={feed.counts.shortlisted} />
      {triage.error && (
        <p role="alert" className="text-sm text-destructive">
          The last decision was not saved: {triage.error.message}
        </p>
      )}
      <PaperList
        papers={reader.papers}
        selected={reader.selected}
        language={instance.language}
        keywordOnly={keywordOnly}
        topics={topics}
        status={feed.status}
        base={base}
        onOpen={openPaper}
        onIntent={reader.prefetch}
        listRef={reader.listRef}
        compact
        marks={marks}
      />
    </section>
  ) : (
    <section aria-label="Papers" className="flex min-w-0 flex-col gap-4">
      <TriageCard triage={triage} onTopics={feed.counts.shortlisted} />
      <Filters
        counts={feed.counts}
        isPublic={isPublic}
        topics={topics}
        topVenues={instance.topVenues ?? []}
        value={reader.value}
        onChange={reader.filter}
      />
      <div className="flex min-w-0 items-center gap-2">
        {!phone && hasBrief ? (
          <BriefEntry
            current={!paneOpen}
            status={digest}
            timezone={instance.timezone}
            onOpen={closeReader}
          />
        ) : null}
        {!keywordOnly && densityToggle}
      </div>
      <PaperList
        papers={reader.papers}
        selected={reader.selected}
        language={instance.language}
        keywordOnly={keywordOnly}
        topics={topics}
        status={feed.status}
        hasMore={query.hasNextPage}
        base={base}
        onOpen={openPaper}
        onIntent={reader.prefetch}
        listRef={reader.listRef}
        compact={compactRows && !keywordOnly}
        marks={marks}
      />
      {query.isError ? (
        <div role="alert" className="flex flex-wrap gap-2 text-destructive">
          {query.error.message}
          <Button variant="outline" onClick={() => void query.fetchNextPage()}>
            Retry loading papers
          </Button>
        </div>
      ) : null}
      {query.hasNextPage ? (
        <Button
          variant="outline"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? "Loading…" : "Load more"}
        </Button>
      ) : null}
    </section>
  );
  const closeLabel = triage.active
    ? "Back to the queue"
    : phone || !hasBrief
      ? "Back to the list"
      : "Back to brief";
  const triageBar = triagePaper ? (
    <TriageBar
      paper={triagePaper}
      position={triageAt + 1}
      total={triage.rows.length}
      onDecide={decideOpen}
      onUndo={triage.canUndo ? undoDecision : undefined}
    />
  ) : null;
  const triageSummary = (
    <TriageSummary triage={triage} onOpen={(paper) => reader.open(paper)} />
  );
  // The row of a paper whose record is still loading: the reader shows it
  // in the full view's own frame, and the record fills in around it.
  const pendingRow =
    reader.id && reader.detail.isPending ? reader.pendingRow : undefined;
  const pendingTldr = pendingRow
    ? (pendingRow.tldr.find((s) => s.lang === instance.language) ??
      pendingRow.tldr[0])
    : undefined;
  const shownRecord =
    reader.selected ?? (pendingRow ? draftPaper(pendingRow) : undefined);
  const paperView =
    (reader.id && reader.detail.isPending && !pendingRow) ||
    reader.detail.isError ? (
      <QueryState
        query={reader.detail}
        label="Paper loading…"
        errorTitle="Paper unavailable"
        retryLabel="Retry paper"
      />
    ) : shownRecord ? (
      <Paper
        paper={shownRecord}
        pending={
          pendingRow && {
            tldr: pendingTldr,
            moreAuthors: pendingRow.authorCount - pendingRow.authors.length,
            linksKnown: pendingRow.links !== undefined,
          }
        }
        privateActions={!isPublic}
        language={instance.language}
        timezone={instance.timezone}
        keywordOnly={keywordOnly}
        topics={topics}
        fullHref={`${base}/papers/${encodeURIComponent(shownRecord.paperId)}?${new URLSearchParams({ day: feed.day, source: shownRecord.source })}`}
        close={closeReader}
        closeLabel={closeLabel}
        shortcuts={false}
        // On a phone, Previous and Next sit in the bar at the bottom.
        onMove={phone ? undefined : reader.move}
        onReadPdf={
          wide && selectedPdf && !pendingRow
            ? () => setPdfOpen(true)
            : undefined
        }
      />
    ) : nothingYet && !reader.id ? (
      emptyDay
    ) : (
      <EmptyState
        compact
        title={
          reader.id
            ? "Paper not found in this day."
            : "Choose a paper to start reading."
        }
        description={
          keywordOnly
            ? "Its abstract and links will appear here."
            : "Its summary and links will appear here."
        }
      />
    );
  if (phone)
    return (
      <main
        id={phoneReading ? undefined : "main"}
        className="reader-page"
        data-phone-reading={phoneReading || undefined}
        onKeyDown={onKeyDown}
      >
        {dayHeading}
        {triage.active ? triageSummary : brief(false)}
        {papers}
        <section
          aria-label="Selected paper"
          id={phoneReading ? "main" : undefined}
          tabIndex={phoneReading ? -1 : undefined}
          ref={pane}
          hidden={!paneOpen}
          className="reading-pane reader-panel p-5 lg:p-6"
        >
          {phoneReading && isPublic && (
            <p className="mb-3 text-xs text-muted-foreground">
              Public feed · Read only
            </p>
          )}
          {triageBar}
          {paperView}
          {phoneReading && (
            <nav aria-label="Move between papers" className="phone-reader-nav">
              <Button
                ref={back}
                variant="ghost"
                aria-label="Back to the list"
                onClick={reader.close}
              >
                <ArrowLeft data-icon="inline-start" />
                Back
              </Button>
              <Button
                variant="outline"
                aria-label="Previous paper"
                // aria-disabled, not disabled: a button that disables itself
                // while focused drops focus to the page and kills the keys.
                aria-disabled={!reader.hasPrevious}
                className="aria-disabled:opacity-45"
                onClick={() => reader.move(-1)}
              >
                <ChevronLeft data-icon="inline-start" />
                Previous
              </Button>
              <Button
                variant="outline"
                aria-label="Next paper"
                aria-disabled={!reader.hasNext}
                className="aria-disabled:opacity-45"
                onClick={() => reader.move(1)}
              >
                Next
                <ChevronRight data-icon="inline-end" />
              </Button>
            </nav>
          )}
        </section>
      </main>
    );
  return (
    <main
      id="main"
      ref={workspace}
      className="reader-page reader-split"
      data-pdf-shown={pdfShown || undefined}
      onKeyDown={onKeyDown}
    >
      <div ref={listPane} className="reader-list-pane" hidden={pdfShown}>
        {dayHeading}
        {papers}
      </div>
      {pdfShown ? null : (
        <SplitHandle
          width={listWidth}
          // A drag moves the divider directly; React catches up when it ends.
          onChange={applyListWidth}
          onCommit={(width) => {
            setListWidth(width);
            saveListWidth(width);
          }}
          label="Resize the paper list"
        />
      )}
      <section
        aria-label={paneOpen || !hasBrief ? "Selected paper" : "Reader"}
        ref={pane}
        className="reading-pane reader-panel p-5 lg:p-6"
      >
        {triageBar}
        {triage.active && !paneOpen
          ? triageSummary
          : paneOpen || !hasBrief
            ? paperView
            : nothingYet
              ? emptyDay
              : brief(true)}
      </section>
      {pdfShown && pdfPaper && selectedPdf && (
        <PdfPanel
          title={pdfPaper.title}
          url={selectedPdf}
          onClose={() => closePdf(true)}
        />
      )}
    </main>
  );
}

/** The brief's place in the list on wider screens: it opens in the reader. */
function BriefEntry({
  current,
  status,
  timezone,
  onOpen,
}: {
  current: boolean;
  status: ReturnType<typeof useDigest>;
  timezone: string;
  onOpen: () => void;
}) {
  const line = status.isPending
    ? "Loading…"
    : status.data?.createdAt
      ? `Digest completed ${formatTimestamp(status.data.createdAt, timezone)}`
      : status.error
        ? "Unavailable"
        : "Digest pending";
  return (
    <button
      type="button"
      aria-current={current ? "true" : undefined}
      className="-ml-0.5 flex min-w-0 flex-1 flex-col gap-0.5 rounded-sm px-2.5 py-2.5 text-left hover:bg-control aria-current:bg-row-on"
      onClick={onOpen}
    >
      <span className="text-[15px] font-semibold">Morning brief</span>
      <span className="text-xs text-muted-foreground">{line}</span>
    </button>
  );
}
