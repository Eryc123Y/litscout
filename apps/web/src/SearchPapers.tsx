import { useEffect, useId, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import type { ListPaper } from "@litscout/pipeline/read-contracts";
import type { PaperSearchHit } from "@litscout/pipeline/web-contracts";
import { Search } from "lucide-react";
import { Button } from "./components/ui/button";
import { Toggle } from "./components/ui/toggle";
import {
  NativeSelect,
  NativeSelectOption,
} from "./components/ui/native-select";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandItem,
  CommandEmpty,
} from "./components/ui/command";
import { MathText } from "./math-text";
import { usePaperSearch } from "./api";
import { formatDay } from "./format";
import { originFor } from "./origin";
import { kindLabels } from "./venue-kinds";

/** Where a search hit opens: the reader on the day it was listed, or the
 * paper's own page if no day listed it. */
export function hitPath(hit: PaperSearchHit) {
  if (!hit.day) return `/app/papers/${encodeURIComponent(hit.paperId)}`;
  const params = new URLSearchParams({ paper: hit.paperId });
  if (hit.source) params.set("paperSource", hit.source);
  return `/app/days/${hit.day}?${params}`;
}

/** Keys the result list (cmdk) takes for itself; on the filters they
 * belong to the select and the toggle. */
const listKeys = new Set(["ArrowDown", "ArrowUp", "Home", "End", "Enter"]);

/**
 * The search box. On a day page (`onSearch` given) it filters that day's
 * list and shows the day's matches first; with `everyDay` it also finds
 * papers from every other day. In the top bar of the other signed-in pages
 * it searches every day only. The every-day results have the day pages'
 * Type and Top venues filters; a day's own list keeps its page's filters.
 */
