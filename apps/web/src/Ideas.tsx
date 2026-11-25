import {
  useEffect,
  useId,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { useMenuPopover } from "./menu-popover";
import { Clock3, EllipsisVertical, GripVertical } from "lucide-react";
import { Link } from "react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { pendingCapture, vaultIdea } from "@litscout/pipeline/vault-contracts";
import { apiGet, apiMutation } from "./api";
import { CaptureDialog } from "./IdeaActions";
import { today } from "./model";
import { PageHeader } from "./PageHeader";
import { EmptyState, LoadingState, usePageAnnouncement } from "./ReaderState";
import { formatCount } from "./format";
import { cn } from "./lib/utils";
import {
  useIdeas,
  useRefreshResearch,
  useVaultRequest,
  useVaultStatus,
} from "./research-api";
import { Suggestions } from "./Suggestions";
import { usePhoneLayout } from "./useMediaQuery";
import { ObsidianLink } from "./ObsidianLink";
import { PanelLink } from "./SidePanel";
import { VaultTagEmptyState } from "./VaultConventions";
import { Button } from "./components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "./components/ui/dialog";
import { dragReducer, dropMove } from "./ideas-drag";

const columns = {
  seed: "Seed",
  exploring: "Exploring",
  "in-paper": "In a working paper",
  parked: "Parked",
} as const;
type Status = keyof typeof columns;
type Idea = z.output<typeof vaultIdea>;
const statuses = Object.keys(columns) as Status[];
const effectiveStatus = (idea: Idea) =>
  idea.statusRequest?.state === "queued"
    ? idea.statusRequest.status
    : (idea.status ?? "seed");
const ideaColumn = (idea: Idea) => {
  const status = effectiveStatus(idea);
  return status === "dropped" || statuses.some((column) => column === status)
    ? status
    : "seed";
};
/** The column a card returns to when its pending move is cancelled. */
const ownColumn = (idea: Idea) =>
  ideaColumn({ ...idea, statusRequest: null }) as Status;
const card =
  "reader-panel flex min-w-0 flex-col items-start gap-1.5 rounded-md p-3 wrap-anywhere";

function Column({
  title,
  children,
  capture = false,
  target = false,
  elementRef,
  panel,
}: {
  title: string;
  children: ReactNode;
  capture?: boolean;
  /** The column a dragged card would land in. */
  target?: boolean;
  elementRef?: (element: HTMLElement | null) => void;
  /** On phones a column is a tab's panel, named by its tab. */
  panel?: { id: string; tab: string; hidden: boolean };
}) {
  const id = useId();
  return (
    <section
      ref={elementRef}
      {...(panel
        ? {
            role: "tabpanel",
            id: panel.id,
            "aria-labelledby": panel.tab,
            hidden: panel.hidden,
          }
        : { "aria-labelledby": id })}
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-lg p-2 transition-shadow",
        capture
          ? "border border-dashed border-line-strong md:flex-row md:flex-wrap md:items-start"
          : "bg-control/40",
        target && "bg-control ring-2 ring-primary ring-inset",
      )}
    >
      {!panel && (
        <h2
          id={id}
          className={cn(
            "px-1.5 pt-1 text-[13px] font-semibold text-subtle",
            capture && "md:basis-full",
          )}
        >
          {title}
        </h2>
      )}
      {children}
    </section>
  );
}

