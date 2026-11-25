export const statuses = [
  "pending",
  "empty",
  "crawled",
  "summarised",
  "digested",
  "final",
] as const;
export type DayStatus = (typeof statuses)[number];
export function nextStatus(
  current: DayStatus,
  requested: DayStatus,
): DayStatus {
  return statuses.indexOf(requested) > statuses.indexOf(current)
    ? requested
    : current;
}