export function SearchPapers({
  q = "",
  papers = [],
  onSearch,
  onOpen,
  searching = false,
  shortcutDisabled,
  everyDay = false,
  day,
  topVenues = [],
}: {
  /** The day's search, from the address. */
  q?: string;
  /** The day's papers that match it. */
  papers?: ListPaper[];
  /** Filters the day's list. Absent outside a day page. */
  onSearch?: (q: string) => void;
  onOpen?: (paper: ListPaper) => void;
  searching?: boolean;
  shortcutDisabled?: boolean;
  /** Also search every listed day (signed-in reading only). */
  everyDay?: boolean;
  /** The day this search sits on: its papers are left out of the others. */
  day?: string;
  /** The instance's top venues; the Top venues toggle shows when set. */
  topVenues?: string[];
}) {
  const [open, setOpen] = useState(false),
    trigger = useRef<HTMLButtonElement>(null),
    selecting = useRef(false),
    [draft, setDraft] = useState(q),
    // The query after typing settles: what the other days are searched for.
    [term, setTerm] = useState(q),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    onSearchRef = useRef(onSearch),
    [venues, setVenues] = useState({ kind: "", top: false }),
    kindId = useId();
  const navigate = useNavigate();
  const location = useLocation();
  const others = usePaperSearch(term, everyDay && open, venues);
  const hits = (others.data?.items ?? []).filter((hit) => hit.day !== day);
  const dayMode = Boolean(onSearch);
  useEffect(() => {
    onSearchRef.current = onSearch;
  }, [onSearch]);
  useEffect(() => {
    clearTimeout(timer.current);
    setDraft(q);
    setTerm(q);
  }, [q]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const changeSearch = (value: string) => {
    setDraft(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setTerm(value);
      onSearchRef.current?.(value);
    }, 250);
  };
  useEffect(() => {
    if (shortcutDisabled) return;
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [shortcutDisabled]);
  const settled = term.trim();
  const tooShort = settled.length > 0 && Array.from(settled).length < 3;
  const empty =
    searching || others.isFetching
      ? "Searching…"
      : tooShort
        ? "Enter at least three characters."
        : !dayMode && !settled
          ? "Type a few words of a title or summary."
          : dayMode || venues.kind || venues.top
            ? "No papers match these filters."
            : "No papers match.";
  return (
    <>
      <Button
        ref={trigger}
        variant="outline"
        className="w-full justify-start sm:w-72 max-md:size-11 max-md:justify-center"
        // The name contains the visible text (WCAG 2.5.3); the shortcut is
        // announced through aria-keyshortcuts, so the key hint is hidden.
        aria-label={q ? "Search papers: " + q : undefined}
        aria-keyshortcuts="Meta+k Control+k"
        onClick={() => setOpen(true)}
      >
        <Search data-icon="inline-start" />
        <span className="min-w-0 flex-1 truncate text-left max-md:sr-only">
          {q || "Search papers"}
        </span>
        <kbd
          aria-hidden="true"
          className="rounded border px-1 text-caption text-muted-foreground max-md:hidden"
        >
          ⌘K
        </kbd>
      </Button>
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Search papers"
        description={
          !dayMode
            ? "Papers from every day, by title and summary. Enter at least three characters."
            : everyDay
              ? "This day's papers by title and author, then other days' by title and summary. Enter at least three characters."
              : "Search this day's titles and authors. Enter at least three characters."
        }
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (!selecting.current) trigger.current?.focus();
          selecting.current = false;
        }}
      >
        <CommandInput
          aria-label={
            dayMode
              ? "Search titles and authors"
              : "Search titles and summaries"
          }
          placeholder={
            dayMode
              ? "Search titles and authors (3+ characters)"
              : "Search every day's papers (3+ characters)"
          }
          value={draft}
          onValueChange={changeSearch}
        />
        {everyDay && (
          <div
            role="group"
            aria-label={dayMode ? "Filters for other days" : "Search filters"}
            className="flex flex-wrap items-center gap-2 border-b px-3 py-2"
            onKeyDown={(event) => {
              if (listKeys.has(event.key)) event.stopPropagation();
            }}
          >
            <label
              htmlFor={kindId}
              className="text-xs font-semibold text-subtle"
            >
              Type
            </label>
            <NativeSelect
              id={kindId}
              size="sm"
              value={venues.kind}
              onChange={(event) =>
                setVenues({ ...venues, kind: event.target.value })
              }
            >
              <NativeSelectOption value="">All types</NativeSelectOption>
              {Object.entries(kindLabels).map(([kind, label]) => (
                <NativeSelectOption key={kind} value={kind}>
                  {label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            {topVenues.length > 0 && (
              <Toggle
                size="sm"
                className="px-3"
                pressed={venues.top}
                onPressedChange={(top) => setVenues({ ...venues, top })}
              >
                Top venues
              </Toggle>
            )}
          </div>
        )}
        <CommandList aria-label="Paper search results">
          <CommandEmpty>{empty}</CommandEmpty>
          {dayMode && papers.length > 0 && (
            <CommandGroup heading="This day's papers">
              {papers.map((paper) => (
                <CommandItem
                  key={`${paper.paperId}:${paper.source}`}
                  value={`${paper.paperId}:${paper.source}`}
                  onSelect={() => {
                    clearTimeout(timer.current);
                    setDraft(q);
                    selecting.current = true;
                    onOpen?.(paper);
                    setOpen(false);
                  }}
                >
                  <MathText text={paper.title} />
                  <span className="ml-auto text-xs text-muted-foreground">
                    {paper.source}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {everyDay && settled && !tooShort && hits.length > 0 && (
            <CommandGroup heading={dayMode ? "Other days" : "All days"}>
              {hits.map((hit) => (
                <CommandItem
                  key={hit.paperId}
                  value={`every-day:${hit.paperId}`}
                  onSelect={() => {
                    clearTimeout(timer.current);
                    selecting.current = true;
                    setOpen(false);
                    navigate(hitPath(hit), {
                      state: hit.day
                        ? undefined
                        : {
                            from: originFor(location.pathname, location.search),
                          },
                    });
                  }}
                >
                  <MathText text={hit.title} />
                  <span className="ml-auto flex shrink-0 items-baseline gap-1 text-xs text-muted-foreground">
                    {hit.venue && (
                      <>
                        <span
                          className="max-w-32 truncate sm:max-w-48"
                          title={hit.venue}
                        >
                          {hit.venue}
                        </span>
                        <span aria-hidden="true">·</span>
                      </>
                    )}
                    <span className="shrink-0">
                      {hit.day ? formatDay(hit.day) : "Not listed"}
                    </span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </CommandDialog>
    </>
  );
}
