import { useId, useState } from "react";
import { cn } from "./lib/utils";
import { readPanel } from "./origin";
import { useSearchParams } from "react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  libraryPageSchema,
  libraryQuery,
  libraryStatus,
} from "@litscout/pipeline/library-contracts";
import { Search, SlidersHorizontal } from "lucide-react";
import { apiGet } from "./api";
import { Button } from "./components/ui/button";
import { QueryState } from "./Notice";
import { EmptyState } from "./ReaderState";
import { PageHeader } from "./PageHeader";
import { formatTimestamp } from "./format";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "./components/ui/dialog";
import { MathText } from "./math-text";
import { fieldClass, labelClass, statusLabels } from "./library-ui";
import { AddPaperDialog } from "./LibraryAdd";
import { AlphaXivLink, SavedRow } from "./LibraryRows";
import { kindLabels } from "./venue-kinds";

export { fieldClass } from "./library-ui";

function withoutPanel(params: URLSearchParams) {
  const next = new URLSearchParams(params);
  next.delete("panel");
  return next.toString();
}

/** Filters that live in the dialog; search and status stay on the page. */
const dialogKeys = [
  "origin",
  "folder",
  "venue",
  "year",
  "kind",
  "top",
  "tags",
] as const;

export function Library({
  timezone,
  topVenues = [],
}: {
  timezone: string;
  /** The instance's top venues; the Top venues filter shows when set. */
  topVenues?: string[];
}) {
  const [params, setParams] = useSearchParams();
  // Beside the side panel the table keeps the columns that fit; the venue
  // and origin of the open paper are in the panel.
  const compact = readPanel(params.get("panel")) !== null;
  const [saved, setSaved] = useState("");
  const [searchError, setSearchError] = useState("");
  // The side panel is not a filter: opening or closing it keeps the rows
  // (and the link that opened it) instead of loading the list again.
  const applied = withoutPanel(params);
  const query = useInfiniteQuery({
    queryKey: ["library", applied],
    initialPageParam: "",
    queryFn: ({ signal, pageParam }) => {
      const next = new URLSearchParams(applied);
      if (pageParam) next.set("cursor", pageParam);
      return apiGet("/library?" + next, libraryPageSchema, signal);
    },
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const mirror = query.data?.pages[0]?.alphaXiv;
  // Build each change from the live URL, not from this render's copy: a
  // second change made before React re-renders (clear the filters, then the
  // search) must not bring back what the first one removed.
  const update = (change: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(window.location.search);
    change(next);
    setParams(next);
  };
  const status = params.get("status") ?? "";
  return (
    <main id="main" className="reader-page">
      <PageHeader
        title="Library"
        description={
          mirror?.syncedAt ? (
            <>
              alphaXiv mirror synced{" "}
              <time dateTime={mirror.syncedAt}>
                {formatTimestamp(mirror.syncedAt, timezone)}
              </time>
            </>
          ) : (
            "Your saved papers and the alphaXiv mirror."
          )
        }
        actions={<AddPaperDialog onSaved={setSaved} />}
      />
      <div className="flex flex-wrap items-center gap-2">
        <form
          role="search"
          aria-label="Search the library"
          className="flex items-center gap-2 rounded-sm bg-control px-2.5 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring max-md:w-full"
          onSubmit={(e) => {
            e.preventDefault();
            const q = String(new FormData(e.currentTarget).get("q")).trim();
            if (q && !libraryQuery.shape.q.safeParse(q).success) {
              setSearchError("Enter at least three characters to search.");
              return;
            }
            setSearchError("");
            update((next) => (q ? next.set("q", q) : next.delete("q")));
          }}
        >
          <Search aria-hidden="true" className="size-4 text-muted-foreground" />
          <label htmlFor="library-q" className="sr-only">
            Search title or author
          </label>
          <input
            id="library-q"
            key={params.get("q") ?? ""}
            name="q"
            type="search"
            maxLength={200}
            placeholder="Search title or author"
            defaultValue={params.get("q") ?? ""}
            className="min-h-9 w-64 min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground max-md:w-full"
          />
        </form>
        <LibraryFilters
          params={params}
          onApply={(values) =>
            update((next) => {
              for (const key of dialogKeys) next.delete(key);
              for (const [key, value] of Object.entries(values))
                next.set(key, value);
            })
          }
          folders={mirror?.folders ?? []}
          topVenues={topVenues}
        />
      </div>
      {searchError && (
        <p role="alert" className="text-sm text-destructive">
          {searchError}
        </p>
      )}
      {saved && (
        <p role="status" className="text-sm text-subtle">
          Saved {saved} to your library.
        </p>
      )}
      <div
        role="group"
        aria-label="Status"
        className="flex flex-wrap gap-1 max-md:flex-nowrap max-md:overflow-x-auto"
      >
        {["", ...libraryStatus.options].map((value) => (
          <Button
            key={value || "all"}
            type="button"
            variant="ghost"
            aria-pressed={status === value}
            className="shrink-0 text-subtle aria-pressed:bg-foreground aria-pressed:text-background aria-pressed:hover:bg-foreground"
            onClick={() =>
              update((next) =>
                value ? next.set("status", value) : next.delete("status"),
              )
            }
          >
            {value ? statusLabels[value as keyof typeof statusLabels] : "All"}
          </Button>
        ))}
      </div>
      {status === "to_read" && (
        <p className="max-w-[64ch] text-sm text-subtle">
          Papers you marked To read in a day&apos;s triage or from a paper. They
          wait here until you start one (set it to Reading) or remove it.
        </p>
      )}
      {query.isPending || (query.isError && !query.data) ? (
        <QueryState
          query={query}
          label="Loading library…"
          errorTitle="Library unavailable"
        />
      ) : items.length ? (
        <div className="rounded-lg bg-card p-1.5 md:overflow-x-auto">
          <table
            role="table"
            aria-label="Saved papers"
            className={cn(
              "library-results w-full text-left text-sm",
              !compact && "md:min-w-[45rem]",
            )}
          >
            <thead
              role="rowgroup"
              className="text-xs text-muted-foreground max-md:sr-only"
            >
              <tr role="row">
                {(compact
                  ? ["Paper", "Status", "Read it"]
                  : ["Paper", "Where", "Origin", "Status", "Read it"]
                ).map((heading) => (
                  <th
                    key={heading}
                    role="columnheader"
                    scope="col"
                    className="px-4 py-2 font-medium"
                  >
                    {heading}
                  </th>
                ))}
                <th role="columnheader" scope="col" className="w-10 px-2">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody role="rowgroup">
              {items.map((item) =>
                "paperId" in item ? (
                  <SavedRow key={item.paperId} item={item} compact={compact} />
                ) : (
                  <tr key={item.link.url} role="row">
                    <td
                      role="cell"
                      className="px-4 py-3 font-serif text-base font-semibold"
                      colSpan={compact ? 2 : 4}
                    >
                      <MathText text={item.title} />
                    </td>
                    <td role="cell" className="px-4 py-3 whitespace-nowrap">
                      <AlphaXivLink url={item.link.url} />
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded-lg bg-card">
          <EmptyState
            role="status"
            title={
              query.hasNextPage
                ? "No saved papers match on this page."
                : status === "to_read" && params.size === 1
                  ? "Nothing is waiting."
                  : applied
                    ? "No saved papers match these filters."
                    : "Your library is empty."
            }
            description={
              query.hasNextPage
                ? "Load more to keep searching."
                : status === "to_read" && params.size === 1
                  ? "Papers you mark To read will appear here."
                  : applied
                    ? "Clear or change the filters to see more papers."
                    : "Use Add paper to save your first one."
            }
          />
        </div>
      )}
      {query.isFetchNextPageError && (
        <p role="alert" className="text-sm text-destructive">
          Could not load more papers. Try again.
        </p>
      )}
      {query.hasNextPage && (
        <Button
          className="self-start"
          variant="outline"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? "Loading…" : "Load more"}
        </Button>
      )}
    </main>
  );
}

function LibraryFilters({
  params,
  folders,
  topVenues,
  onApply,
}: {
  params: URLSearchParams;
  folders: { id: string; path: string }[];
  topVenues: string[];
  onApply: (values: Record<string, string>) => void;
}) {
  const topHint = useId();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const count = dialogKeys.filter((key) =>
    key === "top" ? params.get(key) === "true" : params.get(key),
  ).length;
  const folder = params.get("folder") ?? "";
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary">
          <SlidersHorizontal data-icon="inline-start" aria-hidden="true" />
          Filters
          {count > 0 && (
            <>
              <span
                aria-hidden="true"
                className="grid min-w-[18px] place-items-center rounded-xs bg-primary px-1 text-[11px] font-semibold text-primary-foreground"
              >
                {count}
              </span>
              <span className="sr-only"> ({count})</span>
            </>
          )}
        </Button>
      </DialogTrigger>
      <DialogContent className="phone-sheet" aria-describedby={undefined}>
        <DialogTitle>Library filters</DialogTitle>
        <form
          aria-label="Library filters"
          className="library-filter-form grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            const values: Record<string, string> = {};
            for (const [key, raw] of new FormData(e.currentTarget)) {
              const value = String(raw).trim();
              if (value) values[key] = value;
            }
            if (!libraryQuery.safeParse(values).success) {
              setError("Check the filter values.");
              return;
            }
            setError("");
            onApply(values);
            setOpen(false);
          }}
        >
          <label className={labelClass}>
            Origin
            <select
              name="origin"
              className={fieldClass}
              defaultValue={params.get("origin") ?? ""}
            >
              <option value="">All origins</option>
              <option value="litscout">LitScout</option>
              <option value="alphaxiv">alphaXiv</option>
            </select>
          </label>
          <label className={labelClass}>
            Folder
            <select name="folder" className={fieldClass} defaultValue={folder}>
              <option value="">Any folder</option>
              {folder && !folders.some(({ id }) => id === folder) && (
                <option value={folder}>Selected folder</option>
              )}
              {folders.map(({ id, path }) => (
                <option key={id} value={id}>
                  {path}
                </option>
              ))}
            </select>
          </label>
          <label className={labelClass}>
            Venue
            <input
              name="venue"
              className={fieldClass}
              placeholder="Any"
              maxLength={200}
              defaultValue={params.get("venue") ?? ""}
            />
          </label>
          <label className={labelClass}>
            Year
            <input
              name="year"
              type="number"
              className={fieldClass}
              min={1000}
              max={9999}
              placeholder="Any"
              defaultValue={params.get("year") ?? ""}
            />
          </label>
          <label className={labelClass}>
            Type
            <select
              name="kind"
              className={fieldClass}
              defaultValue={params.get("kind") ?? ""}
            >
              <option value="">All types</option>
              {Object.entries(kindLabels).map(([kind, label]) => (
                <option key={kind} value={kind}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {topVenues.length > 0 && (
            <div className="flex flex-col justify-end gap-1">
              <label className="flex min-h-9 items-center gap-2 text-sm max-md:min-h-11">
                <input
                  type="checkbox"
                  name="top"
                  value="true"
                  className="size-4"
                  aria-describedby={topHint}
                  defaultChecked={params.get("top") === "true"}
                />
                Top venues only
              </label>
              <p id={topHint} className="text-xs text-muted-foreground">
                Venues marked top in your watchlist ({topVenues.length})
              </p>
            </div>
          )}
          <label className={labelClass + " sm:col-span-2"}>
            Tags
            <input
              name="tags"
              className={fieldClass}
              placeholder="Any"
              maxLength={500}
              defaultValue={params.get("tags") ?? ""}
            />
          </label>
          {error && (
            <p className="text-sm text-destructive sm:col-span-2" role="alert">
              {error}
            </p>
          )}
          <div className="flex gap-2 sm:col-span-2">
            <Button type="submit">Apply filters</Button>
            {count > 0 && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setError("");
                  onApply({});
                  setOpen(false);
                }}
              >
                Clear filters
              </Button>
            )}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
