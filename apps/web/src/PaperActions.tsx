import { useEffect, useRef, useState } from "react";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import {
  BookmarkPlus,
  Clock,
  EyeOff,
  Star,
  ThumbsDown,
  ThumbsUp,
  type LucideIcon,
} from "lucide-react";
import {
  libraryItemSchema,
  readingStateSchema,
  statePageSchema,
  type ReadingState,
  type StatePage,
} from "@litscout/pipeline/library-contracts";
import { apiGet, apiMutation } from "./api";
import { useDecide } from "./decisions";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";

/** Papers opened in this session, per query client: an open is recorded
 * once, not on every mount of the reader. */
const openedPapers = new WeakMap<QueryClient, Set<string>>();
type FeedRows = InfiniteData<{
  items: { paperId: string; readingState?: { readAt: string | null } }[];
}>;

/** One paper's reading state, shared by the actions and the read status. */
function readingStateOptions(paperId: string) {
  return queryOptions({
    queryKey: ["reading-state", paperId],
    queryFn: ({ signal }) =>
      apiGet(
        "/state?paperId=" + encodeURIComponent(paperId),
        statePageSchema,
        signal,
      ),
  });
}

/** "Read" or "Unread" as a small chip on the paper's meta line. */
export function ReadStatus({
  paperId,
  readAt,
  opening = false,
}: {
  paperId: string;
  readAt?: string | null;
  /** This view reports the open, which marks the paper read: say Read from
   * the start rather than Unread for the moment the report takes. */
  opening?: boolean;
}) {
  // Reads what the actions beside it put in the cache; never fetches.
  const query = useQuery({ ...readingStateOptions(paperId), enabled: false });
  const state = query.data?.items[0];
  if (!state && readAt === undefined && !opening) return null;
  const read = state ? Boolean(state.readAt) : opening || Boolean(readAt);
  return (
    <Badge variant="secondary" className="font-normal">
      {read ? "Read" : "Unread"}
    </Badge>
  );
}

