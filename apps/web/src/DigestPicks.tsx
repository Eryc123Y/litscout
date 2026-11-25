import { useState } from "react";
import { Link } from "react-router";
import type { DigestReference } from "@litscout/pipeline/web-contracts";
import { referenceKey, type DigestRows } from "./useDigestRows";
import { TopicLabel } from "./TopicLabel";
import { EmptyState, LoadingState } from "./ReaderState";
import { MathText, plainMath } from "./math-text";
import { Button } from "./components/ui/button";

const firstPicks = 4;
export function DigestPicks({
  references,
  rows,
  pending,
  topics,
}: {
  references: DigestReference[];
  rows: DigestRows;
  pending: boolean;
  topics: string[];
}) {
  const seen = new Set<string>();
  const picks = [
    ...new Map(references.map((ref) => [referenceKey(ref), ref])).values(),
  ]
    .slice(0, 24)
    .flatMap((ref) => {
      const paper = rows.get(referenceKey(ref));
      if (!paper) return [];
      const labels = paper.topics.filter((topic) => !seen.has(topic));
      if (paper.topics.length && !labels.length) return [];
      labels.forEach((topic) => seen.add(topic));
      return [{ paper, labels, ref }];
    });
  const [all, setAll] = useState(false);
  const shown = all ? picks : picks.slice(0, firstPicks);
  return (
    <>
      {picks.length ? (
        <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
          {shown.map(({ paper, labels, ref }) => (
            <li
              key={`${paper.paperId}:${paper.source}`}
              className="flex min-w-0 flex-col gap-0.5"
            >
              <div className="flex flex-wrap gap-x-2">
                {labels.map((topic) => (
                  <TopicLabel key={topic} topic={topic} topics={topics} />
                ))}
              </div>
              {/* Titles wrap to two lines rather than being cut to one. */}
              <Link
                className="line-clamp-2 text-sm leading-snug font-medium text-foreground hover:text-primary"
                title={plainMath(paper.title)}
                to={referenceHref(ref)}
              >
                <MathText text={paper.title} />
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {picks.length > firstPicks && !all ? (
        <Button
          type="button"
          variant="link"
          size="xs"
          className="self-start px-0"
          onClick={() => setAll(true)}
        >
          Show all {picks.length} picks
        </Button>
      ) : null}
      {pending ? (
        <LoadingState compact label="Loading topic picks…" />
      ) : !picks.length ? (
        <EmptyState
          compact
          title="Topic picks are unavailable."
          description="Read the complete digest below."
        />
      ) : null}
    </>
  );
}
export function referenceHref(ref: DigestReference) {
  return ref.day && ref.source
    ? `/app/days/${ref.day}?${new URLSearchParams({ paper: ref.paperId, paperSource: ref.source })}`
    : `/app/papers/${encodeURIComponent(ref.paperId)}${ref.source ? `?${new URLSearchParams({ source: ref.source })}` : ""}`;
}
