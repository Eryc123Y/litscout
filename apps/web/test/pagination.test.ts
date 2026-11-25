// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Feed } from "../src/Feed";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const counts = {
  total: 51,
  summarised: 51,
  shortlisted: 51,
  arxiv: 51,
  venues: 0,
  sources: { arxiv: 51 },
  topics: { Vision: 51 },
  venueCounts: {},
};
const row = {
  paperId: "pap_a",
  title: "First paper",
  authors: [{ name: "Ada" }],
  authorCount: 8,
  source: "arxiv",
  topics: ["Vision"],
  shortlisted: true,
  identifiers: [],
  venue: null,
  venueKind: "preprint",
  year: null,
  publishedOn: null,
  categories: [],
  hfUpvotes: null,
  tldr: [{ lang: "en", text: "Lead" }],
};
it("loads more slim rows, keeps whole-day counts and fetches the selected full record", async () => {
  const fetcher = vi.fn(async (path: string) => {
    const data = path.includes("/papers/")
      ? {
          ...row,
          abstract: "Full abstract fetched separately",
          authors: Array.from({ length: 8 }, () => ({ name: "Ada" })),
          summaries: [],
          links: [],
        }
      : {
          day: "2026-11-16",
          status: "summarised",
          counts,
          // A full first page (the list loads further pages by itself only
          // while it holds fewer than 20 papers), then the last paper.
          items: path.includes("cursor=")
            ? [{ ...row, paperId: "pap_b", title: "Last paper" }]
            : Array.from({ length: 20 }, (_, i) =>
                i === 0
                  ? row
                  : { ...row, paperId: `pap_${i}`, title: `Paper ${i}` },
              ),
          nextCursor: path.includes("cursor=") ? null : "opaque",
        };
    return Response.json({ success: true, data });
  });
  vi.stubGlobal("fetch", fetcher);
  render(
    createElement(
      QueryClientProvider,
      {
        client: new QueryClient({
          defaultOptions: { queries: { retry: false } },
        }),
      },
      createElement(
        MemoryRouter,
        { initialEntries: ["/public/today?day=2026-11-16"] },
        createElement(Feed, {
          isPublic: true,
          instance: {
            name: "LitScout",
            publicFeed: true,
            language: "en",
            timezone: "UTC",
            topics: ["Vision"],
          },
        }),
      ),
    ),
  );
  await screen.findByRole("button", { name: /Read First paper/ });
  const header = screen.getByRole("heading", { level: 1 }).closest("header")!;
  expect(within(header).getByText(/51 papers/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  await screen.findByRole("button", { name: /Read Last paper/ });
  expect(fetcher.mock.calls.some(([p]) => p.includes("cursor=opaque"))).toBe(
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: /Read Last paper/ }));
  await screen.findByText("Full abstract fetched separately");
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull(),
  );
  expect(
    fetcher.mock.calls.some(([p]) => p.includes("/public/papers/pap_b")),
  ).toBe(true);
});
it("R10 opens the selected source of a shared paper and keeps the source in its full-view link", async () => {
  const fetcher = vi.fn(async (path: string) => {
    const source =
      new URL(path, "https://local").searchParams.get("source") ?? "arxiv";
    const data = path.includes("/papers/")
      ? { ...row, source, abstract: `From ${source}`, summaries: [], links: [] }
      : {
          day: "2026-11-16",
          status: "crawled",
          counts: {
            ...counts,
            total: 2,
            sources: { arxiv: 1, huggingface: 1 },
          },
          items: [row, { ...row, source: "huggingface", hfUpvotes: 42 }],
          nextCursor: null,
        };
    return Response.json({ success: true, data });
  });
  vi.stubGlobal("fetch", fetcher);
  render(
    createElement(
      QueryClientProvider,
      {
        client: new QueryClient({
          defaultOptions: { queries: { retry: false } },
        }),
      },
      createElement(
        MemoryRouter,
        { initialEntries: ["/public/today?day=2026-11-16"] },
        createElement(Feed, {
          isPublic: true,
          instance: {
            name: "LitScout",
            publicFeed: true,
            language: "en",
            timezone: "UTC",
            topics: [],
          },
        }),
      ),
    ),
  );
  const buttons = await screen.findAllByRole("button", {
    name: /Read First paper/,
  });
  fireEvent.click(buttons[1]!);
  await screen.findByText("From huggingface");
  expect(
    fetcher.mock.calls.some(([p]) =>
      p.includes("/public/papers/pap_a?day=2026-11-16&source=huggingface"),
    ),
  ).toBe(true);
  expect(document.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
  expect(
    [...document.querySelectorAll("a")].some((a) =>
      a.href.includes("source=huggingface"),
    ),
  ).toBe(true);
});
