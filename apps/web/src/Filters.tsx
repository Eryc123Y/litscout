import { useEffect, useId, useRef } from "react";
import type { WebFeed } from "@litscout/pipeline/web-contracts";
import { SlidersHorizontal, X } from "lucide-react";
import { useTopicColour } from "./useTopicColour";
import { formatCount } from "./format";
import type { Filters as FilterValues } from "./model";
import { ToggleGroup, ToggleGroupItem } from "./components/ui/toggle-group";
import { Toggle } from "./components/ui/toggle";
import { Button } from "./components/ui/button";
import {
  NativeSelect,
  NativeSelectOption,
} from "./components/ui/native-select";
import { Field, FieldLabel } from "./components/ui/field";
import { kindLabels } from "./venue-kinds";

type Chip = { name: string; text: string; clear: Partial<FilterValues> };
/** The decision filter's values and their names. */
const decisionFilters: Record<string, string> = {
  to_read: "To read",
  saved: "Saved",
  skipped: "Skipped",
};

/** Topics as one row of toggles; everything else in one Filters popover,
 * with the active filters shown as removable chips. */
export function Filters({
  counts,
  topics,
  topVenues = [],
  isPublic = false,
  value,
  onChange,
}: {
  counts: WebFeed["counts"];
  topics: string[];
  /** The instance's top venues; the Top venues toggle shows when set. */
  topVenues?: string[];
  isPublic?: boolean;
  value: FilterValues;
  onChange: (value: FilterValues) => void;
}) {
  const popoverId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  usePopoverFallback(trigger, popover);
  const topicRow = useRef<HTMLDivElement>(null);
  useEdgeFade(topicRow, topics.length);
  const decisionText = decisionFilters[value.decision ?? ""];
  const candidates: (Chip | false | "" | undefined)[] = [
    !isPublic &&
      value.unread && {
        name: "Unread",
        text: "Unread",
        clear: { unread: false },
      },
    !isPublic &&
      decisionText && {
        name: decisionText,
        text: decisionText,
        clear: { decision: "" },
      },
    value.code && {
      name: "Public code",
      text: "Public code",
      clear: { code: false },
    },
    value.source && {
      name: `Source ${value.source}`,
      text: `Source: ${value.source}`,
      clear: { source: "" },
    },
    value.venue && {
      name: `Venue ${value.venue}`,
      text: `Venue: ${value.venue}`,
      clear: { venue: "" },
    },
    value.kind && {
      name: `Type ${kindLabels[value.kind] ?? value.kind}`,
      text: `Type: ${kindLabels[value.kind] ?? value.kind}`,
      clear: { kind: "" },
    },
    value.top && {
      name: "Top venues",
      text: "Top venues",
      clear: { top: false },
    },
  ];
  const chips = candidates.filter((chip): chip is Chip => Boolean(chip));
  const anyFilter = chips.length > 0 || Boolean(value.topic);
  return (
    <div
      className="paper-filters flex min-w-0 flex-col gap-2"
      aria-label="Paper filters"
    >
      {/* The topics take their own line and scroll sideways, so the list
          below starts at the same height whatever the day's topics. */}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h2 className="mr-1 shrink-0 text-lg font-semibold">Papers</h2>
        <ToggleGroup
          ref={topicRow}
          type="single"
          aria-label="Topics"
          className="topic-row order-last min-w-0 basis-full flex-nowrap justify-start gap-1.5 overflow-x-auto pb-1"
          value={value.topic || "__all"}
          onValueChange={(topic) =>
            onChange({ ...value, topic: topic === "__all" ? "" : topic })
          }
        >
          <ToggleGroupItem value="__all" className="shrink-0 px-3">
            All {formatCount(counts.shortlisted)}
          </ToggleGroupItem>
          {topics.map((topic, index) => (
            <TopicFilter
              key={topic}
              topic={topic}
              index={index}
              count={counts.topics[topic] ?? 0}
            />
          ))}
        </ToggleGroup>
        <Button
          ref={trigger}
          type="button"
          variant="secondary"
          className="ml-auto shrink-0"
          popoverTarget={popoverId}
        >
          <SlidersHorizontal data-icon="inline-start" aria-hidden="true" />
          Filters
          {chips.length > 0 && (
            <>
              <span
                aria-hidden="true"
                className="grid min-w-[18px] place-items-center rounded-xs bg-primary px-1 text-[11px] font-semibold text-primary-foreground"
              >
                {chips.length}
              </span>
              <span className="sr-only"> ({chips.length})</span>
            </>
          )}
        </Button>
      </div>
      {anyFilter && (
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map((chip) => (
            <Button
              key={chip.name}
              type="button"
              variant="secondary"
              size="sm"
              aria-label={`Remove filter: ${chip.name}`}
              onClick={() => {
                onChange({ ...value, ...chip.clear });
                // The chip unmounts; keep focus on the Filters button.
                trigger.current?.focus();
              }}
            >
              {chip.text}
              <X
                aria-hidden="true"
                className="size-3.5 text-muted-foreground"
              />
            </Button>
          ))}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => {
              onChange({});
              trigger.current?.focus();
            }}
          >
            Clear all
          </Button>
        </div>
      )}
      {value.q && (
        <p className="text-sm text-subtle md:hidden">
          Search results for “{value.q}”
        </p>
      )}
      <div
        ref={popover}
        id={popoverId}
        popover="auto"
        role="group"
        aria-label="Filters"
        className="filters-popover m-0 w-72 flex-col gap-4 rounded-lg border bg-card p-4 text-foreground shadow-lg [&:popover-open]:flex"
      >
        {/* The list already holds only papers on the reader's topics. */}
        {!isPublic && (
          <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
            <legend className="mb-1 text-xs font-semibold text-subtle">
              Show
            </legend>
            <div className="flex flex-wrap gap-1.5">
              <Toggle
                pressed={Boolean(value.unread)}
                onPressedChange={(unread) => onChange({ ...value, unread })}
                className="px-3"
              >
                Unread
              </Toggle>
            </div>
          </fieldset>
        )}
        {!isPublic && (
          <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
            <legend className="mb-1 text-xs font-semibold text-subtle">
              Your decisions
            </legend>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(decisionFilters).map(([decision, label]) => (
                <Toggle
                  key={decision}
                  pressed={value.decision === decision}
                  onPressedChange={(on) =>
                    onChange({ ...value, decision: on ? decision : "" })
                  }
                  className="px-3"
                >
                  {label}
                </Toggle>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Skipped papers stay out of the list unless you ask for them.
            </p>
          </fieldset>
        )}
        <Toggle
          pressed={Boolean(value.code)}
          onPressedChange={(code) => onChange({ ...value, code })}
          className="self-start px-3"
        >
          Public code
        </Toggle>
        <Field className="gap-1.5">
          <FieldLabel
            htmlFor="filter-Type"
            className="text-xs font-semibold text-subtle"
          >
            Type
          </FieldLabel>
          <NativeSelect
            id="filter-Type"
            className="w-full"
            value={value.kind ?? ""}
            onChange={(event) =>
              onChange({ ...value, kind: event.target.value })
            }
          >
            <NativeSelectOption value="">All types</NativeSelectOption>
            {Object.entries(kindLabels).map(([kind, label]) => (
              <NativeSelectOption key={kind} value={kind}>
                {label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        {topVenues.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <Toggle
              pressed={Boolean(value.top)}
              onPressedChange={(top) => onChange({ ...value, top })}
              className="self-start px-3"
            >
              Top venues
            </Toggle>
            <p className="text-xs text-muted-foreground">
              Venues marked top in your watchlist ({topVenues.length})
            </p>
          </div>
        )}
        <SelectFilter
          label="Source"
          options={Object.keys(counts.sources)}
          value={value.source ?? ""}
          onChange={(source) => onChange({ ...value, source })}
        />
        <SelectFilter
          label="Venue"
          options={Object.keys(counts.venueCounts)}
          value={value.venue ?? ""}
          onChange={(venue) => onChange({ ...value, venue })}
        />
      </div>
    </div>
  );
}

/** Marks a sideways-scrolling row with data-fade-start / data-fade-end while
 * it has more to scroll on that side; the CSS fades that edge, so a chip cut
 * off at the edge reads as "scroll for more". */
function useEdgeFade(
  row: React.RefObject<HTMLElement | null>,
  /** Re-measure when the content changes. */
  items: number,
) {
  useEffect(() => {
    const element = row.current;
    if (!element) return;
    const mark = (name: "fadeStart" | "fadeEnd", on: boolean) => {
      if (on) element.dataset[name] = "";
      else delete element.dataset[name];
    };
    const update = () => {
      const rest = element.scrollWidth - element.clientWidth;
      mark("fadeStart", element.scrollLeft > 1);
      mark("fadeEnd", element.scrollLeft < rest - 1);
    };
    update();
    element.addEventListener("scroll", update, { passive: true });
    const resize =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(update)
        : undefined;
    resize?.observe(element);
    return () => {
      element.removeEventListener("scroll", update);
      resize?.disconnect();
    };
  }, [row, items]);
}

/** Where CSS anchor positioning is missing, place the popover under its
 * trigger once it is open (the browser otherwise centres it). Phones keep
 * the bottom-sheet CSS. */
function usePopoverFallback(
  trigger: React.RefObject<HTMLButtonElement | null>,
  popover: React.RefObject<HTMLDivElement | null>,
) {
  useEffect(() => {
    const panel = popover.current;
    if (!panel || globalThis.CSS?.supports?.("position-area: block-end"))
      return;
    const place = (event: Event) => {
      if ((event as ToggleEvent).newState !== "open" || !trigger.current)
        return;
      if (window.matchMedia?.("(max-width: 47.99rem)").matches) {
        for (const property of ["position", "top", "left"])
          panel.style.removeProperty(property);
        return;
      }
      // Measured after opening: a closed popover has no width.
      const rect = trigger.current.getBoundingClientRect();
      const width = panel.offsetWidth;
      panel.style.position = "fixed";
      panel.style.top = `${rect.bottom + 6}px`;
      panel.style.left = `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`;
    };
    panel.addEventListener("toggle", place);
    return () => panel.removeEventListener("toggle", place);
  }, [trigger, popover]);
}

function SelectFilter({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: string[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field className="gap-1.5">
      <FieldLabel
        htmlFor={`filter-${label}`}
        className="text-xs font-semibold text-subtle"
      >
        {label}
      </FieldLabel>
      <NativeSelect
        id={`filter-${label}`}
        className="w-full"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <NativeSelectOption value="">
          All {label.toLowerCase()}s
        </NativeSelectOption>
        {options.map((option) => (
          <NativeSelectOption key={option} value={option}>
            {option}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </Field>
  );
}

function TopicFilter({
  topic,
  index,
  count,
}: {
  topic: string;
  index: number;
  count: number;
}) {
  const colourRef = useTopicColour(index);
  return (
    <ToggleGroupItem
      className="shrink-0 gap-1.5 px-3 disabled:opacity-45"
      value={topic}
      ref={colourRef}
      // A topic with no papers that day has nothing to show.
      disabled={count === 0}
    >
      <span
        className="size-1.5 shrink-0 rounded-full bg-topic"
        aria-hidden="true"
      />
      {topic} {formatCount(count)}
    </ToggleGroupItem>
  );
}
