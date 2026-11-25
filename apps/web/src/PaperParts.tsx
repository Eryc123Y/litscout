import { ArrowUpRight } from "lucide-react";
import { Fragment } from "react";
import type { WebPaper } from "@litscout/pipeline/web-contracts";
import { safeUrl } from "./model";
import { formatTimestamp } from "./format";
import { EmptyState } from "./ReaderState";
import { MathText } from "./math-text";
import { TopicLabel } from "./TopicLabel";
import { Button } from "./components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "./components/ui/card";
import { Badge } from "./components/ui/badge";
import { Separator } from "./components/ui/separator";
const parts = {
  motivation: "Motivation",
  method: "Method",
  result: "Result",
  conclusion: "Conclusion",
};
export function paperLinks(paper: WebPaper) {
  const links = paper.links.filter((link) => safeUrl(link.url));
  const doi = paper.identifiers.find((id) => id.scheme === "doi")?.value;
  if (doi && !links.some((link) => link.kind === "doi")) {
    const url =
      "https://doi.org/" + doi.split("/").map(encodeURIComponent).join("/");
    links.push({ kind: "doi", url });
  }
  const doiUrls = new Set(
    links
      .filter((link) => link.kind === "doi")
      .map((link) => safeUrl(link.url)),
  );
  const distinct = links.filter(
    (link) => link.kind !== "landing" || !doiUrls.has(safeUrl(link.url)),
  );
  const arxiv = paper.identifiers
    .find((id) => id.scheme === "arxiv")
    ?.value.replace(/^arxiv:/i, "");
  if (
    !arxiv ||
    !/^(?:\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)$/i.test(
      arxiv,
    )
  )
    return distinct;
  const derived = [
    { kind: "landing", url: `https://arxiv.org/abs/${arxiv}` },
    { kind: "pdf_arxiv", url: `https://arxiv.org/pdf/${arxiv}` },
    { kind: "alphaxiv", url: `https://www.alphaxiv.org/abs/${arxiv}` },
  ];
  return [
    ...distinct,
    ...derived.filter(
      (link) =>
        !distinct.some(
          (existing) =>
            existing.kind === link.kind &&
            (link.kind !== "landing" ||
              existing.url.includes("arxiv.org/abs/")),
        ),
    ),
  ];
}
/** Labels for the full link list in the paper's details. */
function linkLabel(kind: string, url: string) {
  if (kind === "landing")
    return new URL(url).hostname === "arxiv.org"
      ? "arXiv page"
      : "Landing page";
  return (
    (
      {
        pdf_arxiv: "PDF",
        pdf_oa: "Open-access PDF",
        alphaxiv: "alphaXiv",
        doi: "DOI",
      } as Record<string, string>
    )[kind] ?? kind.replaceAll("_", " ")
  );
}
type PaperLink = { kind: string; url: string };
type ChosenLinks = {
  pdf?: PaperLink;
  other?: PaperLink & { label: string };
  noPdf?: true;
};
const otherLabel = (link: PaperLink) =>
  link.kind === "alphaxiv"
    ? "alphaXiv"
    : link.kind === "doi"
      ? "Publisher page"
      : new URL(link.url).hostname === "arxiv.org"
        ? "arXiv page"
        : "Landing page";
/** One PDF to read and one other place to go: alphaXiv, else the publisher,
 * else the paper's landing page. */
export function chooseLinks(links: PaperLink[]): ChosenLinks {
  const find = (kind: string) => links.find((link) => link.kind === kind);
  const pdf = find("pdf_arxiv") ?? find("pdf_oa");
  const other = find("alphaxiv") ?? find("doi") ?? find("landing");
  return {
    ...(pdf && { pdf }),
    ...(other && { other: { ...other, label: otherLabel(other) } }),
    ...(!pdf && { noPdf: true as const }),
  };
}
/** A PDF the reader may show beside a summary: only from https://arxiv.org,
 * the one origin the Worker's CSP lets the page frame. */