/** A card's ⋮ menu: Move to, the non-drag way to move an idea. */
function IdeaMenu({
  title,
  current,
  disabled,
  triggerRef,
  onMove,
}: {
  title: string;
  current: Status;
  disabled: boolean;
  triggerRef: (button: HTMLButtonElement | null) => void;
  onMove: (status: Status, trigger: HTMLButtonElement | null) => void;
}) {
  const id = useId();
  const menu = useRef<HTMLDivElement>(null);
  useMenuPopover(menu);
  const trigger = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <Button
        ref={(button) => {
          trigger.current = button;
          triggerRef(button);
        }}
        type="button"
        variant="ghost"
        size="icon"
        className="-mt-0.5 -mr-1.5 ml-auto size-7 shrink-0 text-subtle max-md:size-11"
        aria-label={"Actions for " + title}
        popoverTarget={id}
        disabled={disabled}
      >
        <EllipsisVertical aria-hidden="true" />
      </Button>
      <div
        ref={menu}
        id={id}
        popover="auto"
        role="group"
        aria-label={"Actions for " + title}
        className="row-menu m-0 w-56 flex-col rounded-md border bg-card p-1.5 text-left text-sm text-foreground shadow-lg [&:popover-open]:flex"
      >
        {statuses
          .filter((status) => status !== current)
          .map((status) => (
            <Button
              key={status}
              type="button"
              variant="ghost"
              className="justify-start"
              onClick={() => {
                // Hiding the menu returns focus to the ⋮ button first.
                menu.current?.hidePopover?.();
                onMove(status, trigger.current);
              }}
            >
              Move to {columns[status]}
            </Button>
          ))}
      </div>
    </>
  );
}

function useRemoveRequest() {
  const refresh = useRefreshResearch();
  return useMutation({
    mutationFn: ({ id, rejected }: { id: string; rejected?: boolean }) =>
      apiMutation(
        "/vault/requests/" + id + (rejected ? "?clear=rejected" : ""),
        "DELETE",
        {},
        z.object(
          rejected
            ? { cleared: z.literal(true) }
            : { cancelled: z.literal(true) },
        ),
      ),
    onSuccess: refresh,
  });
}

function Captures() {
  const list = useQuery({
    queryKey: ["vault", "captures"],
    queryFn: ({ signal }) =>
      apiGet("/vault/captures", z.array(pendingCapture), signal),
  });
  const cancel = useRemoveRequest();
  return (
    <Column
      capture
      title={
        "Captured here" +
        (list.data?.length ? " · " + formatCount(list.data.length) : "")
      }
    >
      {list.isPending && <LoadingState compact label="Loading captures…" />}
      {(list.error || cancel.error) && (
        <EmptyState
          compact
          role="alert"
          title={(list.error ?? cancel.error)?.message}
        />
      )}
      {list.data?.length === 0 && (
        <EmptyState compact title="No captures waiting." />
      )}
      {list.data?.map((draft) => (
        <article className={cn(card, "md:w-64")} key={draft.id}>
          <h3 className="text-body leading-snug font-semibold">
            {draft.title}
          </h3>
          {draft.paperTitle && (
            <p className="text-xs text-subtle">From {draft.paperTitle}</p>
          )}
          <p className="text-xs text-subtle">
            {draft.applying
              ? "Sync has claimed this capture"
              : "Waiting for sync"}
          </p>
          {!draft.applying && (
            <div className="flex flex-wrap gap-1">
              <CaptureDialog draft={draft} />
              <Button
                variant="ghost"
                size="sm"
                disabled={cancel.isPending}
                aria-label={"Cancel " + draft.title}
                onClick={() => cancel.mutate({ id: draft.id })}
              >
                Cancel
              </Button>
            </div>
          )}
        </article>
      ))}
    </Column>
  );
}

