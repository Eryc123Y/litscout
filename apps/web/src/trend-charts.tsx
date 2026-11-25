import type { CSSProperties } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { formatCount } from "./format";
import { cn } from "./lib/utils";

/** The smallest 1, 2 or 5 × 10ⁿ at or above the largest value: each chart's
 * own scale (Trends never shares one axis between measures). */
export function niceMax(values: number[]) {
  const max = Math.max(0, ...values);
  if (max <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 5, 10])
    if (step * magnitude >= max) return step * magnitude;
  return 10 * magnitude;
}

/** A column's height in pixels; a non-zero value stays visible. */
export function barHeight(value: number, max: number, height: number) {
  if (value <= 0) return 0;
  return Math.max(2, Math.round((value / max) * height));
}

/** "+20 vs Oct", "−20 vs Oct", "same as Oct", or null without a previous month. */
export function changeText(
  current: number,
  previous: number | undefined,
  label: string,
) {
  if (previous === undefined) return null;
  const change = current - previous;
  if (change === 0) return `same as ${label}`;
  return `${change > 0 ? "+" : "−"}${formatCount(Math.abs(change))} vs ${label}`;
}

/** A stat tile: label, value, one line of context and an optional mark. */
export function StatTile({
  label,
  value,
  unit,
  note,
  className,
  children,
}: {
  label: string;
  value: string;
  unit?: string;
  note?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className={cn(
        "flex min-w-0 flex-col gap-1.5 rounded-md bg-card p-3.5",
        className,
      )}
    >
      <h3 className="text-xs font-semibold text-subtle">{label}</h3>
      <p className="text-[22px] leading-none font-semibold tabular-nums">
        {value}
        {unit ? (
          <>
            {" "}
            <span className="text-sm font-normal text-muted-foreground">
              {unit}
            </span>
          </>
        ) : null}
      </p>
      {children}
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
    </section>
  );
}

