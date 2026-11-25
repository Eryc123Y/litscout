/** The next time after `now` at `hhmm` (UTC), today or tomorrow. */
export function nextDailyRun(now: Date, hhmm: string): Date {
  const [hours, minutes] = hhmm.split(":").map(Number) as [number, number];
  const next = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      hours,
      minutes,
    ),
  );
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}
