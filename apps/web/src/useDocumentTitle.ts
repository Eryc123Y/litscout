import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useLocation } from "react-router";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { plainMath } from "./math-text";
import { readPanel } from "./origin";

const app = "LitScout";

const pages: [RegExp, string][] = [
  [/^\/(?:(?:app|public)(?:\/today)?\/?)?$/, "Today"],
  [/^\/(?:app|public)\/days\/?$/, "Days"],
  [/^\/app\/library$/, "Library"],
  [/^\/app\/trends$/, "Trends"],
  [/^\/app\/projects$/, "Projects"],
  [/^\/app\/ideas$/, "Ideas"],
  [/^\/app\/working-papers(?:\/[^/]+)?$/, "Working papers"],
  [/^\/app\/vault$/, "Vault sync"],
  [/^\/app\/health$/, "Health"],
  [/^\/app\/settings$/, "Settings"],
  [/^\/(?:app|public)\/papers\/[^/]+$/, "Paper"],
];

const shortDay = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

/** The id of the paper the page shows: a full paper page, the day
 * reader's open paper, or a paper in the side panel. */
export function openPaperId(pathname: string, search: string) {
  const page = /^\/(?:app|public)\/papers\/([^/]+)$/.exec(pathname)?.[1];
  if (page) return decodeURIComponent(page);
  const params = new URLSearchParams(search);
  const panel = readPanel(params.get("panel"));
  if (panel?.kind === "paper") return panel.id;
  return params.get("paper");
}

/** "<Page> · LitScout"; a paper's own title when one is open. */
export function pageTitle(pathname: string, paper?: string) {
  if (paper) return `${plainMath(paper)} · ${app}`;
  const day = /^\/(?:app|public)\/days\/(\d{4}-\d{2}-\d{2})$/.exec(
    pathname,
  )?.[1];
  const date = day ? new Date(day + "T00:00:00Z") : null;
  if (date && !Number.isNaN(date.getTime()))
    return `${shortDay.format(date).replace(",", "")} · ${app}`;
  const label = pages.find(([pattern]) => pattern.test(pathname))?.[1];
  return `${label ?? "Page not found"} · ${app}`;
}

/** A loaded title for the paper from the query cache; no extra request. */
function cachedTitle(client: QueryClient, id: string | null) {
  if (!id) return undefined;
  for (const [key, data] of client.getQueriesData<{ title?: unknown }>({
    queryKey: ["paper"],
  }))
    if (key[3] === id && typeof data?.title === "string") return data.title;
  return undefined;
}

/** Keeps `document.title` in step with the route and the open paper. */
export function useDocumentTitle() {
  const { pathname, search } = useLocation();
  const client = useQueryClient();
  const id = openPaperId(pathname, search);
  const subscribe = useCallback(
    (notify: () => void) => client.getQueryCache().subscribe(notify),
    [client],
  );
  const snapshot = () => cachedTitle(client, id);
  const paper = useSyncExternalStore(subscribe, snapshot, snapshot);
  const title = pageTitle(pathname, paper);
  useEffect(() => {
    document.title = title;
  }, [title]);
  useEffect(
    () => () => {
      document.title = app;
    },
    [],
  );
}
