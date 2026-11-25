/**
 * Venue papers whose abstract lookup found nothing, and when to ask again.
 * Many never get one from a free source (an editorial, a publisher without a
 * key), and asking for all of them on every run took minutes each time. A miss
 * waits 1, 2, 4, 8, then 16 days; a paper leaves the ledger once it has an
 * abstract or leaves the 60-day history.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/** Kept in the CLI's state folder beside the venue progress (`STATE_FILE`). */
export const ATTEMPTS_FILE = "watch-abstract-attempts.json";
const DAY_MS = 86_400_000;
const MAX_DOUBLINGS = 4;

const attemptsSchema = z.record(
  z.string(),
  z.object({ tries: z.number().int().min(1), next: z.iso.datetime() }),
);
export type Attempts = z.infer<typeof attemptsSchema>;

/** Days to wait after the nth miss in a row. */
export function backoffDays(tries: number): number {
  return 2 ** Math.min(Math.max(tries, 1) - 1, MAX_DOUBLINGS);
}

/** A missing or damaged ledger reads as empty: every paper is due. */
export async function readAttempts(dir: string): Promise<Attempts> {
  try {
    const text = await readFile(path.join(dir, ATTEMPTS_FILE), "utf8");
    return attemptsSchema.parse(JSON.parse(text));
  } catch {
    return {};
  }
}

export function isDue(attempts: Attempts, key: string, now: Date): boolean {
  const entry = attempts[key];
  return !entry || Date.parse(entry.next) <= now.getTime();
}

/**
 * The ledger after a lookup. `lacking` holds every paper still without an
 * abstract; `asked` the ones looked up this run and whether one was found.
 */
export function nextAttempts(
  previous: Attempts,
  lacking: ReadonlySet<string>,
  asked: readonly { key: string; found: boolean }[],
  now: Date,
): Attempts {
  const outcome = new Map(asked.map(({ key, found }) => [key, found]));
  return Object.fromEntries(
    [...lacking].flatMap((key) => {
      const found = outcome.get(key);
      if (found === true) return [];
      if (found === undefined)
        return previous[key] ? [[key, previous[key]]] : [];
      const tries = (previous[key]?.tries ?? 0) + 1;
      const next = new Date(now.getTime() + backoffDays(tries) * DAY_MS);
      return [[key, { tries, next: next.toISOString() }]];
    }),
  );
}
