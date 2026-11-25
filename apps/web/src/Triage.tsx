import { useId, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import {
  BookmarkPlus,
  Clock,
  EyeOff,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import {
  triageQueueSchema,
  type TriageRow,
} from "@litscout/pipeline/web-contracts";
import { apiGet } from "./api";
import { decisionOf, useDecide, type Decision } from "./decisions";
import { countOf, formatCount } from "./format";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { MathText } from "./math-text";
import { filterKeys } from "./useReader";

/** Above this many papers on the reader's topics, rows start compact. */
export const compactAbove = 60;
/** A rough pace for the time left: a glance at the summary and a key. */
const secondsPerPaper = 15;

export type QueueSize = "picks" | "all";
const sizeKey = "litscout:triage-size";
const readSize = (): QueueSize => {
  try {
    return localStorage.getItem(sizeKey) === "picks" ? "picks" : "all";
  } catch {
    return "all";
  }
};
export const reasonLabels: Record<TriageRow["reason"], string> = {
  radar: "On your project radar",
  pick: "Picked by the brief",
  code: "Public code",
};

/** The day's triage queue and the reader's way through it. The queue page
 * itself is the reader: this hook only knows the rows and the decisions. */
export function useTriage(day: string, enabled: boolean) {
  const [search, setSearch] = useSearchParams();
  const query = useQuery({
    queryKey: ["triage", day],
    enabled,
    queryFn: ({ signal }) =>
      apiGet(`/feed/days/${day}/triage`, triageQueueSchema, signal),
  });
  const [size, setSizeState] = useState(readSize);
  const setSize = (next: QueueSize) => {
    setSizeState(next);
    try {
      localStorage.setItem(sizeKey, next);
    } catch {
      /* The choice then lasts for this visit only. */
    }
  };
  const all = query.data?.items;
  const rows = useMemo(
    () => (all ?? []).filter((row) => size === "all" || row.reason !== "code"),
    [all, size],
  );
  const decide = useDecide("feed");
  const [history, setHistory] = useState<
    { paper: TriageRow; from: Decision }[]
  >([]);
  const active = enabled && search.get("triage") === "1" && rows.length > 0;
  const undecided = (row: TriageRow) => decisionOf(row.readingState) === "none";
  const go = (paper: TriageRow | undefined, on: boolean) => {
    // Triage walks the queue as it is: the list's filters do not apply.
    const next = new URLSearchParams(search);
    for (const key of [...filterKeys, "paper", "paperSource", "triage"])
      next.delete(key);
    if (on) next.set("triage", "1");
    if (paper) {
      next.set("paper", paper.paperId);
      next.set("paperSource", paper.source);
    }
    setSearch(next);
  };
  return {
    /** The queue at the chosen size, in order. */
    rows,
    /** Every queued paper, whatever the size: the rows' badges use it. */
    all: all ?? [],
    toRead: query.data?.toRead ?? 0,
    size,
    setSize,
    active,
    left: rows.filter(undecided).length,
    start: () => go(rows.find(undecided) ?? rows[0], true),
    exit: () => go(undefined, false),
    /** The next paper still to decide, after the given one and wrapping. */
    nextAfter(paperId: string) {
      const at = rows.findIndex((row) => row.paperId === paperId);
      return [...rows.slice(at + 1), ...rows.slice(0, Math.max(at, 0))].find(
        undecided,
      );
    },
    decide(paper: TriageRow, to: Decision) {
      const from = decisionOf(paper.readingState);
      if (from === to) return;
      setHistory((past) => [...past.slice(-49), { paper, from }]);
      decide.mutate({ paperId: paper.paperId, to });
    },
    canUndo: history.length > 0,
    /** Takes back the last decision; returns its paper, to show it again. */
    undo() {
      const last = history.at(-1);
      if (!last) return undefined;
      setHistory((past) => past.slice(0, -1));
      decide.mutate({ paperId: last.paper.paperId, to: last.from });
      return last.paper;
    },
    error: decide.error,
  };
}
export type Triage = ReturnType<typeof useTriage>;

/** The queue's place at the top of the day's list: what is in it, how far
 * the reader is, and the way in. */
export function TriageCard({
  triage,
  onTopics,
}: {
  triage: Triage;
  /** Papers on the reader's topics that day. */
  onTopics: number;
}) {
  const id = useId();
  const { rows, all, left } = triage;
  if (!all.length) return null;
  const count = (reason: TriageRow["reason"]) =>
    rows.filter((row) => row.reason === reason).length;
  const parts = [
    count("radar") && `${formatCount(count("radar"))} on your project radar`,
    count("pick") && `${formatCount(count("pick"))} picked by the brief`,
    count("code") && `${formatCount(count("code"))} more with public code`,
  ].filter(Boolean);
  const decided = rows.length - left;
  const minutes = Math.max(1, Math.round((left * secondsPerPaper) / 60));
  return (
    <section
      // Named apart from the "Papers" region it sits in.
      aria-label="Triage queue"
      className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-4"
    >
      <div className="flex flex-col gap-1">
        <h2 className="reader-section-title">
          {formatCount(rows.length)} of {countOf(onTopics, "paper")}{" "}
          {rows.length === 1 ? "is" : "are"} worth a decision
        </h2>
        <p className="text-[13px] text-muted-foreground">{parts.join(" · ")}</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <progress
          id={`${id}-progress`}
          className="triage-progress"
          max={Math.max(rows.length, 1)}
          value={decided}
        />
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs text-muted-foreground">
          <label htmlFor={`${id}-progress`}>
            {left
              ? `${formatCount(decided)} decided · ${formatCount(left)} left · about ${minutes} min`
              : `All ${formatCount(rows.length)} decided`}
          </label>
          <Link
            to="/app/library?status=to_read"
            className="text-primary underline-offset-4 hover:underline"
          >
            Library · To read {formatCount(triage.toRead)}
          </Link>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {triage.active ? (
          <Button variant="outline" onClick={triage.exit}>
            Back to the full list
          </Button>
        ) : (
          <Button onClick={triage.start}>
            {left === 0
              ? "Review the queue"
              : decided
                ? "Continue triage"
                : "Start triage"}
          </Button>
        )}
        <div
          role="group"
          aria-label="Queue size"
          className="flex items-center gap-0.5 rounded-md bg-control p-0.5"
        >
          {(
            [
              ["picks", "Brief's picks only"],
              ["all", "Picks + code"],
            ] as const
          ).map(([value, label]) => (
            <Button
              key={value}
              type="button"
              variant="ghost"
              size="sm"
              aria-pressed={triage.size === value}
              className="text-subtle aria-pressed:bg-card aria-pressed:text-foreground aria-pressed:shadow-xs"
              onClick={() => triage.setSize(value)}
            >
              {label}
            </Button>
          ))}
        </div>
      </div>
    </section>
  );
}

const decisions: {
  to: Exclude<Decision, "none">;
  label: string;
  key: string;
  icon: LucideIcon;
}[] = [
  { to: "skipped", label: "Skip", key: "x", icon: EyeOff },
  { to: "to_read", label: "To read", key: "l", icon: Clock },
  { to: "saved", label: "Save", key: "s", icon: BookmarkPlus },
];
/** The keys of the decision bar, for the page's key handler. */
export const triageKeys = Object.fromEntries(
  decisions.map(({ key, to }) => [key, to]),
) as Record<string, Exclude<Decision, "none">>;

/** The decision on the open paper, above it in the reader. Each choice
 * moves on to the next paper still to decide. */
export function TriageBar({
  paper,
  position,
  total,
  onDecide,
  onUndo,
}: {
  paper: TriageRow;
  position: number;
  total: number;
  onDecide: (to: Exclude<Decision, "none">) => void;
  onUndo?: () => void;
}) {
  const decision = decisionOf(paper.readingState);
  return (
    <div className="triage-bar mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 border-b pb-3">
      <p className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
        <span>
          Triage · {formatCount(position)} of {formatCount(total)}
        </span>
        <Badge variant={paper.reason === "radar" ? "radar" : "secondary"}>
          {reasonLabels[paper.reason]}
        </Badge>
      </p>
      <div
        role="toolbar"
        aria-label="Triage decision"
        className="ml-auto flex flex-wrap items-center gap-1.5"
      >
        {decisions.map(({ to, label, key, icon: Icon }) => (
          <Button
            key={to}
            type="button"
            variant={to === "skipped" ? "outline" : "secondary"}
            aria-pressed={decision === to}
            aria-keyshortcuts={key}
            className="aria-pressed:bg-foreground aria-pressed:text-background"
            onClick={() => onDecide(to)}
          >
            <Icon data-icon="inline-start" aria-hidden="true" />
            {label}
            <kbd aria-hidden="true" className="triage-key">
              {key.toUpperCase()}
            </kbd>
          </Button>
        ))}
        <Button
          type="button"
          variant="ghost"
          aria-keyshortcuts="u"
          // aria-disabled keeps focus on the button when the history empties.
          aria-disabled={!onUndo}
          className="aria-disabled:opacity-45"
          onClick={() => onUndo?.()}
        >
          <Undo2 data-icon="inline-start" aria-hidden="true" />
          Undo
          <kbd aria-hidden="true" className="triage-key">
            U
          </kbd>
        </Button>
      </div>
    </div>
  );
}

/** The reader column in triage with no paper open: how far the queue is,
 * and what the decisions so far add up to. */
export function TriageSummary({
  triage,
  onOpen,
}: {
  triage: Triage;
  onOpen: (paper: TriageRow) => void;
}) {
  const { rows, left } = triage;
  const group = (decision: Decision) =>
    rows.filter((row) => decisionOf(row.readingState) === decision);
  const lists = [
    ["To read", group("to_read")],
    ["Saved", group("saved")],
  ] as const;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <h2 className="font-serif text-xl font-semibold">
          {left
            ? `${countOf(left, "paper")} left in the queue`
            : "Queue cleared"}
        </h2>
        <p role="status" className="text-sm text-subtle">
          {left
            ? "Carry on where you stopped, or open any paper in the list."
            : `You decided on all ${countOf(rows.length, "paper")}: ${formatCount(group("to_read").length)} to read, ${formatCount(group("saved").length)} saved, ${formatCount(group("skipped").length)} skipped.`}
        </p>
        <div className="mt-1 flex flex-wrap gap-2">
          {left > 0 && <Button onClick={triage.start}>Continue triage</Button>}
          <Button asChild variant={left ? "outline" : "default"}>
            <Link to="/app/library?status=to_read">Open To read</Link>
          </Button>
          <Button variant="outline" onClick={triage.exit}>
            Back to the full list
          </Button>
        </div>
      </div>
      {lists.map(([title, papers]) =>
        papers.length ? (
          <section key={title} className="flex flex-col gap-1.5">
            <h3 className="text-xs font-semibold text-subtle">
              {title} · {formatCount(papers.length)}
            </h3>
            <ul className="flex flex-col">
              {papers.map((paper) => (
                <li key={paper.paperId}>
                  <button
                    type="button"
                    className="w-full rounded-sm px-2 py-1.5 text-left font-serif text-[15px] leading-snug hover:bg-control"
                    onClick={() => onOpen(paper)}
                  >
                    <MathText text={paper.title} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null,
      )}
    </div>
  );
}
