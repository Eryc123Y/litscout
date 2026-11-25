import { z } from "zod";
import {
  useQuery,
  useInfiniteQuery,
  useQueryClient,
  queryOptions,
  infiniteQueryOptions,
  keepPreviousData,
  type QueryClient,
} from "@tanstack/react-query";
import { readCachedInstance, saveCachedInstance } from "./instance-cache";
import {
  webDayPageSchema,
  webCountsSchema,
  webFeedSchema,
  webPaperSchema,
  privateWebPaperSchema,
  privateWebFeedSchema,
  webDigestSchema,
  instanceSchema,
  paperSearchSchema,
} from "@litscout/pipeline/web-contracts";
const envelope = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
});
export async function apiGet<T>(
  path: string,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<T> {
  const response = await fetcher(`/api/v1${path}`, {
    credentials: "same-origin",
    signal,
    headers: { Accept: "application/json" },
  });
  const area = /^\/(library|notes|state)(?:[/?]|$)/.test(path)
    ? "library"
    : "feed";
  return parseApi(response, schema, area);
}
async function parseApi<T>(
  response: Response,
  schema: z.ZodType<T>,
  area: "feed" | "library",
) {
  if (response.status === 401 || response.status === 403)
    throw new Error(
      area === "feed"
        ? "Sign in to read the private feed."
        : "Sign in to use the library.",
    );
  if (!response.headers.get("content-type")?.includes("application/json"))
    throw new Error(
      `The server did not return ${area} data. Sign in and retry.`,
    );
  const result = envelope.parse(await response.json());
  if (!response.ok || !result.success)
    throw new Error(
      result.error?.message ??
        (area === "feed"
          ? "The feed could not be loaded."
          : "The library request failed."),
    );

  return schema.parse(result.data);
}
export async function apiMutation<T>(
  path: string,
  method: "POST" | "PATCH" | "DELETE",
  body: unknown,
  schema: z.ZodType<T>,
) {
  return parseApi(
    await fetch("/api/v1" + path, {
      method,
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    schema,
    "library",
  );
}

export function useInstance() {
  return useQuery({
    queryKey: ["instance"],
    queryFn: async ({ signal }) => {
      const instance = await apiGet("/instance", instanceSchema, signal);
      saveCachedInstance(instance);
      return instance;
    },
    // Start from the last answer this browser saw; it counts as stale, so
    // the request still runs and replaces it.
    initialData: readCachedInstance,
    initialDataUpdatedAt: 0,
  });
}
export function useDays(isPublic: boolean, before?: string) {
  return useQuery<z.infer<typeof webDayPageSchema>>({
    queryKey: ["days", isPublic, before],
    placeholderData: (previous, query) =>
      query?.queryKey[1] === isPublic ? keepPreviousData(previous) : undefined,
    queryFn: ({ signal }) =>
      apiGet(
        `${isPublic ? "/public/days" : "/feed/days"}?${new URLSearchParams({ view: "page", ...(before ? { before } : {}) })}`,
        webDayPageSchema,
        signal,
      ),
  });
}
const feedPageSize = 100;
function feedQueryString(
  filters: Record<string, string | boolean | undefined>,
) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters))
    if (value && (key !== "q" || Array.from(String(value).trim()).length >= 3))
      query.set(key, String(value));
  return query.toString();
}
/** One day's list, a page at a time. Shared by the page and by the prefetch
 * of a neighbouring day, so both read and fill the same cache entry. */