export function PaperActions({
  paperId,
  inReader,
  compact,
}: {
  paperId: string;
  inReader: boolean;
  compact?: boolean;
}) {
  const client = useQueryClient();
  const { queryKey } = readingStateOptions(paperId);
  // The first open in a session reports itself, and the answer carries the
  // reading state: no request for it then. A paper opened before, a compact
  // row, or a failed report fetches the state instead.
  const [fetchState, setFetchState] = useState(
    () => compact || (openedPapers.get(client)?.has(paperId) ?? false),
  );
  const query = useQuery({
    ...readingStateOptions(paperId),
    enabled: fetchState,
  });
  const state = query.data?.items[0];
  const source = inReader ? "feed" : "web";
  async function updateState(next: ReadingState) {
    await client.cancelQueries({ queryKey });
    client.setQueryData<StatePage>(queryKey, {
      items: [next],
      nextCursor: null,
    });
  }
  const open = useMutation({
    mutationFn: () =>
      apiMutation(
        "/events",
        "POST",
        { paperId, kind: "open", source },
        readingStateSchema,
      ),
    onSuccess: async (next) => {
      await updateState(next);
      // Mark the row read where the list is loaded, rather than refetching
      // every loaded page of every day's list.
      client.setQueriesData<FeedRows>(
        { queryKey: ["feed", false] },
        (data) =>
          data && {
            ...data,
            pages: data.pages.map((page) => ({
              ...page,
              items: page.items.map((item) =>
                item.paperId === paperId
                  ? { ...item, readingState: { readAt: next.readAt } }
                  : item,
              ),
            })),
          },
      );
      await client.invalidateQueries({
        queryKey: ["library"],
        refetchType: "none",
      });
    },
    // A failed open is sent again the next time the paper is opened.
    onError: () => {
      openedPapers.get(client)?.delete(paperId);
      setFetchState(true);
    },
  });
  const { mutate: recordOpen } = open;
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || compact) return;
    opened.current = true;
    const seen = openedPapers.get(client) ?? new Set<string>();
    openedPapers.set(client, seen);
    if (seen.has(paperId)) return;
    seen.add(paperId);
    recordOpen();
  }, [recordOpen, compact, client, paperId]);
  const mark = useMutation({
    mutationFn: (kind: string) =>
      apiMutation(
        "/events",
        "POST",
        { paperId, kind, source },
        readingStateSchema,
      ),
    onSuccess: async (next, kind) => {
      await updateState(next);
      if (compact) await refreshPaper();
      // The day's lists show a skip; read them again once it is taken back.
      if (kind === "unskip")
        await Promise.all(
          [["feed", false], ["triage"]].map((queryKey) =>
            client.invalidateQueries({ queryKey }),
          ),
        );
    },
  });
  const refreshPaper = () =>
    client.invalidateQueries({
      predicate: ({ queryKey }) =>
        queryKey[0] === "paper" && queryKey[3] === paperId,
    });
  const save = useMutation({
    mutationFn: () =>
      apiMutation(
        "/library",
        "POST",
        { paperId, source, status: "saved" },
        libraryItemSchema,
      ),
    onSuccess: async (item) => {
      if (state)
        await updateState({
          ...state,
          libraryRev: item.rev,
          libraryStatus: item.status,
          skippedAt: null,
        });
      else await client.invalidateQueries({ queryKey });
      await client.invalidateQueries({ queryKey: ["library"] });
      if (compact) await refreshPaper();
    },
  });
  // To read and Skip also show on the day's list and in its triage queue.
  const decide = useDecide(source);
  const waiting = state?.libraryStatus === "to_read";
  const saved = Boolean(save.data || state?.libraryRev) && !waiting;
  const skipped = Boolean(state?.skippedAt);
  const busy =
    open.isPending ||
    save.isPending ||
    mark.isPending ||
    decide.isPending ||
    (!state && !compact);
  const error = mark.error ?? save.error ?? decide.error ?? query.error;
  return (
    <div className="flex flex-col gap-2 max-md:w-full">
      {/* Icons in a row on wider screens; on a phone, a two-by-two grid
          whose labels never wrap. */}
      <div
        role="toolbar"
        aria-label="Reading actions"
        className="flex w-fit items-center gap-0.5 rounded-md bg-control p-0.5 max-md:grid max-md:w-full max-md:grid-cols-2"
      >
        <ToolbarToggle
          label="Save to library"
          icon={BookmarkPlus}
          pressed={saved}
          disabled={busy || saved}
          onClick={() => save.mutate()}
        />
        <ToolbarToggle
          label="To read"
          icon={Clock}
          pressed={waiting}
          // An entry the reader has started or finished stays where it is.
          disabled={
            busy || waiting || (saved && state?.libraryStatus !== "saved")
          }
          onClick={() => decide.mutate({ paperId, to: "to_read" })}
        />
        <ToolbarToggle
          label="Skip"
          icon={EyeOff}
          pressed={skipped}
          // A paper kept in the library is not skipped.
          disabled={busy || saved}
          onClick={() =>
            skipped
              ? mark.mutate("unskip")
              : decide.mutate({ paperId, to: "skipped" })
          }
        />
        <ToolbarToggle
          label="Star"
          icon={Star}
          pressed={state?.starred ?? false}
          disabled={busy}
          onClick={() => mark.mutate(state?.starred ? "unstar" : "star")}
        />
        {(["up", "down"] as const).map((rating) => {
          const active = state?.rating === rating;
          return (
            <ToolbarToggle
              key={rating}
              label={`Rate ${rating}`}
              icon={rating === "up" ? ThumbsUp : ThumbsDown}
              pressed={active}
              disabled={busy}
              onClick={() =>
                mark.mutate(active ? "rate_clear" : "rate_" + rating)
              }
            />
          );
        })}
      </div>
      {open.error && (
        <p role="alert" className="text-sm text-destructive">
          Reading status could not be recorded.{" "}
          <Button variant="link" size="sm" onClick={() => recordOpen()}>
            Retry
          </Button>
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error.message}{" "}
          {query.error && (
            <Button
              variant="link"
              size="sm"
              onClick={() => void query.refetch()}
            >
              Reload state
            </Button>
          )}
        </p>
      )}
    </div>
  );
}

/** An icon toggle in the reading toolbar. The name stays the same and
 * aria-pressed carries the state; pressed shows a filled glyph in the accent.
 * The name appears as a tooltip on hover and keyboard focus, and as a label
 * on phones, where there is no hover. */
function ToolbarToggle({
  label,
  icon: Icon,
  pressed,
  disabled,
  onClick,
}: {
  label: string;
  icon: LucideIcon;
  pressed: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <span className="group relative inline-flex max-md:w-full">
      <Button
        type="button"
        variant="ghost"
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onClick}
        // Saved stays saved (disabled) but keeps its full colour.
        className="h-8 min-w-8 gap-1.5 px-2 text-subtle aria-pressed:text-primary aria-pressed:disabled:opacity-100 max-md:h-11 max-md:w-full max-md:min-w-11 max-md:justify-start"
      >
        <Icon
          aria-hidden="true"
          className={pressed ? "fill-current" : undefined}
        />
        <span
          aria-hidden="true"
          data-slot="phone-label"
          className="hidden whitespace-nowrap max-md:inline"
        >
          {label}
        </span>
      </Button>
      <span
        data-slot="tooltip"
        aria-hidden="true"
        className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded-xs bg-foreground px-2 py-1 text-xs text-background opacity-0 transition-opacity group-hover:opacity-100 group-has-[:focus-visible]:opacity-100 max-md:hidden"
      >
        {label}
      </span>
    </span>
  );
}
