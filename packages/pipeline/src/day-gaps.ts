/**
 * Which listing a run reads next, and which crawled days were skipped. Pure:
 * no API, so the CLI and the web reader share one rule.
 */
export type DayLike = {
  day: string;
  status: string;
  counts?: { arxiv?: number; sources?: { arxiv?: number } };
};

/** How far before the target a skipped day is still worth pointing at. */
export const behindWindowDays = 14;

export const arxivCount = (row: DayLike) =>
  row.counts?.sources?.arxiv ?? row.counts?.arxiv ?? 0;
const isCrawled = (status: string) =>
  status === "crawled" || status === "summarised";
export const shiftDay = (day: string, offset: number) =>
  new Date(Date.parse(day) + offset * 86400000).toISOString().slice(0, 10);

export function latestListing(
  days: readonly DayLike[],
  eligible: (row: DayLike) => boolean,
  through?: string,
) {
  return days.reduce<string | undefined>(
    (latest, row) =>
      eligible(row) &&
      arxivCount(row) > 0 &&
      (!through || row.day <= through) &&
      (!latest || row.day > latest)
        ? row.day
        : latest,
    undefined,
  );
}

/** The newest crawled arXiv listing awaiting a digest. */
export function readingDay(days: readonly DayLike[], through?: string) {
  // A listing older than one already read was skipped for that newer read:
  // it is behind (processed only on request), never the next target.
  const read = newestRead(days, through);
  return latestListing(
    days,
    (row) => isCrawled(row.status) && (!read || row.day > read),
    through,
  );
}

/** The newest arXiv listing that has its digest (digested or final). */
function newestRead(days: readonly DayLike[], through?: string) {
  return latestListing(
    days,
    (row) => ["digested", "final"].includes(row.status),
    through,
  );
}

/** Whether a day holds a crawled listing (or any papers, before counts). */
export function hasListing(row: DayLike) {
  return (
    !["pending", "empty"].includes(row.status) &&
    (row.counts === undefined || arxivCount(row) > 0)
  );
}

/**
 * Crawled days older than the target (or, with no target, than the newest
 * listing with a digest) that never got a digest, counted only
 * after the last finished day (older or imported days were never meant to)
 * and within two weeks of the target.
 */
export function behindDays(days: readonly DayLike[], through?: string) {
  // With nothing new to read, the newest read listing marks the gap.
  const target = readingDay(days, through) ?? newestRead(days, through);
  if (!target) return new Set<string>();
  const lastFinal = days
    .filter((row) => row.status === "final")
    .map((row) => row.day)
    .sort()
    .at(-1);
  const earliest = shiftDay(target, -behindWindowDays);
  return new Set(
    days
      .filter(
        (row) =>
          hasListing(row) &&
          !["digested", "final"].includes(row.status) &&
          row.day < target &&
          row.day >= earliest &&
          (lastFinal === undefined || row.day > lastFinal),
      )
      .map((row) => row.day),
  );
}
