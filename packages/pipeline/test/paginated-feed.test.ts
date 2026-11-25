import { expect, it, vi } from "vitest";
import { loadFullFeed } from "../src/read-client";
const paper = {
  paperId: "pap_a",
  title: "A",
  abstract: "Full",
  authors: [],
  source: "arxiv",
  topics: [],
  shortlisted: false,
  summaries: [],
  identifiers: [],
  links: [],
};
it("loads source-preserving full pages without per-paper requests", async () => {
  const get = vi.fn(async (path: string) => ({
    day: "2026-11-16",
    status: "crawled",
    counts: { sources: { arxiv: 1, huggingface: 1 } },
    items: [
      {
        ...paper,
        source: path.includes("cursor=") ? "huggingface" : "arxiv",
        hfUpvotes: path.includes("cursor=") ? 42 : null,
      },
    ],
    nextCursor: path.includes("cursor=") ? null : "opaque+cursor",
  }));
  const feed = await loadFullFeed({ get }, "2026-11-16");
  expect(feed.items.map((p) => p.paperId)).toEqual(["pap_a", "pap_a"]);
  expect(feed.items.every((p) => p.abstract === "Full")).toBe(true);
  expect(feed.items[1]).toMatchObject({ source: "huggingface", hfUpvotes: 42 });
  expect(get.mock.calls.every(([p]) => p.includes("/full"))).toBe(true);
  expect(feed.counts).toEqual({ arxiv: 1, huggingface: 1 });
  expect(get.mock.calls.map(([p]) => p)).toContain(
    "/feed/days/2026-11-16/full?cursor=opaque%2Bcursor",
  );
});
