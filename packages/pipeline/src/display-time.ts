const timestampFormats = new Map<string, Intl.DateTimeFormat>();

export function formatTimestamp(value: string, timezone: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  let formatter = timestampFormats.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: timezone,
      timeZoneName: "short",
    });
    timestampFormats.set(timezone, formatter);
  }
  return formatter.format(date);
}

const monthFormat = new Intl.DateTimeFormat("en-GB", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

/** The key is already a calendar month in the instance time zone. */
const shortMonthFormat = new Intl.DateTimeFormat("en-GB", {
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

export const formatMonth = (month: string, short = false) =>
  (short ? shortMonthFormat : monthFormat).format(
    new Date(month + "-01T00:00:00Z"),
  );
