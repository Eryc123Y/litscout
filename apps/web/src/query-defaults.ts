import type { QueryClientConfig } from "@tanstack/react-query";

const focusRefreshAfterMs = 5 * 60_000;

/** Coming back to the tab refreshes a query only when its data is at least
 * five minutes old: a trip to a PDF in another tab fetches nothing again,
 * and a return after a break still shows fresh data. */
export function refetchOnFocus(
  query: { state: { dataUpdatedAt: number; status?: string } },
  now = Date.now(),
) {
  const { dataUpdatedAt, status } = query.state;
  // A query that failed tries again when the reader comes back.
  if (status === "error") return true;
  return dataUpdatedAt > 0 && now - dataUpdatedAt >= focusRefreshAfterMs;
}

export const queryDefaults: QueryClientConfig = {
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      retry: 1,
      refetchOnWindowFocus: (query) => refetchOnFocus(query),
    },
  },
};
