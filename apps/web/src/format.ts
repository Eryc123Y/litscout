export { formatTimestamp } from "@litscout/pipeline/display-time";

const listingHeading = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "long",
  timeZone: "UTC",
});
const calendarDay = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const counts = new Intl.NumberFormat("en-GB");

export function formatDay(
  value: string,
  variant: "short" | "heading" = "short",
) {
  const date = new Date(value + "T00:00:00Z");
  return Number.isNaN(date.getTime())
    ? value
    : (variant === "heading" ? listingHeading : calendarDay).format(date);
}

/** "Yesterday", "4 days ago": a listing day against today, both YYYY-MM-DD. */
export function relativeDay(day: string, today: string) {
  const days = Math.round(
    (Date.parse(day + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) /
      86_400_000,
  );
  if (days === 0) return "Today";
  if (days === -1) return "Yesterday";
  if (days === 1) return "Tomorrow";
  return days < 0
    ? `${countOf(-days, "day")} ago`
    : `In ${countOf(days, "day")}`;
}

export function formatCount(value: number) {
  return counts.format(value);
}

const englishPlural = new Intl.PluralRules("en");
/** "1 paper", "2 papers": a formatted count with its English noun. */
export function countOf(
  value: number,
  singular: string,
  plural = singular + "s",
) {
  return `${formatCount(value)} ${englishPlural.select(value) === "one" ? singular : plural}`;
}
