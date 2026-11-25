import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import type { ListPaper } from "@litscout/pipeline/read-contracts";
import type { WebFeed } from "@litscout/pipeline/web-contracts";
import { paperOptions, usePaper } from "./api";
import {
  filterPapers,
  matchesPaper,
  type Filters as FilterValues,
} from "./model";
export function readFilters(search: URLSearchParams) {
  return {
    topic: search.get("topic") ?? "",
    q: search.get("q") ?? "",
    source: search.get("source") ?? "",
    venue: search.get("venue") ?? "",
    kind: search.get("kind") ?? "",
    top: search.get("top") === "true",
    shortlisted: search.get("shortlisted") === "true",
    unread: search.get("unread") === "true",
    code: search.get("code") === "true",
    decision: decisionFilters.includes(search.get("decision") ?? "")
      ? search.get("decision")!
      : "",
  };
}
/** The decisions the list can be filtered by. */
export const decisionFilters = ["to_read", "saved", "skipped"];
/** The list's filters as they appear in the address. */
export const filterKeys = [
  "topic",
  "q",
  "source",
  "venue",
  "kind",
  "top",
  "shortlisted",
  "unread",
  "code",
  "decision",
];
/** What the reader's keys do where they apply. */
export type ReaderKeys = {
  move?: (delta: number) => void;
  close?: () => void;
  /** The paper's PDF, opened in a new tab unless readPdf shows it. */
  pdfUrl?: string;
  readPdf?: () => void;
  /** Further single keys for the page's mode, such as triage decisions. */
  extra?: Record<string, (() => void) | undefined>;
};
/** j / k move between papers, o opens the PDF and Escape closes, anywhere
 * inside the element that owns the handler, but never while typing or inside
 * a dialog or popover (they keep their own keys). */
export function readerShortcut(event: KeyboardEvent, keys: ReaderKeys) {
  const target = event.target;
  if (
    event.defaultPrevented ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    !(target instanceof HTMLElement) ||
    !event.currentTarget.contains(target) ||
    /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) ||
    target.isContentEditable ||
    target.closest(
      'dialog, [role="dialog"], [role="alertdialog"], [role="combobox"], [role="listbox"], [role="menu"], [popover], [contenteditable="true"]',
    )
  )
    return;
  const { move, close, pdfUrl, readPdf, extra } = keys;
  const action = {
    ...extra,
    j: move && (() => move(1)),
    k: move && (() => move(-1)),
    o:
      pdfUrl &&
      (() =>
        readPdf
          ? readPdf()
          : window.open(pdfUrl, "_blank", "noopener,noreferrer")),
    Escape: close,
  }[event.key];
  if (!action) return;
  event.preventDefault();
  action();
}
export function useReader(feed: WebFeed, isPublic: boolean, phone: boolean) {
  const [search, setSearch] = useSearchParams(),
    opener = useRef<{ element: HTMLButtonElement; key: string } | null>(null),
    phoneScroll = useRef<number | null>(null),
    listRef = useRef<HTMLElement | null>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const value = readFilters(search),
    papers = filterPapers(feed.items, { ...value, q: undefined }),
    id = search.get("paper");
  const source =
    search.get("paperSource") ??
    feed.items.find((paper) => id && matchesPaper(paper, id))?.source;
  const detail = usePaper(id, feed.day, isPublic, source ?? undefined),
    selected = detail.data ?? undefined;

  useLayoutEffect(() => {
    if (id || phoneScroll.current === null) return;
    window.scrollTo(0, phoneScroll.current);
    phoneScroll.current = null;
    const origin = opener.current?.element;
    (origin?.isConnected ? origin : listRef.current)?.focus({
      preventScroll: true,
    });
  }, [id]);

  const show = (paper: ListPaper, replace = false) => {
    const next = new URLSearchParams(search);
    next.set("paper", paper.paperId);
    next.set("paperSource", paper.source);
    setSearch(
      next,
      phone
        ? {
            replace,
            state: {
              fromPaperList: !id || location.state?.fromPaperList === true,
            },
          }
        : undefined,
    );
  };
  const open = (paper: ListPaper, element?: HTMLButtonElement) => {
    if (phone && !id) phoneScroll.current = window.scrollY;
    opener.current = element
      ? { element, key: `${paper.paperId}:${paper.source}` }
      : null;
    show(paper, phone && Boolean(id));
  };
  const close = () => {
    if (phone && location.state?.fromPaperList === true) {
      navigate(-1);
      return;
    }
    const next = new URLSearchParams(search);
    next.delete("paper");
    next.delete("paperSource");
    setSearch(next, { replace: phone });
    if (phone && phoneScroll.current !== null) return;
    const origin = opener.current;
    requestAnimationFrame(() => {
      if (
        origin?.element.isConnected &&
        origin.key === `${selected?.paperId}:${selected?.source}`
      )
        origin.element.focus();
      else listRef.current?.focus({ preventScroll: phone });
    });
  };
  // From the URL, not the loaded record, so quick j j j keeps counting
  // while the next paper loads.
  const at = id
    ? papers.findIndex(
        (paper) =>
          matchesPaper(paper, id) && (!source || paper.source === source),
      )
    : -1;
  // The papers next to the open one are fetched ahead, so j / k and
  // Previous / Next paint at once instead of waiting on a request.
  const client = useQueryClient();
  const before = at > 0 ? papers[at - 1] : undefined;
  const after = at >= 0 ? papers[at + 1] : undefined;
  const beforeKey = before && `${before.paperId}\n${before.source}`;
  const afterKey = after && `${after.paperId}\n${after.source}`;
  useEffect(() => {
    // Signed-in reading only: the public feed keeps its request count low.
    if (isPublic) return;
    for (const key of [beforeKey, afterKey]) {
      if (!key) continue;
      const [paperId, paperSource] = key.split("\n");
      void client.prefetchQuery(
        paperOptions(paperId, feed.day, isPublic, paperSource),
      );
    }
  }, [client, beforeKey, afterKey, feed.day, isPublic]);
  /** Fetch a paper's record ahead of a likely open, so it paints at once. */
  const prefetch = useCallback(
    (paper: ListPaper) => {
      if (isPublic) return;
      void client.prefetchQuery(
        paperOptions(paper.paperId, feed.day, isPublic, paper.source),
      );
    },
    [client, feed.day, isPublic],
  );
  /** The list row of the paper being opened, shown while its record loads. */
  const pendingRow = at >= 0 && !selected ? papers[at] : undefined;
  const move = (delta: number) => {
    const paper = papers[at + delta];
    if (!paper) return;
    // On a phone, moving replaces the open paper; the first one is opened.
    if (phone && id) show(paper, true);
    else open(paper);
  };
  const filter = (filters: FilterValues) => {
    const next = new URLSearchParams(search);
    for (const key of filterKeys) next.delete(key);
    for (const [key, value] of Object.entries(filters))
      if (value) next.set(key, String(value));
    next.delete("paper");
    next.delete("paperSource");
    setSearch(next);
  };
  const onSearch = (q: string) => {
    const next = new URLSearchParams(search);
    if (q) next.set("q", q);
    else next.delete("q");
    setSearch(next, { replace: true });
  };
  return {
    value,
    papers,
    id,
    selected,
    pendingRow,
    prefetch,
    detail,
    open,
    close,
    move,
    /** Whether there is a paper before and after the open one. */
    hasPrevious: at > 0,
    hasNext: at >= 0 && at < papers.length - 1,
    filter,
    onSearch,
    listRef,
  };
}