export function Ideas({ timezone }: { timezone: string }) {
  const announce = usePageAnnouncement();
  const list = useIdeas();
  const request = useVaultRequest();
  const remove = useRemoveRequest();
  const vault = useVaultStatus();
  const [drag, dispatch] = useReducer(dragReducer<Status>, null);
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const columnEls = useRef(new Map<Status, HTMLElement>());
  // Phones show one column at a time behind tabs; a card can be dropped
  // on a tab as well as on the open column.
  const phone = usePhoneLayout();
  const [shown, setShown] = useState<Status>("seed");
  const tabEls = useRef(new Map<Status, HTMLElement>());
  const tabsId = useId();
  const columnAt = (x: number, y: number) => {
    for (const elements of [tabEls.current, columnEls.current])
      for (const [status, element] of elements) {
        const box = element.getBoundingClientRect();
        if (box.width === 0 && box.height === 0) continue;
        if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom)
          return status;
      }
    return null;
  };
  /** On a phone, open the column a card is about to land in. */
  const follow = (status: Status) => {
    if (phone) setShown(status);
  };
  /** A request that failed puts the view back, unless the reader has since
   * moved on to another tab. */
  const followBack = (left: Status, back: Status) => {
    if (phone) setShown((current) => (current === left ? back : current));
  };
  // Escape cancels a pointer drag from anywhere on the page.
  useEffect(() => {
    if (!drag) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      dispatch({ type: "end" });
      announce?.("Move cancelled.");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drag, announce]);
  const moveFocus = useRef<{
    id: string;
    control: HTMLButtonElement | HTMLSelectElement;
    destination: "move" | "cancel";
  } | null>(null);

  function restoreFocus(
    id: string,
    destination: "move" | "cancel",
    control: HTMLButtonElement | HTMLSelectElement | null,
  ) {
    const previous = moveFocus.current;
    if (
      !control ||
      previous?.id !== id ||
      previous.destination !== destination ||
      previous.control.isConnected
    )
      return;
    moveFocus.current = null;
    if (document.activeElement === document.body) control.focus();
  }
  const ideas = list.data?.pages.flatMap((page) => page.items) ?? [];
  const counts = Object.fromEntries(
    statuses.map((status) => [
      status,
      ideas.filter((idea) => ideaColumn(idea) === status).length,
    ]),
  ) as Record<Status, number>;
  const empty =
    list.isSuccess &&
    !list.hasNextPage &&
    ideas.every((idea) => ideaColumn(idea) === "dropped");
  function move(
    id: string,
    status: Status,
    control?: HTMLButtonElement | HTMLSelectElement,
  ) {
    const idea = ideas.find((item) => item.id === id);
    if (
      !idea ||
      ideaColumn(idea) === status ||
      idea.statusRequest?.state === "queued" ||
      request.isPending
    )
      return;
    // The queued card remounts in its new column; focus follows to Cancel.
    moveFocus.current = control?.matches(":focus")
      ? { id, control, destination: "cancel" }
      : null;
    const from = ideaColumn(idea) as Status;
    follow(status);
    request.mutate(
      { kind: "set_status", targetNoteId: id, status },
      {
        onSuccess: () => announce?.("Idea move requested. Waiting for sync."),
        onError: () => {
          moveFocus.current = null;
          followBack(status, from);
        },
      },
    );
  }
  function drop(grip?: HTMLButtonElement) {
    const target = dropMove(dragRef.current);
    dispatch({ type: "end" });
    if (target) move(target.id, target.to, grip);
    else announce?.("Move cancelled.");
  }
  // A pointer drag's listeners and long-press timer go with the board.
  const stopPointerDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => stopPointerDrag.current?.(), []);
  /** Drag from the grip: mouse and pen lift after a short movement, touch
   * after a 300 ms press so scrolling the board still works. */
  function startPointerDrag(
    event: PointerEvent<HTMLButtonElement>,
    idea: Idea,
  ) {
    if (event.button !== 0) return;
    const grip = event.currentTarget;
    const from = ideaColumn(idea) as Status;
    const startX = event.clientX,
      startY = event.clientY;
    const touch = event.pointerType === "touch";
    let lifted = false;
    const lift = () => {
      lifted = true;
      dispatch({
        type: "pick",
        id: idea.id,
        from,
        mode: "pointer",
        columns: statuses,
      });
      announce?.("Picked up " + idea.title + ".");
    };
    const timer = touch ? window.setTimeout(lift, 300) : 0;
    grip.setPointerCapture(event.pointerId);
    const onMove = (moved: globalThis.PointerEvent) => {
      const dx = moved.clientX - startX,
        dy = moved.clientY - startY;
      if (!lifted) {
        if (touch) {
          if (Math.hypot(dx, dy) > 8) stop();
          return;
        }
        if (Math.hypot(dx, dy) < 4) return;
        lift();
      }
      dispatch({
        type: "over",
        column: columnAt(moved.clientX, moved.clientY),
        dx,
        dy,
      });
    };
    const onUp = () => {
      const wasLifted = lifted;
      stop();
      if (wasLifted && dragRef.current) drop();
    };
    const onCancel = () => {
      stop();
      dispatch({ type: "end" });
    };
    function stop() {
      stopPointerDrag.current = null;
      window.clearTimeout(timer);
      grip.removeEventListener("pointermove", onMove);
      grip.removeEventListener("pointerup", onUp);
      grip.removeEventListener("pointercancel", onCancel);
    }
    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onUp);
    grip.addEventListener("pointercancel", onCancel);
    stopPointerDrag.current = stop;
  }
  /** Keyboard drag: Space or Enter picks up and drops; arrows choose the
   * column; Escape cancels. */
  function gripKeys(event: KeyboardEvent<HTMLButtonElement>, idea: Idea) {
    const mine = drag?.id === idea.id;
    const key = event.key;
    if (!mine) {
      if (key !== " " && key !== "Enter") return;
      event.preventDefault();
      dispatch({
        type: "pick",
        id: idea.id,
        from: ideaColumn(idea) as Status,
        mode: "keyboard",
        columns: statuses,
      });
      announce?.(
        "Picked up " +
          idea.title +
          ". Left and right arrows choose a column, Space drops, Escape cancels.",
      );
      return;
    }
    if (
      key === "ArrowRight" ||
      key === "ArrowDown" ||
      key === "ArrowLeft" ||
      key === "ArrowUp"
    ) {
      event.preventDefault();
      const by = key === "ArrowRight" || key === "ArrowDown" ? 1 : -1;
      const next = dragReducer(drag, { type: "step", by });
      dispatch({ type: "step", by });
      if (next?.over) announce?.("Over " + columns[next.over] + ".");
    } else if (key === " " || key === "Enter") {
      event.preventDefault();
      drop(event.currentTarget);
    }
  }
  /** Tabs: arrows, Home and End move and select (automatic activation). */
  function tabKeys(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = statuses.length - 1;
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % statuses.length
        : event.key === "ArrowLeft"
          ? (index + last) % statuses.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    const status = statuses[next]!;
    setShown(status);
    tabEls.current.get(status)?.focus();
  }
  /** Leaving the grip puts a keyboard-lifted card back. */
  function gripBlur(idea: Idea) {
    const current = dragRef.current;
    if (current?.mode !== "keyboard" || current.id !== idea.id) return;
    dispatch({ type: "end" });
    announce?.("Move cancelled.");
  }
  return (
    <main id="main" className="reader-page">
      <PageHeader
        title="Ideas"
        description="Drag a card by its grip to move it, or use its menu. Moves and captures reach your vault at the next sync."
        actions={
          empty ? undefined : (
            <>
              <Dialog>
                <DialogTrigger asChild>
                  <Button variant="secondary">Suggestions</Button>
                </DialogTrigger>
                <DialogContent
                  className="phone-sheet sm:max-w-xl"
                  aria-describedby={undefined}
                >
                  <DialogTitle>Today’s suggestions</DialogTitle>
                  <Suggestions day={today(timezone)} />
                </DialogContent>
              </Dialog>
              <CaptureDialog />
            </>
          )
        }
      />
      {vault.data?.last?.writeEnabled === false && (
        <p className="text-sm text-subtle">
          <strong className="font-medium text-foreground">
            Vault writes are off.
          </strong>{" "}
          Moves and captures are kept here until a sync with vault writes on
          applies them.{" "}
          <Link
            to="/app/vault"
            className="text-primary underline underline-offset-2"
          >
            Vault sync
          </Link>
        </p>
      )}
      {empty && (
        <VaultTagEmptyState field="ideaTag">
          <CaptureDialog />
        </VaultTagEmptyState>
      )}
      {list.isPending && <LoadingState label="Loading ideas…" />}
      {(list.error || request.error || remove.error) && (
        <EmptyState
          compact
          role="alert"
          title={(list.error ?? request.error ?? remove.error)?.message}
        />
      )}
      <div className="flex min-w-0 flex-col gap-3">
        <Captures />
        <div className="flex min-w-0 flex-col gap-3">
          {phone && list.data && (
            <div
              role="tablist"
              aria-label="Idea status"
              className="sticky top-0 z-30 flex min-w-0 gap-0.5 overflow-x-auto border-b border-line bg-background [scrollbar-width:none]"
            >
              {statuses.map((status, index) => {
                const selected = shown === status;
                const dropTarget =
                  drag !== null &&
                  drag.over === status &&
                  drag.over !== drag.from;
                return (
                  <button
                    key={status}
                    ref={(element) => {
                      if (element) tabEls.current.set(status, element);
                      else tabEls.current.delete(status);
                    }}
                    type="button"
                    role="tab"
                    id={`${tabsId}-tab-${status}`}
                    aria-controls={`${tabsId}-panel-${status}`}
                    aria-selected={selected}
                    tabIndex={selected ? 0 : -1}
                    data-drop-target={dropTarget ? "" : undefined}
                    onClick={() => setShown(status)}
                    onKeyDown={(event) => tabKeys(event, index)}
                    className={cn(
                      "-mb-px h-11 shrink-0 border-b-2 border-transparent px-3 text-sm whitespace-nowrap text-subtle",
                      selected &&
                        "border-foreground font-medium text-foreground",
                      dropTarget &&
                        "rounded-t-md bg-control text-foreground ring-2 ring-primary ring-inset",
                    )}
                  >
                    {columns[status]}{" "}
                    <span className="tabular-nums">
                      {formatCount(counts[status])}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {/* Four status columns in one row from 1100 px. */}
          <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2 min-[68.75rem]:grid-cols-4">
            {list.data &&
              statuses.map((status) => {
                const cards = ideas.filter(
                  (idea) => ideaColumn(idea) === status,
                );
                return (
                  <Column
                    key={status}
                    title={columns[status] + " · " + formatCount(cards.length)}
                    panel={
                      phone
                        ? {
                            id: `${tabsId}-panel-${status}`,
                            tab: `${tabsId}-tab-${status}`,
                            hidden: shown !== status,
                          }
                        : undefined
                    }
                    target={Boolean(drag) && drag?.over === status}
                    elementRef={(element) => {
                      if (element) columnEls.current.set(status, element);
                      else columnEls.current.delete(status);
                    }}
                  >
                    {!cards.length && (
                      <EmptyState compact title="No ideas yet." />
                    )}
                    {cards.map((idea) => {
                      const change = idea.statusRequest;
                      const waiting = change?.state === "queued";
                      const rejected = change?.state === "rejected";
                      return (
                        <article
                          className={cn(
                            card,
                            "relative",
                            drag?.id === idea.id &&
                              "z-30 shadow-xl ring-1 ring-line-strong motion-safe:scale-[1.02]",
                            drag?.id === idea.id &&
                              drag.mode === "keyboard" &&
                              "ring-2 ring-primary",
                            // On a phone the lifted card can cover the tab
                            // it is over; let the highlight show through.
                            drag?.id === idea.id &&
                              drag.mode === "pointer" &&
                              "max-md:opacity-85",
                          )}
                          key={idea.id}
                          style={
                            drag?.id === idea.id && drag.mode === "pointer"
                              ? { translate: `${drag.dx}px ${drag.dy}px` }
                              : undefined
                          }
                        >
                          <div className="flex w-full items-start gap-1.5">
                            <button
                              type="button"
                              aria-label={"Drag " + idea.title}
                              aria-pressed={drag?.id === idea.id}
                              disabled={waiting || request.isPending}
                              className="-ml-1 mt-0.5 grid size-6 shrink-0 cursor-grab touch-none place-items-center rounded-xs text-muted-foreground hover:bg-control hover:text-foreground active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-40 max-md:size-11"
                              onPointerDown={(event) =>
                                startPointerDrag(event, idea)
                              }
                              onKeyDown={(event) => gripKeys(event, idea)}
                              onBlur={() => gripBlur(idea)}
                            >
                              <GripVertical
                                aria-hidden="true"
                                className="size-4"
                              />
                            </button>
                            <h3 className="text-body leading-snug font-semibold">
                              {idea.title}
                            </h3>
                            <IdeaMenu
                              title={idea.title}
                              current={status}
                              disabled={waiting || request.isPending}
                              triggerRef={(button) => {
                                if (!change)
                                  restoreFocus(idea.id, "move", button);
                              }}
                              onMove={(to, trigger) =>
                                move(idea.id, to, trigger ?? undefined)
                              }
                            />
                          </div>
                          {idea.description && (
                            <p className="text-sm text-subtle">
                              {idea.description}
                            </p>
                          )}
                          <p className="text-xs text-subtle">
                            {formatCount(idea.paperIds.length)}{" "}
                            {idea.paperIds.length === 1 ? "paper" : "papers"} ·{" "}
                            {idea.projectTitle ?? "No project"}
                          </p>
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                            <PanelLink
                              target={{ kind: "note", id: idea.id }}
                              className="text-sm font-medium text-primary"
                              label={"Read note: " + idea.title}
                            >
                              Read note
                            </PanelLink>
                            <ObsidianLink path={idea.path}>
                              Open in Obsidian
                            </ObsidianLink>
                          </div>
                          {change && (
                            <p
                              className={cn(
                                "flex flex-wrap items-center gap-x-2 text-xs",
                                rejected ? "text-destructive" : "text-subtle",
                              )}
                            >
                              {rejected ? (
                                <>Sync rejected the move. {change.reason}</>
                              ) : (
                                <>
                                  <Clock3
                                    aria-hidden="true"
                                    className="size-3.5 shrink-0"
                                  />
                                  <span>Waiting for sync</span>
                                </>
                              )}
                              <Button
                                ref={(button) => {
                                  if (waiting)
                                    restoreFocus(idea.id, "cancel", button);
                                }}
                                variant="link"
                                size="sm"
                                className="h-auto p-0 text-xs max-md:min-h-11"
                                disabled={remove.isPending}
                                aria-label={
                                  (rejected
                                    ? "Clear rejected move for "
                                    : "Cancel move for ") + idea.title
                                }
                                onClick={(event) => {
                                  const control = event.currentTarget;
                                  moveFocus.current = control.matches(":focus")
                                    ? {
                                        id: idea.id,
                                        control,
                                        destination: "move",
                                      }
                                    : null;
                                  const own = ownColumn(idea);
                                  follow(own);
                                  remove.mutate(
                                    { id: change.id, rejected },
                                    {
                                      onError: () => {
                                        moveFocus.current = null;
                                        followBack(own, status);
                                      },
                                    },
                                  );
                                }}
                              >
                                {rejected ? "Clear" : "Cancel"}
                              </Button>
                            </p>
                          )}
                        </article>
                      );
                    })}
                  </Column>
                );
              })}
          </div>
          {list.hasNextPage && (
            <Button
              className="self-start"
              variant="outline"
              disabled={list.isFetchingNextPage}
              onClick={() => void list.fetchNextPage()}
            >
              Load more ideas
            </Button>
          )}
        </div>
      </div>
      {phone && drag && (
        // The page live region already announces each step; this is the
        // visible hint above the phone navigation.
        <p
          aria-hidden="true"
          className="fixed inset-x-4 bottom-[calc(var(--phone-nav-height)+12px)] z-40 rounded-md bg-card px-3 py-2.5 text-[13px] text-subtle shadow-lg ring-1 ring-line"
        >
          {drag.over && drag.over !== drag.from ? (
            <>
              Drop on{" "}
              <b className="font-semibold text-foreground">
                {columns[drag.over]}
              </b>{" "}
              to move it there
            </>
          ) : (
            "Drop on a tab to move it there"
          )}
        </p>
      )}
    </main>
  );
}
