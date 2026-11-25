import { expect, it } from "vitest";
import { refetchOnFocus } from "../src/query-defaults";

it("refetches on tab focus only when the data is at least five minutes old", () => {
  const now = Date.parse("2026-11-21T06:00:00Z");
  const query = (ageMs: number) => ({ state: { dataUpdatedAt: now - ageMs } });
  // Back from a PDF in another tab: nothing is fetched again.
  expect(refetchOnFocus(query(20_000), now)).toBe(false);
  expect(refetchOnFocus(query(4 * 60_000), now)).toBe(false);
  // Back after a break: stale queries refresh.
  expect(refetchOnFocus(query(5 * 60_000), now)).toBe(true);
  expect(refetchOnFocus(query(60 * 60_000), now)).toBe(true);
  // A failed load recovers on return.
  expect(
    refetchOnFocus({ state: { dataUpdatedAt: 0, status: "error" } }, now),
  ).toBe(true);
  // Never fetched: let the query's own fetch handle it.
  expect(refetchOnFocus({ state: { dataUpdatedAt: 0 } }, now)).toBe(false);
});
