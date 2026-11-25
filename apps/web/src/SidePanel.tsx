import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { ArrowLeft, X } from "lucide-react";
import { useInstance, usePaper } from "./api";
import { Paper } from "./Paper";
import { QueryState } from "./Notice";
import { EmptyState } from "./ReaderState";
import { NoteBody, useVaultNote } from "./VaultNote";
import { ObsidianLink } from "./ObsidianLink";
import { SplitHandle } from "./SplitHandle";
import { Button } from "./components/ui/button";
import { usePhoneLayout } from "./useMediaQuery";
import { panelId, panelSearch, readPanel, type PanelTarget } from "./origin";
import { cn } from "./lib/utils";

const widthKey = "litscout.panelWidth";
const widthMin = 360;
const widthMax = 900;
const widthDefault = 560;

function readWidth() {
  try {
    const value = Number(globalThis.localStorage?.getItem(widthKey) ?? NaN);
    return Number.isFinite(value)
      ? Math.min(widthMax, Math.max(widthMin, Math.round(value)))
      : widthDefault;
  } catch {
    return widthDefault;
  }
}
function saveWidth(width: number) {
  try {
    globalThis.localStorage?.setItem(widthKey, String(width));
  } catch {
    // The width resets next visit.
  }
}

/** The link that opened the panel, and where it sat on screen: the page
 * under the panel narrows, and this keeps that link in place. The opener
 * also gets focus back when the panel closes. */
let anchor: { element: Element; top: number } | null = null;
let opener: { element: HTMLElement; target: string } | null = null;
function rememberAnchor(
  element: HTMLElement,
  target: string,
  alreadyOpen: boolean,
) {
  opener = { element, target };
  // A link to what is already open changes nothing to keep in place.
  if (alreadyOpen) return;
  anchor = { element, top: element.getBoundingClientRect().top };
  // Forget it if the panel did not change (a modified click, say).
  requestAnimationFrame(() => {
    if (anchor?.element === element) anchor = null;
  });
}

const sameTarget = (a: PanelTarget | null, b: PanelTarget) =>
  a?.kind === b.kind && a.id === b.id;
const targetKey = (target: PanelTarget) => `${target.kind}:${target.id}`;

/** The opener, or the link that replaced it when the page re-rendered its
 * rows (a table leaving its compact mode, a refetched list). */
function openerElement(from: typeof opener): HTMLElement | null {
  if (!from) return null;
  if (from.element.isConnected) return from.element;
  const links = document.querySelectorAll<HTMLElement>("[data-panel-link]");
  for (const link of links)
    if (link.dataset.panelLink === from.target && !link.closest(".side-panel"))
      return link;
  return null;
}

/** Opens a paper or a note in the side panel, keeping the page as it is. */
export function PanelLink({
  target,
  children,
  className,
  label,
}: {
  target: PanelTarget;
  children: ReactNode;
  className?: string;
  /** A fuller name for screen readers that starts with the visible text. */
  label?: string;
}) {
  const location = useLocation();
  const open = readPanel(new URLSearchParams(location.search).get("panel"));
  const current = sameTarget(open, target);
  if (!panelId.test(target.id))
    return target.kind === "paper" ? (
      <Link
        to={`/app/papers/${encodeURIComponent(target.id)}`}
        className={className}
      >
        {children}
      </Link>
    ) : null;
  return (
    <Link
      to={{
        pathname: location.pathname,
        search: panelSearch(location.search, target),
      }}
      className={className}
      aria-label={label}
      aria-current={current ? "true" : undefined}
      data-panel-link={targetKey(target)}
      onClick={(event) =>
        rememberAnchor(event.currentTarget, targetKey(target), current)
      }
    >
      {children}
    </Link>
  );
}

/** The side panel for every page outside the day reader: a paper or a
 * project, idea or draft note, beside the page on wider screens and over
 * it on a phone. Escape or Close puts it away. */
