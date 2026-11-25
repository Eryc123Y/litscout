import { useMutation } from "@tanstack/react-query";
import { z } from "zod";
import { apiGet } from "./api";
import {
  useEffect,
  useId,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { Link, useLocation, useNavigationType } from "react-router";
import { originFor } from "./origin";
import type { WebPaper } from "@litscout/pipeline/web-contracts";
import type { ListPaper } from "@litscout/pipeline/read-contracts";
import { EmptyState, LoadingState } from "./ReaderState";
import { PageHeader } from "./PageHeader";
import { formatCount, formatDay } from "./format";
import { TopicLabel } from "./TopicLabel";
import { Button } from "./components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "./components/ui/card";
import { Separator } from "./components/ui/separator";
import { ArrowLeft, ArrowRight, ExternalLink } from "lucide-react";
import { PaperIdeaActions } from "./IdeaActions";
import { PaperActions, ReadStatus } from "./PaperActions";
import { VaultPaperPanel } from "./Vault";
import { QuickNotes } from "./QuickNotes";
import { PageMetadataNotice } from "./PageMetadataNotice";
import {
  PaperLinks,
  PaperSummary,
  SummaryLead,
  PaperDetails,
  paperPdfUrl,
} from "./PaperParts";
import { readerShortcut } from "./useReader";
import { MathParagraphs, MathText } from "./math-text";
type Props = {
  paper: WebPaper;
  language?: string;
  timezone?: string;
  topics?: string[];
  fullHref?: string;
  privateActions?: boolean;
  keywordOnly?: boolean;
  close?: () => void;
  /** The close button's words: "Back to brief" beside the list, else "Back to the list". */
  closeLabel?: string;
  onMove?: (delta: number) => void;
  /** Opens the arXiv PDF beside the summary (wide screens). */
  onReadPdf?: () => void;
  /** Escape's job when it differs from close (the PDF closes first). */
  onEscape?: () => void;
  /** j / k / o / Escape on the article. Off where the page around it
   * handles them (the day reader binds them on its whole workspace). */
  shortcuts?: boolean;
  /** The record is still on its way and `paper` is drawn from its list row
   * (see draftPaper). The header and its actions are already the real ones;
   * the summary shows the row's TL;DR until the rest arrives, so nothing is
   * replaced and the title never moves. */
  pending?: PendingPaper;
};
export type PendingPaper = {
  tldr?: { lang: string; text: string };
  /** Authors the list row left out. */
  moreAuthors: number;
  /** The row came with its links, so a missing PDF is already a fact. */
  linksKnown: boolean;
};
/** A list row as a paper record, to show while the full one loads. */
export function draftPaper(row: ListPaper): WebPaper {
  return {
    paperId: row.paperId,
    title: row.title,
    abstract: row.abstract ?? null,
    authors: row.authors,
    source: row.source,
    topics: row.topics,
    shortlisted: row.shortlisted,
    summaries: [],
    identifiers: row.identifiers,
    links: row.links ?? [],
    venue: row.venue,
    venueKind: row.venueKind,
    year: row.year,
    publishedOn: row.publishedOn,
    categories: row.categories,
    hfUpvotes: row.hfUpvotes,
    ...(row.readingState && { readingState: row.readingState }),
  };
}
/** A paper's meta line: the read chip, topics, categories and dates. */
function PaperMeta({
  paperId,
  readAt,
  opening,
  privateActions,
  topics,
  allTopics,
  categories,
  firstSeenOn,
  publishedOn,
}: {
  paperId: string;
  readAt?: string | null;
  opening: boolean;
  privateActions: boolean;
  topics: string[];
  allTopics: string[];
  categories: string[];
  firstSeenOn?: string | null;
  publishedOn?: string | null;
}) {
  return (
    <div
      data-slot="paper-meta"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
    >
      {privateActions && (
        <ReadStatus
          key={paperId}
          paperId={paperId}
          readAt={readAt}
          opening={opening}
        />
      )}
      {topics.map((topic) => (
        <TopicLabel key={topic} topic={topic} topics={allTopics} />
      ))}
      {categories.length > 0 && <span>{categories.join(" · ")}</span>}
      {firstSeenOn && (
        <time dateTime={firstSeenOn}>First seen {formatDay(firstSeenOn)}</time>
      )}
      {publishedOn && (
        <time dateTime={publishedOn}>Published {formatDay(publishedOn)}</time>
      )}
    </div>
  );
}

/** The reader's way back to the brief or the list. A phone has it in the
 * bar at the bottom instead. */
function ReaderBack({ close, label }: { close: () => void; label: string }) {
  return (
    <div className="hidden md:block">
      <Button variant="ghost" onClick={close}>
        <ArrowLeft data-icon="inline-start" />
        {label}
      </Button>
    </div>
  );
}

/** The top of a paper in the reader: meta line, title, authors, then the
 * action rows. */
function ReaderHeader({
  meta,
  title,
  authors,
  titleId,
  headingRef,
  children,
}: {
  meta: ReactNode;
  title: string;
  authors?: string;
  titleId?: string;
  headingRef?: RefObject<HTMLHeadingElement | null>;
  children?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-2">
      {meta}
      <h2
        ref={headingRef}
        id={titleId}
        tabIndex={-1}
        // Focus moves here for screen readers on every j / k; a box
        // around the title on each move only gets in the way.
        className="font-serif text-pane leading-tight font-semibold focus:outline-none"
      >
        <MathText text={title} />
      </h2>
      {authors && <p className="text-subtle">{authors}</p>}
      {children}
    </header>
  );
}

export function Paper({
  paper,
  language = "en",
  timezone = "UTC",
  topics = paper.topics,
  fullHref,
  privateActions = false,
  keywordOnly = false,
  close,
  closeLabel = "Back to the list",
  onMove,
  onReadPdf,
  onEscape,
  shortcuts = true,
  pending,
}: Props) {
  const heading = useRef<HTMLHeadingElement>(null),
    titleId = useId();
  const navigationType = useNavigationType();
  const location = useLocation();
  useEffect(() => {
    if (navigationType === "PUSH")
      heading.current?.focus({
        // The reader column scrolls itself to the top; the page never jumps.
        preventScroll: Boolean(
          heading.current.closest(
            "[data-phone-reading], .reader-split, .side-panel",
          ),
        ),
      });
  }, [paper.paperId, paper.source, navigationType]);
  const allTopics = [...new Set([...topics, ...paper.topics])];
  // The same PDF as the Read PDF link; o opens it from anywhere in the reader.
  const pdfUrl = paperPdfUrl(paper);
  const context = (
    <PaperMeta
      paperId={paper.paperId}
      readAt={paper.readingState?.readAt}
      // An archived (compact) record reports no open.
      opening={!paper.compact}
      privateActions={privateActions}
      topics={paper.topics}
      allTopics={allTopics}
      categories={paper.categories}
      firstSeenOn={paper.firstSeenOn}
      publishedOn={paper.publishedOn}
    />
  );
  const authors = paper.compact
    ? undefined
    : (paper.authors.map((a) => a.name).join(", ") || "Authors not listed") +
      (pending && pending.moreAuthors > 0
        ? ` +${formatCount(pending.moreAuthors)}`
        : "");
  const metadata = paper.verified === false && <PageMetadataNotice />;
  const ideaActions = privateActions && (
    <PaperIdeaActions
      key={paper.paperId}
      paperId={paper.paperId}
      primary={!fullHref}
    />
  );
  const linksAndReading = (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
      <PaperLinks
        paper={paper}
        onReadPdf={onReadPdf}
        pending={pending ? !pending.linksKnown : false}
      />
      {privateActions && (
        <PaperActions
          key={"paper-actions-" + paper.paperId}
          paperId={paper.paperId}
          inReader={!!fullHref}
          compact={paper.compact}
        />
      )}
    </div>
  );
  return (
    <article
      className="flex min-w-0 flex-col gap-5 break-words"
      aria-labelledby={titleId}
      onKeyDown={
        shortcuts
          ? (event) =>
              readerShortcut(event, {
                move: onMove,
                close: onEscape ?? close,
                pdfUrl,
                readPdf: onReadPdf,
              })
          : undefined
      }
    >
      {close ? <ReaderBack close={close} label={closeLabel} /> : null}
      {fullHref ? (
        <ReaderHeader
          meta={context}
          title={paper.title}
          authors={authors}
          titleId={titleId}
          headingRef={heading}
        >
          {metadata}
          {linksAndReading}
          {ideaActions}
        </ReaderHeader>
      ) : (
        <PageHeader
          className="paper-header"
          title={<MathText text={paper.title} />}
          titleId={titleId}
          titleRef={heading}
          description={authors}
          context={context}
          metadata={metadata}
          actions={
            <div className="flex w-full flex-wrap items-center gap-2">
              {linksAndReading}
              {ideaActions && (
                <div className="ml-auto min-w-0 max-md:ml-0">{ideaActions}</div>
              )}
            </div>
          }
        />
      )}
      {fullHref && pending ? (
        <>
          {pending.tldr && !keywordOnly ? (
            <section aria-label="Summary" className="flex flex-col gap-4">
              <SummaryLead lang={pending.tldr.lang} tldr={pending.tldr.text} />
            </section>
          ) : null}
          <LoadingState compact label="Loading the full record…" />
        </>
      ) : fullHref ? (
        <>
          {!keywordOnly && !paper.compact && (
            <PaperSummary paper={paper} language={language} />
          )}
          {paper.compact ? (
            <ArchivedDetails
              key={paper.paperId}
              id={paper.paperId}
              canLoad={privateActions}
            />
          ) : (
            <details open={keywordOnly || undefined}>
              <summary className="cursor-pointer text-sm font-medium text-subtle">
                Abstract
              </summary>
              <div className="mt-3 font-serif text-base leading-relaxed">
                {paper.abstract ? (
                  <MathParagraphs text={paper.abstract} />
                ) : (
                  <EmptyState compact title="Abstract not available yet." />
                )}
              </div>
            </details>
          )}
          {privateActions && (
            <QuickNotes
              key={paper.paperId}
              paperId={paper.paperId}
              title={paper.title}
            />
          )}
          <Separator />
          <Button asChild variant="link" className="self-start px-0">
            <Link
              to={fullHref}
              state={{ from: originFor(location.pathname, location.search) }}
            >
              Open full record
              <ExternalLink data-icon="inline-end" />
            </Link>
          </Button>
        </>
      ) : (
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
          <div className="flex min-w-0 flex-col gap-5">
            {!keywordOnly && !paper.compact && (
              <Card>
                <CardHeader>
                  <CardTitle>
                    <h2>Summary</h2>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <PaperSummary paper={paper} language={language} />
                </CardContent>
              </Card>
            )}
            {paper.compact ? (
              <ArchivedDetails
                key={paper.paperId}
                id={paper.paperId}
                canLoad={privateActions}
              />
            ) : (
              <Card>
                <CardHeader>
                  <CardTitle>
                    <h2>Abstract</h2>
                  </CardTitle>
                </CardHeader>
                <CardContent className="font-serif text-base leading-relaxed">
                  {paper.abstract ? (
                    <MathParagraphs text={paper.abstract} />
                  ) : (
                    <EmptyState compact title="Abstract not available yet." />
                  )}
                </CardContent>
              </Card>
            )}
            {privateActions && (
              <QuickNotes
                key={paper.paperId}
                paperId={paper.paperId}
                title={paper.title}
              />
            )}
          </div>
          <aside className="flex min-w-0 flex-col gap-4">
            {privateActions && (
              <VaultPaperPanel key={paper.paperId} paperId={paper.paperId} />
            )}
            <PaperDetails
              paper={paper}
              topics={allTopics}
              timezone={timezone}
            />
          </aside>
        </div>
      )}
      {onMove ? (
        <nav aria-label="Move between papers" className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => onMove(-1)}>
            <ArrowLeft data-icon="inline-start" />
            Previous paper
          </Button>
          <Button variant="outline" onClick={() => onMove(1)}>
            Next paper
            <ArrowRight data-icon="inline-end" />
          </Button>
          <p className="shortcut-hint w-full text-xs text-muted-foreground">
            j / k to move{pdfUrl ? " · o to open the PDF" : ""} · Escape to
            close
          </p>
        </nav>
      ) : null}
    </article>
  );
}
const archivedDetailsSchema = z.object({
  available: z.boolean(),
  authors: z.array(z.object({ name: z.string() })),
  abstract: z.string().nullable(),
});
function ArchivedDetails({ id, canLoad }: { id: string; canLoad: boolean }) {
  return (
    <Card>
      <CardContent className="space-y-3">
        <p className="text-sm text-subtle">
          This paper is archived. Details are no longer stored.
        </p>
        {canLoad && <LoadDetails id={id} />}
      </CardContent>
    </Card>
  );
}
function LoadDetails({ id }: { id: string }) {
  const request = useMutation({
    mutationFn: () =>
      apiGet(
        "/papers/" + encodeURIComponent(id) + "/details",
        archivedDetailsSchema,
      ),
  });
  return (
    <>
      <Button
        variant="outline"
        disabled={request.isPending}
        onClick={() => request.mutate()}
      >
        {request.isPending ? "Loading details…" : "Load details"}
      </Button>
      {(request.isError || request.data?.available === false) && (
        <p role="status" className="text-sm text-subtle">
          Details are currently unavailable.
        </p>
      )}
      {request.data?.available && (
        <div aria-live="polite" className="space-y-2">
          {request.data.authors.length > 0 && (
            <p>{request.data.authors.map(({ name }) => name).join(", ")}</p>
          )}
          {request.data.abstract ? (
            <MathParagraphs text={request.data.abstract} />
          ) : (
            <p>No abstract was returned.</p>
          )}
        </div>
      )}
    </>
  );
}