function feedOptions(
  client: QueryClient,
  day: string,
  isPublic: boolean,
  filters: Record<string, string | boolean | undefined>,
) {
  const query = feedQueryString(filters);
  return infiniteQueryOptions({
    queryKey: ["feed", isPublic, day, query],
    initialPageParam: "",
    queryFn: async ({ signal, pageParam }) => {
      const params = new URLSearchParams(query);
      // About 200 papers match on a busy day: two pages instead of four.
      params.set("limit", String(feedPageSize));
      if (pageParam) params.set("cursor", pageParam);
      const page = await apiGet(
        `${isPublic ? "/public/days" : "/feed/days"}/${day}?${params}`,
        isPublic ? webFeedSchema : privateWebFeedSchema,
        signal,
      );
      // The day's counts come with every page: the shell's Today badge
      // reads them from here instead of asking again.
      client.setQueryData(["feed-counts", isPublic, day], {
        day: page.day,
        status: page.status,
        counts: page.counts,
      });
      return page;
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}
export function useFeed(
  day: string,
  isPublic: boolean,
  filters: Record<string, string | boolean | undefined> = {},
) {
  const client = useQueryClient();
  return useInfiniteQuery({
    ...feedOptions(client, day, isPublic, filters),
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === isPublic &&
      previousQuery.queryKey[2] === day
        ? previous
        : undefined,
  });
}
/** The signed-in list leaves out papers the reader skipped, unless a
 * decision filter asks for them. */
export function openDecision(isPublic: boolean, decision?: string) {
  return isPublic ? {} : { decision: decision || "open" };
}
/** Fetch a day's first page ahead of a likely visit (the pointer or focus is
 * on its link), so the page opens from the cache with no loading step. It
 * asks for what the day page asks for when it opens with no filters. */
export function prefetchDay(
  client: QueryClient,
  day: string,
  isPublic: boolean,
) {
  return client.prefetchInfiniteQuery(
    feedOptions(client, day, isPublic, {
      shortlisted: true,
      ...openDecision(isPublic),
    }),
  );
}
/** Papers from every day whose title or summary matches, for the search box
 * on every page, narrowed by the day pages' venue filters. Signed-in
 * reading only; three characters or more. */
export function usePaperSearch(
  term: string,
  enabled: boolean,
  filters: { kind?: string; top?: boolean } = {},
) {
  const q = term.trim();
  const params = new URLSearchParams({ q });
  if (filters.kind) params.set("kind", filters.kind);
  if (filters.top) params.set("top", "true");
  return useQuery({
    queryKey: ["paper-search", params.toString()],
    enabled: enabled && Array.from(q).length >= 3,
    // The last results stay while the next ones load: no flash of nothing.
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      apiGet(`/search?${params}`, paperSearchSchema, signal),
  });
}
/** A summarised paper's record rarely changes while reading, and a
 * prefetched neighbour must still be fresh when j / k reaches it. One that
 * is missing or still waiting for its summary is checked again sooner. */
export function paperStaleTime(
  paper: { summaries?: readonly unknown[] } | null | undefined,
) {
  return paper?.summaries?.length ? 5 * 60_000 : 30_000;
}
export function paperOptions(
  id: string | null | undefined,
  day: string | undefined,
  isPublic: boolean,
  source?: string,
) {
  return queryOptions({
    queryKey: ["paper", isPublic, day, id, source],
    enabled: Boolean(id),
    staleTime: ({ state }: { state: { data?: unknown } }) =>
      paperStaleTime(state.data as Parameters<typeof paperStaleTime>[0]),
    queryFn: async ({ signal }) => {
      const path = `${isPublic ? "/public/papers" : "/papers"}/${encodeURIComponent(id!)}`;
      const get = (suffix = "") =>
        apiGet(
          path + suffix,
          (isPublic ? webPaperSchema : privateWebPaperSchema).nullable(),
          signal,
          async (url, init) => {
            const response = await fetch(url, init);
            return response.status === 404
              ? Response.json({ success: true, data: null })
              : response;
          },
        );
      if (!day && !source) return get();
      // Legacy links omit source. Resolve it once, then perform an explicit day/source read.
      const resolved = source ?? (await get())?.source;
      return resolved
        ? get(
            `?${new URLSearchParams({ ...(day ? { day } : {}), source: resolved })}`,
          )
        : null;
    },
  });
}
export function usePaper(
  id: string | null | undefined,
  day: string | undefined,
  isPublic: boolean,
  source?: string,
) {
  return useQuery(paperOptions(id, day, isPublic, source));
}
export function useDigest(day: string, isPublic: boolean, language: string) {
  return useQuery({
    queryKey: ["digest", day, language],
    queryFn: ({ signal }) =>
      apiGet(
        `/feed/days/${day}/digest?lang=${language}`,
        webDigestSchema,
        signal,
      ),
    enabled: !isPublic,
  });
}

export function useFeedCounts(
  day: string,
  isPublic: boolean,
  /** False where the day's feed is on the page and fills the counts. */
  fetchOwn = true,
) {
  return useQuery({
    queryKey: ["feed-counts", isPublic, day],
    enabled: Boolean(day) && fetchOwn,
    queryFn: ({ signal }) =>
      apiGet(
        `${isPublic ? "/public" : "/feed"}/days/${day}/counts`,
        webCountsSchema,
        signal,
      ),
  });
}