export function SidePanel() {
  const [search, setSearch] = useSearchParams();
  const target = readPanel(search.get("panel"));
  const phone = usePhoneLayout();
  const [width, setWidth] = useState(readWidth);
  const panel = useRef<HTMLElement>(null);
  const returnFocus = useRef<typeof opener>(null);
  const note = useVaultNote(
    target?.kind === "note" ? target.id : "",
    target?.kind === "note",
  );
  const paper = usePaper(
    target?.kind === "paper" ? target.id : null,
    undefined,
    false,
    target?.kind === "paper" ? target.source : undefined,
  );
  const close = useCallback(() => {
    const next = new URLSearchParams(search);
    next.delete("panel");
    // Replace, so Back does not reopen what was just closed.
    setSearch(next, { replace: true });
    // Focus goes back once the panel has really left (the layout effect
    // below), however long the navigation takes.
    returnFocus.current = opener;
    opener = null;
  }, [search, setSearch]);
  const key = target ? `${target.kind}:${target.id}` : "";
  useLayoutEffect(() => {
    const back = returnFocus.current;
    returnFocus.current = null;
    // Closed: the opener gets focus. Another panel opened: it keeps it.
    if (!key) openerElement(back)?.focus({ preventScroll: true });
  }, [key]);
  // Reserve the panel's width on the page (CSSOM keeps the CSP strict).
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (!key) return;
    root.style.setProperty("--panel-width", `${width}px`);
    root.dataset.sidePanel = "";
    return () => {
      delete root.dataset.sidePanel;
    };
  }, [key, width]);
  // The page narrows or widens; keep the link that opened the panel where
  // it was, so nothing seems to move.
  useLayoutEffect(() => {
    if (!anchor) return;
    const { element, top } = anchor;
    anchor = null;
    const shift = element.isConnected
      ? element.getBoundingClientRect().top - top
      : 0;
    if (!phone && shift) window.scrollBy(0, shift);
  }, [key, phone]);
  useLayoutEffect(() => {
    if (!key) return;
    panel.current?.querySelector(".side-panel-body")?.scrollTo?.(0, 0);
    // The panel itself takes focus: its heading may still be loading.
    panel.current?.focus({ preventScroll: true });
  }, [key]);
  useEffect(() => {
    if (!key) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const inField = (event.target as Element | null)?.closest?.(
        "input, textarea, select, [role=dialog], [popover]",
      );
      if (!inField) close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [key, close]);
  if (!target) return null;
  const title = target.kind === "note" ? note.data?.title : paper.data?.title;
  const kind = target.kind === "note" ? "Note" : "Paper";
  return (
    <aside
      ref={panel}
      aria-label={title ? `${kind}: ${title}` : kind}
      tabIndex={-1}
      className="side-panel"
    >
      {phone ? null : (
        <SplitHandle
          width={width}
          onChange={setWidth}
          onCommit={saveWidth}
          label="Resize the side panel"
          className="side-panel-handle"
          min={widthMin}
          max={widthMax}
          invert
        />
      )}
      <div className="side-panel-bar">
        {phone ? (
          <Button variant="ghost" onClick={close}>
            <ArrowLeft data-icon="inline-start" />
            Back
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">
            {target.kind === "note" ? "Note" : "Paper"}
          </span>
        )}
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close panel"
          className={cn(phone && "sr-only")}
          onClick={close}
        >
          <X />
        </Button>
      </div>
      <div className="side-panel-body">
        {target.kind === "note" ? (
          <PanelNote id={target.id} />
        ) : (
          <PanelPaper id={target.id} source={target.source} query={paper} />
        )}
      </div>
    </aside>
  );
}

function PanelNote({ id }: { id: string }) {
  const note = useVaultNote(id);
  return (
    <article className="flex min-w-0 flex-col gap-3">
      <h2 tabIndex={-1} className="font-serif text-2xl font-semibold">
        {note.data?.title ?? "Note"}
      </h2>
      <p className="text-sm text-muted-foreground">
        Read-only. Edit the note in Obsidian.
      </p>
      <div className="note-reading">
        <NoteBody id={id} />
      </div>
      {note.data ? (
        <div>
          <ObsidianLink path={note.data.path}>Open in Obsidian</ObsidianLink>
        </div>
      ) : null}
    </article>
  );
}

function PanelPaper({
  id,
  source,
  query,
}: {
  id: string;
  source?: string;
  query: ReturnType<typeof usePaper>;
}) {
  const instance = useInstance();
  if (query.isPending || query.isError || instance.isPending)
    return (
      <QueryState
        query={query.isError ? query : instance}
        label="Paper loading…"
        errorTitle="Paper unavailable"
        retryLabel="Retry paper"
      />
    );
  if (!query.data)
    return <EmptyState compact title="This paper is no longer in LitScout." />;
  const info = instance.data;
  return (
    <Paper
      paper={query.data}
      privateActions
      language={info?.language ?? "en"}
      timezone={info?.timezone ?? "UTC"}
      topics={info?.topics ?? []}
      keywordOnly={info?.keywordOnly === true}
      fullHref={`/app/papers/${encodeURIComponent(id)}${source ? `?${new URLSearchParams({ source })}` : ""}`}
    />
  );
}
