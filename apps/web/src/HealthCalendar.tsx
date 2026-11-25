import { useState } from "react";
import {
  Check,
  CircleDashed,
  Clock3,
  History,
  Minus,
  X,
  type LucideIcon,
} from "lucide-react";
import type { z } from "zod";
import type { healthSchema } from "@litscout/pipeline/health-contracts";
import { formatTimestamp } from "./format";
import { cn } from "./lib/utils";

type HealthData = z.output<typeof healthSchema>;
type Day = HealthData["days"][number];

/** Where each day sits on a Monday-to-Friday calendar: weekends stay in the
 * list (for screen readers) but get no column. */
export function calendarCells(days: string[]) {
  const first = new Date(days[0] + "T00:00:00Z");
  const firstMonday = Date.UTC(
    first.getUTCFullYear(),
    first.getUTCMonth(),
    first.getUTCDate() - ((first.getUTCDay() + 6) % 7),
  );
  return days.map((day) => {
    const date = new Date(day + "T00:00:00Z");
    const weekday = date.getUTCDay();
    return {
      day,
      column: weekday === 0 || weekday === 6 ? null : weekday,
      row: Math.floor((date.getTime() - firstMonday) / (7 * 86_400_000)) + 1,
    };
  });
}

const states: Record<
  Day["status"],
  {
    label: string;
    /** The label inside a sentence; defaults to the label in lower case. */
    phrase?: string;
    icon: LucideIcon;
    cell: string;
    /** Listed in the totals only when a day has this state. */
    optional?: boolean;
  }
> = {
  "on-time": {
    label: "On time",
    icon: Check,
    cell: "bg-good text-on-good",
  },
  late: {
    label: "Late",
    icon: Clock3,
    cell: "text-foreground ring-[1.5px] ring-late ring-inset bg-[linear-gradient(to_top,var(--late)_42%,transparent_42%)]",
  },
  missed: {
    label: "Missed",
    icon: X,
    cell: "text-subtle ring-[1.5px] ring-missed ring-inset",
  },
  "no-listing": {
    label: "No listing",
    icon: Minus,
    cell: "bg-control text-muted-foreground",
  },
  imported: {
    label: "Imported",
    icon: History,
    cell: "bg-control text-subtle",
    optional: true,
  },
  "before-start": {
    label: "Before LitScout",
    phrase: "before LitScout",
    icon: CircleDashed,
    cell: "border border-dashed border-border text-muted-foreground",
    optional: true,
  },
};
const phrase = (status: Day["status"]) =>
  states[status].phrase ?? states[status].label.toLowerCase();

const shortDay = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
});
const longDay = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  weekday: "short",
  month: "short",
  day: "numeric",
});

/** Digest delivery as a weekday calendar. Each day shows its state by shape
 * (solid, half-filled, outlined, muted, dashed) and names it on hover, focus
 * or tap. */
export function DeliveryCalendar({
  days,
  timezone,
}: Pick<HealthData, "days" | "timezone">) {
  const [shown, setShown] = useState(days.at(-1)!.day);
  const byDay = new Map(days.map((day) => [day.day, day]));
  const totals = Object.fromEntries(
    days.reduce(
      (counts, day) =>
        counts.set(day.status, (counts.get(day.status) ?? 0) + 1),
      new Map<Day["status"], number>(),
    ),
  ) as Partial<Record<Day["status"], number>>;
  const listed = (Object.keys(states) as Day["status"][]).filter(
    (status) => !states[status].optional || totals[status],
  );
  // A refetch can move the 30-day window past the day being shown.
  const current = byDay.get(shown) ?? days.at(-1)!;
  const describe = (day: Day) =>
    `${day.day} · ${states[day.status].label}${day.reported ? "" : " · No run report"}`;
  return (
    <div className="flex flex-col gap-2">
      <ul
        aria-label="Delivery totals"
        className="m-0 flex list-none flex-wrap gap-x-3 gap-y-1 p-0 text-xs text-subtle"
      >
        {listed.map((status) => {
          const Icon = states[status].icon;
          return (
            <li key={status} className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className={cn(
                  "grid size-3.5 place-items-center rounded-[3px]",
                  states[status].cell,
                )}
              >
                <Icon className="size-2.5" />
              </span>
              {totals[status] ?? 0} {phrase(status)}
            </li>
          );
        })}
      </ul>
      <div
        aria-hidden="true"
        className="grid grid-cols-5 gap-1.5 text-xs text-muted-foreground"
      >
        {["Mon", "Tue", "Wed", "Thu", "Fri"].map((name) => (
          <span key={name}>{name}</span>
        ))}
      </div>
      <ul
        aria-label="Digest delivery by day"
        className="m-0 grid list-none grid-cols-5 gap-1.5 p-0"
      >
        {calendarCells(days.map((day) => day.day)).map(
          ({ day, column, row }) => {
            const entry = byDay.get(day)!;
            const text = describe(entry);
            if (column === null)
              return (
                <li key={day} className="sr-only">
                  {text}
                </li>
              );
            return (
              <li key={day} style={{ gridColumn: column, gridRow: row }}>
                <button
                  type="button"
                  title={text}
                  data-shown={current.day === day ? "" : undefined}
                  onClick={() => setShown(day)}
                  onFocus={() => setShown(day)}
                  onMouseEnter={() => setShown(day)}
                  className={cn(
                    "flex h-10 w-full items-start rounded-xs px-1.5 py-1 text-left text-xs tabular-nums data-shown:outline-2 data-shown:outline-offset-1 data-shown:outline-foreground/40 max-md:h-11",
                    states[entry.status].cell,
                  )}
                >
                  <span aria-hidden="true">{Number(day.slice(8))}</span>
                  <span className="sr-only">{text}</span>
                </button>
              </li>
            );
          },
        )}
      </ul>
      <div className="flex justify-between text-xs text-muted-foreground">
        <time dateTime={days[0]!.day}>
          {shortDay.format(new Date(days[0]!.day))}
        </time>
        <time dateTime={days.at(-1)!.day}>
          {shortDay.format(new Date(days.at(-1)!.day))}
        </time>
      </div>
      <p className="text-sm text-subtle">
        <span className="font-medium text-foreground">
          {longDay.format(new Date(current.day))}
        </span>
        : {phrase(current.status)}
        {current.digestAt
          ? `, digest at ${formatTimestamp(current.digestAt, timezone)}`
          : ""}
        {current.reported ? "" : ", no run report"}
      </p>
    </div>
  );
}
