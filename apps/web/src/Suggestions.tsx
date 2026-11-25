import { Link } from "react-router";
import { useId, useState, type ReactNode } from "react";
import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import {
  suggestionResolution,
  suggestionsPage,
} from "@litscout/pipeline/research-contracts";
import { apiGet, apiMutation } from "./api";
import { useRefreshResearch } from "./research-api";
import { EmptyState, LoadingState, usePageAnnouncement } from "./ReaderState";
import { formatCount } from "./format";
import { cn } from "./lib/utils";
import { Button } from "./components/ui/button";

const previewCount = 3;
const labels = {
  combination: "Combine ideas",
  new_idea: "New idea",
  paper_for_idea: "Connect a paper to an idea",
};
const requestLabels = {
  queued: "Waiting for sync",
  applied: "Applied to the vault",
  rejected: "Rejected by sync",
  cancelled: "Request cancelled",
};

export function Suggestions({
  day,
  heading = "Idea suggestions",
  preview = false,
  fallback,
}: {
  day: string;
  heading?: string;
  preview?: boolean;
  fallback?: ReactNode;
}) {
  const [message, setMessage] = useState<{ id: string; text: string }>();
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const refresh = useRefreshResearch();
  const announce = usePageAnnouncement();
  const list = useInfiniteQuery({
    queryKey: ["suggestions", day],
    initialPageParam: "",
    queryFn: ({ signal, pageParam }) =>
      apiGet(
        "/suggestions?" +
          new URLSearchParams({ day, ...(pageParam && { after: pageParam }) }),
        suggestionsPage,
        signal,
      ),
    getNextPageParam: (page) => page.next ?? undefined,
  });
  const resolve = useMutation({
    mutationFn: ({
      id,
      action,
    }: {
      id: string;
      action: "accept" | "dismiss";
    }) =>
      apiMutation(
        "/suggestions/" + id + "/" + action,
        "POST",
        {},
        suggestionResolution,
      ),
    onSuccess: async ({ status, requestId }, { id }) => {
      await refresh();
      const text =
        status === "dismissed"
          ? "Suggestion dismissed."
          : requestId
            ? "Suggestion accepted. Waiting for sync."
            : "Suggestion accepted.";
      setMessage({ id, text });
      announce?.(text);
    },
  });
  const items =
    list.data?.pages.flatMap((page) =>
      page.items.filter((item) => item.status !== "dismissed"),
    ) ?? [];
  const collapsed = preview && !expanded;
  const hiddenCount = Math.max(0, items.length - previewCount);
  const Heading = preview ? "h3" : "h2";
  const ItemHeading = preview ? "h4" : "h3";
  const dismissed = message?.text === "Suggestion dismissed.";
  return (
    <section
      aria-label={heading}
      className={cn("flex min-w-0 flex-col gap-3", !preview && "reader-panel")}
    >
      <Heading
        className={
          preview ? "text-xs font-semibold text-subtle" : "reader-section-title"
        }
      >
        {heading}
      </Heading>
      {(!announce || dismissed) && (
        <p
          role={announce ? undefined : "status"}
          aria-label={announce ? undefined : "Suggestion updates"}
          className={dismissed ? "text-sm text-subtle" : "sr-only"}
        >
          {message && <span key={message.id}>{message.text}</span>}
        </p>
      )}
      {list.isPending && !fallback && (
        <LoadingState compact live={false} label="Loading suggestions…" />
      )}
      {((!fallback && list.error) || resolve.error) && (
        <EmptyState
          compact
          role="alert"
          title="Suggestions unavailable"
          description={(resolve.error ?? list.error)?.message}
        />
      )}
      {!items.length &&
        (fallback ??
          (list.data && (
            <EmptyState
              compact
              title={
                preview
                  ? "No idea suggestions in this digest."
                  : "No idea suggestions for this day."
              }
            />
          )))}
      {preview && items.length > 0 && (
        <Button
          type="button"
          size="xs"
          variant="link"
          className="hidden self-start px-0 lg:inline-flex"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setExpanded((value) => !value)}
        >
          {hiddenCount
            ? expanded
              ? "Show fewer suggestions"
              : `Show ${formatCount(hiddenCount)} more ${hiddenCount === 1 ? "suggestion" : "suggestions"}`
            : expanded
              ? "Hide suggestion details"
              : "Show suggestion details"}
        </Button>
      )}
      {items.length > 0 && (
        <div
          id={listId}
          className={cn("grid min-w-0 gap-3", collapsed && "lg:gap-1.5")}
        >
          {items.map((item, index) => (
            <article
              key={item.id}
              className={cn(
                "grid gap-1.5 rounded-md border bg-card p-3.5",
                index === 0 && "lg:bg-accent",
                collapsed && "lg:px-2 lg:py-1.5",
                collapsed && index >= previewCount && "lg:hidden",
              )}
            >
              <p
                className={cn(
                  "text-xs font-semibold text-primary",
                  collapsed && "lg:hidden",
                )}
              >
                {labels[item.kind]}
              </p>
              <ItemHeading className="text-body leading-snug font-semibold break-words">
                {item.title}
              </ItemHeading>
              <div className={cn("contents", collapsed && "lg:hidden")}>
                <p className="text-[13px] break-words whitespace-pre-line text-subtle">
                  {item.bodyMd}
                </p>
                {item.references && (
                  <p className="text-xs break-words text-subtle">
                    {[
                      ...item.references.ideas.map(({ title }) => title),
                      ...item.references.papers.map(({ id, title }) => (
                        <Link
                          key={id}
                          to={"/app/papers/" + encodeURIComponent(id)}
                          className="text-primary hover:underline"
                        >
                          {title}
                        </Link>
                      )),
                      ...item.references.projects.map(({ title }) => title),
                    ].map((reference, index) => (
                      <span key={index}>
                        {index > 0 && " · "}
                        {reference}
                      </span>
                    ))}
                  </p>
                )}
                {item.status === "new" ? (
                  <div className="flex flex-wrap gap-1.5">
                    <Button
                      size="sm"
                      disabled={resolve.isPending}
                      onClick={() =>
                        resolve.mutate({ id: item.id, action: "accept" })
                      }
                    >
                      {item.kind === "paper_for_idea"
                        ? "Link in vault"
                        : "Add to Inbox"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={resolve.isPending}
                      onClick={() =>
                        resolve.mutate({ id: item.id, action: "dismiss" })
                      }
                    >
                      Dismiss
                    </Button>
                  </div>
                ) : (
                  <p className="text-xs font-medium text-subtle">
                    {item.requestState
                      ? requestLabels[item.requestState]
                      : "Accepted"}
                  </p>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      {list.hasNextPage && (
        <Button
          variant="outline"
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          More suggestions
        </Button>
      )}
    </section>
  );
}