/** Twelve months as a line, the selected month as an accent dot. */
export function Sparkline({
  values,
  selected,
}: {
  values: (number | undefined)[];
  selected: number;
}) {
  const width = 120,
    height = 28;
  const max = niceMax(values.map((v) => v ?? 0));
  const x = (i: number) =>
    (i / Math.max(1, values.length - 1)) * (width - 4) + 2;
  const y = (v: number) => height - 2 - (v / max) * (height - 4);
  const points = values
    .map((v, i) => (v === undefined ? null : `${x(i)},${y(v)}`))
    .filter(Boolean)
    .join(" ");
  const value = values[selected];
  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${width} ${height}`}
      className="h-7 w-full max-w-[160px]"
      preserveAspectRatio="none"
    >
      <polyline
        points={points}
        fill="none"
        stroke="var(--line-strong)"
        strokeWidth="2"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      {value !== undefined && (
        <circle cx={x(selected)} cy={y(value)} r="3" fill="var(--accent)" />
      )}
    </svg>
  );
}

/** A thin meter for a share. */
export function Meter({ share }: { share: number }) {
  return (
    <span
      aria-hidden="true"
      className="block h-1 overflow-hidden rounded-full bg-control"
    >
      <span
        className="block h-full rounded-full bg-foreground/60"
        style={{ width: `${Math.min(100, Math.max(0, share * 100))}%` }}
      />
    </span>
  );
}

export type Segment = { label: string; value: number; className: string };

/** Ordered parts of one total with 2 px gaps; counts print inside wide
 * enough parts, and the legend names every part. */
export function SegmentedBar({
  segments,
  tall = false,
}: {
  segments: Segment[];
  tall?: boolean;
}) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  return (
    <span
      aria-hidden="true"
      className={cn("flex w-full gap-[2px]", tall ? "h-7" : "h-1.5")}
    >
      {total === 0 ? (
        <span className="h-full w-full rounded-xs bg-control" />
      ) : (
        segments
          .filter((s) => s.value > 0)
          .map((s) => (
            <span
              key={s.label}
              className={cn(
                "grid h-full place-items-center overflow-hidden rounded-[3px] text-[11px] font-semibold",
                s.className,
              )}
              style={{ flexGrow: s.value, flexBasis: 0 }}
            >
              {tall && s.value / total >= 0.12 ? formatCount(s.value) : null}
            </span>
          ))
      )}
    </span>
  );
}

export type Column = { month: string; label: string; value?: number };

/** One measure over twelve months, on its own scale. The selected month is
 * the accent with its value printed; the others recede. Each column is a
 * button that selects its month. */
export function ColumnChart({
  title,
  noun,
  columns,
  selected,
  onSelect,
}: {
  title: string;
  noun: (value: number) => string;
  columns: Column[];
  selected: string;
  onSelect: (month: string) => void;
}) {
  const height = 120;
  const max = niceMax(columns.map((c) => c.value ?? 0));
  const selectedIndex = columns.findIndex((c) => c.month === selected);
  return (
    <figure className="m-0 flex min-w-0 flex-col gap-2 rounded-md bg-card p-3.5">
      <figcaption className="text-xs font-semibold text-subtle">
        {title}
      </figcaption>
      <div className="relative pl-8">
        <span
          // The scale's value has its own gutter, so a full bar never covers it.
          aria-hidden="true"
          className="absolute top-[13px] left-0 w-7 text-right text-[10px] leading-none text-muted-foreground tabular-nums"
        >
          {formatCount(max)}
        </span>
        <div
          // A faint line marks the top of the scale, labelled with its value.
          className="relative grid items-end gap-1 border-b border-line-strong/50 before:absolute before:inset-x-0 before:top-[18px] before:border-t before:border-dashed before:border-line/60 before:content-['']"
          style={{
            gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))`,
            height: height + 18,
          }}
        >
          {columns.map((column) => {
            const on = column.month === selected;
            const text =
              column.value === undefined
                ? `${column.label}: refresh pending`
                : `${column.label}: ${noun(column.value)}`;
            return (
              <button
                key={column.month}
                type="button"
                aria-label={text}
                aria-current={on ? "true" : undefined}
                title={text}
                onClick={() => onSelect(column.month)}
                className="group relative flex h-full min-w-0 flex-col items-center justify-end gap-0.5 rounded-t-[3px] focus-visible:outline-offset-0"
              >
                {column.value !== undefined ? (
                  // The selected month keeps its value; others show it on
                  // hover or focus.
                  <span
                    aria-hidden="true"
                    className={cn(
                      "text-[11px] font-semibold tabular-nums transition-opacity duration-150",
                      on
                        ? "opacity-100"
                        : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100",
                    )}
                  >
                    {formatCount(column.value)}
                  </span>
                ) : null}
                <span
                  aria-hidden="true"
                  className={cn(
                    "trend-bar w-full max-w-6 rounded-t-[4px]",
                    on
                      ? "bg-primary"
                      : "bg-line-strong/45 group-hover:bg-line-strong/80",
                  )}
                  style={
                    {
                      height: barHeight(column.value ?? 0, max, height),
                      // Stagger for the entrance animation in style.css.
                      "--i": columns.indexOf(column),
                    } as CSSProperties
                  }
                />
              </button>
            );
          })}
        </div>
      </div>
      <div
        aria-hidden="true"
        className="grid gap-1 pl-8 text-center text-[10px] text-muted-foreground"
        style={{
          gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))`,
        }}
      >
        {columns.map((column, index) => (
          <span
            key={column.month}
            // Phones label every other month, counted from the selected one.
            className={
              (index - selectedIndex) % 2 ? "max-sm:invisible" : undefined
            }
          >
            {column.label.slice(0, 3)}
          </span>
        ))}
      </div>
    </figure>
  );
}

/** Terms as ranked bars in one hue, the count at the bar's tip. */
export function RankedBars({
  items,
}: {
  items: { term: string; count: number; href: string }[];
}) {
  const max = Math.max(1, ...items.map((item) => item.count));
  return (
    <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
      {items.map(({ term, count, href }) => (
        <li
          key={term}
          className="grid grid-cols-[minmax(6rem,40%)_minmax(0,1fr)] items-center gap-2"
        >
          <Link
            to={href}
            className="truncate text-sm text-foreground hover:text-primary hover:underline"
            title={term}
          >
            {term}
          </Link>
          <span className="flex min-w-0 items-center gap-1.5">
            <span aria-hidden="true" className="min-w-0 flex-1">
              <span
                className="block h-2.5 rounded-r-[4px] bg-primary/70"
                style={{ width: `${Math.max(4, (count / max) * 100)}%` }}
              />
            </span>
            <span className="w-9 shrink-0 text-xs tabular-nums text-subtle">
              {formatCount(count)}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}
