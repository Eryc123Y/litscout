import { expect, it, vi } from "vitest";
import { todoFor } from "../src/summary-command";
it("summary lookup follows slim todo pages and never requests a day or paper payload", async () => {
  const get = vi.fn(async (path: string) => ({
    day: "2026-11-16",
    status: "crawled",
    counts: {
      total: 3,
      summarised: 1,
      shortlisted: 0,
      arxiv: 3,
      venues: 0,
      topics: {},
      sources: { arxiv: 3 },
      venueCounts: {},
    },
    noAbstract: 0,
    items: [
      {
        paperId: path.includes("cursor=") ? "pap_b" : "pap_a",
        title: "T",
        abstract: "Prompt abstract",
      },
    ],
    nextCursor: path.includes("cursor=") ? null : "opaque",
  }));
  const { todo } = await todoFor(
    { get, write: vi.fn() },
    "2026-11-16",
    "en",
    1,
  );
  expect(todo.chunks).toHaveLength(2);
  expect(
    get.mock.calls.every(([p]) => p.includes("/summary-todo?lang=en")),
  ).toBe(true);
});
