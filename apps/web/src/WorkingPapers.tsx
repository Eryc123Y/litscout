import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { PanelLink } from "./SidePanel";
import { Link, useParams } from "react-router";
import {
  workingPaperDetail,
  workingPapersPage,
} from "@litscout/pipeline/research-contracts";
import { apiGet } from "./api";
import { ObsidianLink } from "./ObsidianLink";
import { NoteBody } from "./VaultNote";
import { VaultTagEmptyState } from "./VaultConventions";
import { useVaultRequest } from "./research-api";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { PageHeader } from "./PageHeader";
import { Notice, QueryState } from "./Notice";
import { EmptyState, usePageAnnouncement } from "./ReaderState";
import { TopicLabel } from "./TopicLabel";
import { formatDay } from "./format";
import { MathText } from "./math-text";

const panel = "reader-panel grid content-start gap-3";
import { statusLabels as states } from "./library-ui";

export function WorkingPapers() {
  const query = useInfiniteQuery({
    queryKey: ["working-papers"],
    initialPageParam: "",
    queryFn: ({ signal, pageParam }) =>
      apiGet(
        "/working-papers" + (pageParam ? "?after=" + pageParam : ""),
        workingPapersPage,
        signal,
      ),
    getNextPageParam: (page) => page.next ?? undefined,
  });
  const papers = query.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <main id="main" className="reader-page">
      <PageHeader
        title="Working papers"
        description="Drafts and reading lists indexed from your Obsidian vault."
      />
      {(query.isPending || query.error) && (
        <QueryState
          query={query}
          label="Loading working papers…"
          errorTitle="Working papers unavailable"
        />
      )}
      {query.data && !papers.length && (
        <VaultTagEmptyState field="workingPaperTag" />
      )}
      {papers.length > 0 && (
        <ul className="reader-panel reader-list divide-y">
          {papers.map((paper) => (
            <li key={paper.id} className="reader-row grid gap-1">
              <Link className="reader-record-link" to={paper.id}>
                <MathText text={paper.title} />
              </Link>
              <p className="text-sm text-subtle">
                {[paper.projectTitle, paper.status]
                  .filter(Boolean)
                  .join(" · ") || paper.path}
              </p>
            </li>
          ))}
        </ul>
      )}
      {query.hasNextPage && (
        <Button
          className="self-start"
          variant="outline"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          More working papers
        </Button>
      )}
    </main>
  );
}

