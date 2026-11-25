import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import {
  trendsPath,
  trendSearchResponse,
  type TrendSearchQuery,
} from "@litscout/pipeline/trends-contracts";
import { formatMonth } from "@litscout/pipeline/display-time";
import { apiGet } from "./api";
import { Notice, QueryState } from "./Notice";
import { PageHeader } from "./PageHeader";
import { EmptyState } from "./ReaderState";
import { Button } from "./components/ui/button";
import { Card, CardContent } from "./components/ui/card";

export function TrendSearch({
  month,
  topic,
  term,
}: Omit<TrendSearchQuery, "cursor">) {
  const query = useInfiniteQuery({
    queryKey: ["trends-search", month, topic, term],
    initialPageParam: null as string | null,
    getNextPageParam: (page: ReturnType<typeof trendSearchResponse.parse>) =>
      page.nextCursor,
    queryFn: ({ pageParam, signal }) =>
      apiGet(
        trendsPath +
          "/search?" +
          new URLSearchParams({
            month,
            topic,
            term,
            ...(pageParam && { cursor: pageParam }),
          }),
        trendSearchResponse,
        signal,
      ),
  });
  const title = `Papers matching “${term}”`;
  const description = `${topic} · ${formatMonth(month)}`;
  const back = (
    <Button asChild variant="outline">
      <Link to={`/app/trends?${new URLSearchParams({ month, topic })}`}>
        Back to Trends
      </Link>
    </Button>
  );
  if (!query.data)
    return (
      <Notice
        query={query}
        title={title}
        description={description}
        label="Searching titles and abstracts…"
        errorTitle="Search unavailable"
        actions={back}
      />
    );
  const papers = new Map(
    query.data.pages.flatMap(({ items }) =>
      items.map((paper) => [paper.paperId, paper] as const),
    ),
  );
  return (
    <main id="main" className="reader-page" aria-busy={query.isFetching}>
      <PageHeader title={title} description={description} actions={back} />
      {papers.size > 0 ? (
        <Card>
          <CardContent>
            <ul className="reader-list divide-y">
              {[...papers.values()].map(({ paperId, title }) => (
                <li key={paperId} className="reader-row wrap-anywhere">
                  <Link
                    className="font-medium text-primary"
                    to={`/app/papers/${encodeURIComponent(paperId)}`}
                  >
                    {title}
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : (
        <EmptyState
          compact
          title={
            query.hasNextPage
              ? "No matches in the papers checked so far"
              : "No matching papers"
          }
        />
      )}
      {query.isFetchNextPageError ? (
        <QueryState
          query={{ ...query, refetch: query.fetchNextPage }}
          label="Searching…"
          errorTitle="Could not search more papers"
        />
      ) : query.hasNextPage ? (
        <div>
          <Button
            variant="outline"
            disabled={query.isFetching}
            onClick={() => void query.fetchNextPage()}
          >
            {query.isFetching ? "Searching…" : "Search more papers"}
          </Button>
        </div>
      ) : null}
    </main>
  );
}
