import { expect, it } from "vitest";
import { behindDays, readingDay } from "../src/day-gaps";

// Staging on 2026-11-19, as /feed/days returns it.
const rows = [
  { day: "2026-11-19", status: "pending", counts: { sources: {} } },
  { day: "2026-11-18", status: "crawled", counts: { sources: { arxiv: 565 } } },
  {
    day: "2026-11-17",
    status: "crawled",
    counts: { sources: { arxiv: 1104 } },
  },
  { day: "2026-11-16", status: "final", counts: { sources: { arxiv: 372 } } },
  {
    day: "2026-11-02",
    status: "summarised",
    counts: { sources: { arxiv: 450 } },
  },
];

it("finds the reading day and the days skipped since the last finished one, without the API", () => {
  expect(readingDay(rows)).toBe("2026-11-18");
  expect([...behindDays(rows)]).toEqual(["2026-11-17"]);
  // Nothing is behind once the gap has a digest.
  expect([
    ...behindDays(
      rows.map((r) =>
        r.day === "2026-11-17" ? { ...r, status: "digested" } : r,
      ),
    ),
  ]).toEqual([]);
  expect([...behindDays([])]).toEqual([]);
});

it("keeps a skipped day out of the target once a newer listing has its digest", () => {
  // Staging on 2026-11-20 at 10:55: the 10:20 run digested 11-19.
  const after = [
    {
      day: "2026-11-19",
      status: "digested",
      counts: { sources: { arxiv: 610 } },
    },
    {
      day: "2026-11-18",
      status: "digested",
      counts: { sources: { arxiv: 565 } },
    },
    {
      day: "2026-11-17",
      status: "crawled",
      counts: { sources: { arxiv: 1104 } },
    },
    { day: "2026-11-16", status: "final", counts: { sources: { arxiv: 372 } } },
    {
      day: "2026-11-02",
      status: "summarised",
      counts: { sources: { arxiv: 450 } },
    },
  ];
  // Nothing new to read: summaries and digest report no-new-batch rather
  // than backfilling 11-17, which waits for the owner as a behind day.
  expect(readingDay(after)).toBeUndefined();
  expect([...behindDays(after)]).toEqual(["2026-11-17"]);
  // The next listing is the target again, and 11-17 stays behind.
  const next = [
    {
      day: "2026-11-20",
      status: "crawled",
      counts: { sources: { arxiv: 590 } },
    },
    ...after,
  ];
  expect(readingDay(next)).toBe("2026-11-20");
  expect([...behindDays(next)]).toEqual(["2026-11-17"]);
});