export function WorkingPaper({ topics }: { topics: string[] }) {
  const { id } = useParams();
  const announce = usePageAnnouncement();
  const query = useQuery({
    queryKey: ["working-papers", id],
    queryFn: ({ signal }) =>
      apiGet(
        "/working-papers/" + encodeURIComponent(id ?? ""),
        workingPaperDetail.nullable(),
        signal,
      ),
    enabled: Boolean(id),
  });
  const request = useVaultRequest();
  if (query.isPending || query.isError)
    return (
      <Notice
        query={query}
        title="Working paper"
        description="Its ideas, reading list and recent matches."
        label="Loading working paper…"
        errorTitle="Working paper unavailable"
      />
    );
  const paper = query.data;
  if (!paper)
    return (
      <main id="main" className="reader-page">
        <PageHeader
          title="Working paper not found"
          description="Choose a draft from the working papers list."
          actions={
            <Button asChild variant="outline">
              <Link to="/app/working-papers">Working papers</Link>
            </Button>
          }
        />
      </main>
    );
  const recentTopics = [
    ...new Set([...topics, ...paper.recent.flatMap((entry) => entry.topics)]),
  ];
  const ideaOrder = new Map(
    paper.ideas.map(({ id: ideaId }, index) => [ideaId, index + 1]),
  );
  return (
    <main id="main" className="reader-page">
      <PageHeader
        title={<MathText text={paper.title} />}
        description={
          [paper.projectTitle, paper.status].filter(Boolean).join(" · ") ||
          "Indexed from your vault."
        }
        context={
          <Link
            to="/app/working-papers"
            className="font-semibold text-primary hover:underline"
          >
            Working papers
          </Link>
        }
        metadata={<span className="break-all">{paper.path}</span>}
        actions={
          <ObsidianLink path={paper.path} action>
            Write in Obsidian
          </ObsidianLink>
        }
      />
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(15rem,1fr)_minmax(0,3fr)]">
        <section className={panel} aria-label="Its ideas, in the note’s order">
          <h2 className="reader-section-title">
            Its ideas, in the note’s order
          </h2>
          {paper.ideas.length ? (
            <ol className="ml-5 list-decimal space-y-2 text-sm font-medium">
              {paper.ideas.map((idea, index) => (
                <li key={idea.id + ":" + index}>{idea.title}</li>
              ))}
            </ol>
          ) : (
            <EmptyState compact title="No linked ideas." />
          )}
          <p className="text-[13px] text-subtle">
            Edit the order in Obsidian. The next sync picks it up.
          </p>
        </section>
        <section className={panel} aria-label="Reading list">
          <h2 className="reader-section-title">Reading list</h2>
          {paper.reading.length ? (
            <ul className="reader-list divide-y">
              {paper.reading.map((entry) => {
                const related = entry.ideaIds
                  .map((ideaId) => ideaOrder.get(ideaId))
                  .filter(Boolean);
                return (
                  <li
                    key={entry.id}
                    className="reader-row flex flex-wrap items-start justify-between gap-x-4 gap-y-1"
                  >
                    <div className="grid min-w-0 flex-[1_1_18rem] gap-1 wrap-anywhere">
                      <PanelLink
                        className="reader-record-link"
                        target={{ kind: "paper", id: entry.id }}
                      >
                        <MathText text={entry.title} />
                      </PanelLink>
                      <p className="text-xs text-subtle">
                        {[
                          entry.status
                            ? states[entry.status]
                            : "Not in library",
                          related.length && "Idea " + related.join(", "),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                      {entry.pending && (
                        <p className="text-xs font-medium text-primary">
                          Waiting for sync
                        </p>
                      )}
                    </div>
                    {entry.vaultPath && (
                      <Badge variant="secondary">Vault note</Badge>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState compact title="No papers in the reading list." />
          )}
          {paper.readingMore > 0 && (
            <p className="text-sm text-subtle">
              {paper.readingMore} more{" "}
              {paper.readingMore === 1 ? "paper" : "papers"}
            </p>
          )}
        </section>
      </div>
      <section className={panel} aria-label="Draft note">
        <h2 className="reader-section-title">Draft note</h2>
        <NoteBody id={paper.id} />
      </section>
      <section className={panel} aria-label="New this week, close to its ideas">
        <h2 className="reader-section-title">
          New this week, close to its ideas
        </h2>
        {request.error && (
          <p role="alert" className="text-sm text-destructive">
            {request.error.message}
          </p>
        )}
        {paper.recent.length ? (
          <ul className="reader-list divide-y">
            {paper.recent.map((entry) => (
              <li key={entry.id} className="reader-row grid gap-1.5">
                <PanelLink
                  className="reader-record-link"
                  target={{ kind: "paper", id: entry.id, source: entry.source }}
                >
                  <MathText text={entry.title} />
                </PanelLink>
                <div className="flex flex-wrap items-center gap-x-2 text-xs text-subtle">
                  <time dateTime={entry.day}>{formatDay(entry.day)}</time>
                  {entry.topics.map((topic) => (
                    <TopicLabel
                      key={topic}
                      topic={topic}
                      topics={recentTopics}
                    />
                  ))}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="justify-self-start"
                  disabled={request.isPending}
                  onClick={() =>
                    request.mutate(
                      {
                        kind: "add_reading",
                        targetNoteId: paper.id,
                        paperId: entry.id,
                      },
                      {
                        onSuccess: () =>
                          announce?.(
                            "Reading list addition requested. Waiting for sync.",
                          ),
                      },
                    )
                  }
                >
                  Add to reading list
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState compact title="No recent matches." />
        )}
      </section>
    </main>
  );
}
