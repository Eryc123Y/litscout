import {
  useMutation,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import {
  libraryItemSchema,
  readingStateSchema,
  statePageSchema,
  type ReadingState,
  type StatePage,
} from "@litscout/pipeline/library-contracts";
import type { ListPaper } from "@litscout/pipeline/read-contracts";
import type { TriageQueue } from "@litscout/pipeline/web-contracts";
import { apiGet, apiMutation } from "./api";

/** What the reader decided about a paper on the day's list. A paper in the
 * library at any later stage (reading, done, archived) counts as saved. */
export type Decision = "none" | "skipped" | "to_read" | "saved";
type RowState = NonNullable<ListPaper["readingState"]>;

export function decisionOf(
  state: Pick<RowState, "skippedAt" | "library"> | undefined,
): Decision {
  if (state?.library) return state.library === "to_read" ? "to_read" : "saved";
  return state?.skippedAt ? "skipped" : "none";
}
export const decisionLabels: Record<Exclude<Decision, "none">, string> = {
  skipped: "Skipped",
  to_read: "To read",
  saved: "Saved",
};

export const readingStateKey = (paperId: string) =>
  ["reading-state", paperId] as const;
const readState = async (paperId: string) =>
  (
    await apiGet(
      "/state?paperId=" + encodeURIComponent(paperId),
      statePageSchema,
    )
  ).items[0];

type FeedRows = InfiniteData<{
  items: { paperId: string; readingState?: RowState }[];
}>;
type Shown = Pick<RowState, "skippedAt" | "library">;
const listKeys = [["feed", false], ["triage"]] as const;
/** Shows a paper's decision on the loaded lists: the day's pages and the
 * triage queue, with its count of papers waiting in To read. */
function showOnLists(
  client: QueryClient,
  paperId: string,
  next: (row: RowState | undefined) => Shown,
) {
  const patch = <T extends { paperId: string; readingState?: RowState }>(
    item: T,
  ): T =>
    item.paperId === paperId
      ? {
          ...item,
          readingState: {
            readAt: item.readingState?.readAt ?? null,
            ...next(item.readingState),
          },
        }
      : item;
  client.setQueriesData<FeedRows>(
    { queryKey: listKeys[0] },
    (data) =>
      data && {
        ...data,
        pages: data.pages.map((page) => ({
          ...page,
          items: page.items.map(patch),
        })),
      },
  );
  client.setQueriesData<TriageQueue>({ queryKey: listKeys[1] }, (data) => {
    if (!data) return data;
    const items = data.items.map(patch);
    const waiting = (rows: typeof items) =>
      rows.filter(
        (row) =>
          row.paperId === paperId && decisionOf(row.readingState) === "to_read",
      ).length;
    return {
      ...data,
      items,
      toRead: data.toRead + waiting(items) - waiting(data.items),
    };
  });
}
/** The decision as the lists should show it before the server answers. */
const expected =
  (next: Decision) =>
  (row: RowState | undefined): Shown => {
    // An entry the reader has started stays, whatever is decided here.
    const kept =
      row?.library && row.library !== "to_read" && row.library !== "saved"
        ? row.library
        : null;
    if (kept) return { skippedAt: null, library: kept };
    if (next === "to_read" || next === "saved")
      return { skippedAt: null, library: next };
    // Skipping leaves a saved paper saved.
    if (next === "skipped" && row?.library === "saved")
      return { skippedAt: null, library: "saved" };
    return {
      skippedAt: next === "skipped" ? new Date().toISOString() : null,
      library: null,
    };
  };

/** Sends one decision. "none" takes the paper back to undecided: out of
 * To read or Saved, and no longer skipped. */
async function sendDecision(
  paperId: string,
  next: Decision,
  source: string,
): Promise<ReadingState | undefined> {
  if (next === "skipped")
    return apiMutation(
      "/events",
      "POST",
      { paperId, kind: "skip", source },
      readingStateSchema,
    );
  if (next === "to_read" || next === "saved") {
    await apiMutation(
      "/library",
      "POST",
      { paperId, source, status: next },
      libraryItemSchema,
    );
    return readState(paperId);
  }
  const current = await readState(paperId);
  // Only what a decision here could have made: an entry the reader has
  // started reading stays.
  if (
    current?.libraryRev &&
    (current.libraryStatus === "to_read" || current.libraryStatus === "saved")
  )
    await apiMutation(
      "/library/" + encodeURIComponent(paperId),
      "DELETE",
      { if_rev: current.libraryRev },
      libraryItemSchema,
    );
  if (current?.skippedAt)
    return apiMutation(
      "/events",
      "POST",
      { paperId, kind: "unskip", source },
      readingStateSchema,
    );
  return readState(paperId);
}

let inFlight: Promise<unknown> = Promise.resolve();
/** Decide about a paper: the lists show it at once, and the paper's own
 * reading state follows the server's answer. */
export function useDecide(source: "feed" | "web" = "feed") {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ paperId, to }: { paperId: string; to: Decision }) => {
      // One at a time and in order: an undo pressed right after a decision
      // must find that decision already stored.
      const sent = inFlight
        .catch(() => undefined)
        .then(() => sendDecision(paperId, to, source));
      inFlight = sent;
      return sent;
    },
    onMutate: async ({ paperId, to }) => {
      // A list read already under way would bring the old state back.
      await Promise.all(
        listKeys.map((queryKey) => client.cancelQueries({ queryKey })),
      );
      showOnLists(client, paperId, expected(to));
    },
    onSuccess: async (state, { paperId }) => {
      if (state) {
        client.setQueryData<StatePage>(readingStateKey(paperId), {
          items: [state],
          nextCursor: null,
        });
        // What the server stored, in case it differs from the guess.
        showOnLists(client, paperId, () => ({
          skippedAt: state.skippedAt,
          library: state.libraryStatus,
        }));
      }
      await client.invalidateQueries({ queryKey: ["library"] });
    },
    // The lists showed a decision the server did not take: read them again.
    onError: () =>
      Promise.all(
        listKeys.map((queryKey) => client.invalidateQueries({ queryKey })),
      ),
  });
}
