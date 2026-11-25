import { formatDay } from "./format";

/** Where a paper was opened from, so its full page can name the way back. */
export type Origin = { label: string; path: string };

const pages: [RegExp, string][] = [
  [/^\/app\/today$/, "Today"],
  [/^\/app\/library$/, "Library"],
  [/^\/app\/trends$/, "Trends"],
  [/^\/app\/projects$/, "Projects"],
  [/^\/app\/ideas$/, "Ideas"],
  [/^\/app\/working-papers(?:\/[^/]+)?$/, "Working papers"],
  [/^\/app\/days$/, "Days"],
];

/** The page's name and address, minus any open side panel; null for pages
 * a paper is not opened from. */
export function originFor(pathname: string, search: string): Origin | null {
  const params = new URLSearchParams(search);
  params.delete("panel");
  const query = params.toString();
  const path = pathname + (query ? `?${query}` : "");
  const day = /^\/app\/days\/(\d{4}-\d{2}-\d{2})$/.exec(pathname)?.[1];
  if (day) return { label: formatDay(day), path };
  const label = pages.find(([pattern]) => pattern.test(pathname))?.[1];
  return label ? { label, path } : null;
}

/** A router state value, checked: only same-app paths are followed. */
export function readOrigin(state: unknown): Origin | null {
  const from = (state as { from?: unknown } | null)?.from as
    Partial<Origin> | undefined;
  return typeof from?.label === "string" &&
    typeof from.path === "string" &&
    from.path.startsWith("/app/")
    ? { label: from.label, path: from.path }
    : null;
}

export type PanelTarget =
  { kind: "paper"; id: string; source?: string } | { kind: "note"; id: string };

/** Paper and note ids as LitScout writes them (letters, digits, `_ . - /`);
 * anything else opens the full page instead. */
export const panelId = /^[\w./-]+$/;
const idPattern = panelId;

/** The side panel's target from the address: `paper:<id>[:<source>]` or
 * `note:<id>`. Anything else opens nothing. */
export function readPanel(value: string | null): PanelTarget | null {
  const [kind, id, source, ...rest] = (value ?? "").split(":");
  if (!id || !idPattern.test(id) || rest.length) return null;
  // No empty, "." or ".." path segments: the id goes into an API path.
  if (
    id.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    return null;
  if (kind === "note" && source === undefined) return { kind, id };
  if (kind === "paper" && (source === undefined || idPattern.test(source)))
    return { kind, id, source };
  return null;
}

/** A panel target as it reads in the address, `readPanel`'s inverse. */
export function panelValue(target: PanelTarget) {
  return [
    target.kind,
    target.id,
    ...(target.kind === "paper" && target.source ? [target.source] : []),
  ].join(":");
}

/** The current query with the panel set to `target`, or removed. */
export function panelSearch(search: string, target: PanelTarget | null) {
  const params = new URLSearchParams(search);
  if (target) params.set("panel", panelValue(target));
  else params.delete("panel");
  const query = params.toString();
  return query ? `?${query}` : "";
}