export function framablePdf(link: PaperLink | undefined) {
  const url = link?.kind === "pdf_arxiv" ? safeUrl(link.url) : undefined;
  try {
    return url && new URL(url).origin === "https://arxiv.org" ? url : undefined;
  } catch {
    return undefined;
  }
}
/** The paper's PDF, the same one as its Read PDF link. */
export function paperPdfUrl(paper: WebPaper) {
  return safeUrl(chooseLinks(paperLinks(paper)).pdf?.url);
}
/** "English" for "en"; the code itself where the browser cannot name it. */
export function languageName(code: string) {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}
/** The paper's PDF for the reader's panel, if it can be framed. */
export function arxivPdfUrl(paper: WebPaper) {
  return framablePdf(chooseLinks(paperLinks(paper)).pdf);
}
export function PaperLinks({
  paper,
  onReadPdf,
  pending = false,
}: {
  paper: WebPaper;
  /** Shows the arXiv PDF in the reader; other PDFs open a new tab. */
  onReadPdf?: () => void;
  /** The record is still loading, so a missing PDF is not yet a fact. */
  pending?: boolean;
}) {
  const { pdf, other, noPdf } = chooseLinks(paperLinks(paper));
  const inReader = Boolean(onReadPdf && framablePdf(pdf));
  const external = { rel: "noopener noreferrer", target: "_blank" } as const;
  return (
    <nav aria-label="Paper links" className="flex flex-wrap items-center gap-2">
      {pdf && (
        <Button asChild>
          <a
            href={safeUrl(pdf.url)}
            aria-keyshortcuts="o"
            {...external}
            onClick={(event) => {
              // Modified and middle clicks still open a tab of their own.
              if (
                !inReader ||
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              event.preventDefault();
              onReadPdf?.();
            }}
          >
            Read PDF
          </a>
        </Button>
      )}
      {other && (
        <Button asChild variant="secondary">
          <a href={safeUrl(other.url)} {...external}>
            {other.kind === "alphaxiv" && <AlphaxivMark />}
            {other.label}
            <ArrowUpRight
              aria-hidden="true"
              className="text-muted-foreground"
            />
          </a>
        </Button>
      )}
      {noPdf && !pending && (
        <span className="text-sm text-muted-foreground">
          No open-access PDF found
        </span>
      )}
    </nav>
  );
}
/** alphaXiv's mark, beside links to the paper on alphaXiv. */
function AlphaxivMark() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 718.41 504.47"
      className="h-3 w-auto shrink-0 text-brand-alphaxiv"
      fill="currentColor"
    >
      <polygon points="591.15 258.54 718.41 385.73 663.72 440.28 536.57 313.62 591.15 258.54" />
      <path d="M273.86.3c34.56-2.41,67.66,9.73,92.51,33.54l94.64,94.63-55.11,54.55-96.76-96.55c-16.02-12.7-37.67-12.1-53.19,1.11L54.62,288.82,0,234.23,204.76,29.57C223.12,13.31,249.27,2.02,273.86.3Z" />
      <path d="M663.79,1.29l54.62,54.58-418.11,417.9c-114.43,95.94-263.57-53.49-167.05-167.52l160.46-160.33,54.62,54.58-157.88,157.77c-33.17,40.32,18.93,91.41,58.66,57.48L663.79,1.29Z" />
    </svg>
  );
}
/** The top of a summary: its language line and the TL;DR in its box. The
 * view shown while a record loads draws the same two from the list row, so
 * they stay where they are when the rest arrives. */
export function SummaryLead({ lang, tldr }: { lang: string; tldr: string }) {
  return (
    <>
      <p className="text-xs text-muted-foreground">
        Summary language: {languageName(lang)}. Written from the abstract; check
        the paper.
      </p>
      <div className="rounded-md bg-muted px-4 py-3">
        <h3 className="mb-1 text-xs font-semibold text-subtle">TL;DR</h3>
        <p className="font-serif text-reading leading-relaxed">
          <MathText text={tldr} />
        </p>
      </div>
    </>
  );
}
export function PaperSummary({
  paper,
  language,
}: {
  paper: WebPaper;
  language: string;
}) {
  const summary =
    paper.summaries.find((s) => s.lang === language) ?? paper.summaries[0];
  if (!summary)
    return (
      <EmptyState
        compact
        title={
          paper.abstract?.trim()
            ? "Summary pending. The abstract is available below."
            : "No summary: LitScout summarises from the abstract, and this paper has none."
        }
      />
    );
  return (
    <section aria-label="Five-part summary" className="flex flex-col gap-4">
      <SummaryLead lang={summary.lang} tldr={summary.content.tldr} />
      <dl className="grid gap-x-5 gap-y-3 sm:grid-cols-[max-content_minmax(0,1fr)]">
        {(Object.keys(parts) as (keyof typeof parts)[]).map((key) => (
          <Fragment key={key}>
            <dt className="pt-0.5 text-xs font-semibold text-muted-foreground">
              {parts[key]}
            </dt>
            <dd className="text-subtle">
              <MathText text={summary.content[key]} />
            </dd>
          </Fragment>
        ))}
      </dl>
    </section>
  );
}
export function PaperDetails({
  paper,
  topics,
  timezone,
}: {
  paper: WebPaper;
  topics: string[];
  timezone: string;
}) {
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="reader-section-title">
            <h2>Identifiers and links</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 text-xs">
          {paper.identifiers.length ? (
            <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-2">
              {paper.identifiers.map((id) => (
                <Fragment key={id.scheme + id.value}>
                  <dt className="text-muted-foreground">{id.scheme}</dt>
                  <dd className="break-all">{id.value}</dd>
                </Fragment>
              ))}
            </dl>
          ) : (
            <EmptyState compact title="No identifiers recorded." />
          )}
          <Separator />
          {paper.links
            .filter((link) => safeUrl(link.url))
            .map((link, i) => (
              <div key={i} className="flex flex-col gap-1">
                <a
                  className="break-all text-primary underline underline-offset-4"
                  href={safeUrl(link.url)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {linkLabel(link.kind, link.url)}
                </a>
                <span className="text-muted-foreground">
                  {link.httpStatus != null ? `HTTP ${link.httpStatus} · ` : ""}
                  {link.checkedAt ? (
                    <>
                      Checked{" "}
                      <time dateTime={link.checkedAt}>
                        {formatTimestamp(link.checkedAt, timezone)}
                      </time>
                    </>
                  ) : (
                    "Not checked"
                  )}
                  {link.oaStatus && link.oaStatus !== "unknown"
                    ? ` · ${link.oaStatus}`
                    : ""}
                </span>
                {link.httpStatus != null && link.httpStatus >= 400 ? (
                  <Badge variant="destructive">Link unavailable</Badge>
                ) : null}
              </div>
            ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="reader-section-title">
            <h2>Topics and venue</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            {paper.topics.length ? (
              paper.topics.map((topic) => (
                <TopicLabel key={topic} topic={topic} topics={topics} />
              ))
            ) : (
              <EmptyState compact title="No matching topic." />
            )}
          </div>
          <p className="text-subtle">
            {paper.venue ?? paper.source}
            {paper.year ? ` · ${paper.year}` : ""}
          </p>
          <p className="text-xs text-muted-foreground">{paper.venueKind}</p>
        </CardContent>
      </Card>
    </>
  );
}
