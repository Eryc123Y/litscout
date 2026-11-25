// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  webFeedSchema,
  webDigestSchema,
} from "@litscout/pipeline/web-contracts";
import { Digest } from "../src/Digest";
import { digestSections } from "../src/digest-sections";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const feed = webFeedSchema.parse({
  day: "2026-11-17",
  status: "final",
  counts: {
    total: 1,
    summarised: 1,
    shortlisted: 1,
    arxiv: 1,
    venues: 0,
    topics: { Vision: 1 },
    sources: { arxiv: 1 },
    venueCounts: {},
  },
  nextCursor: null,
  items: [
    {
      paperId: "pap_a",
      title: "Depth study",
      authors: [],
      authorCount: 0,
      topics: ["Vision"],
      identifiers: [],
      venue: null,
      venueKind: "preprint",
      source: "arxiv",
      year: null,
      publishedOn: null,
      categories: [],
      hfUpvotes: null,
      shortlisted: true,
      tldr: [],
    },
  ],
});
function mount(
  data: ReturnType<typeof webDigestSchema.parse>,
  isPending = false,
  error: Error | null = null,
  testFeed = feed,
) {
  return render(
    createElement(
      QueryClientProvider,
      {
        client: new QueryClient({
          defaultOptions: { queries: { retry: false } },
        }),
      },
      createElement(
        MemoryRouter,
        {},
        createElement(Digest, {
          feed: testFeed,
          topics: ["Vision", "Language"],
          timezone: "Asia/Kuala_Lumpur",
          query: { data, isPending, error },
        }),
      ),
    ),
  );
}
function mountWithEmptySuggestions(...args: Parameters<typeof mount>) {
  const suggestionsUrl = `/api/v1/suggestions?day=${feed.day}`;
  const blockedFetch = globalThis.fetch;
  const fetcher = vi.fn<typeof fetch>((url, init) => {
    if (url !== suggestionsUrl || (init?.method ?? "GET") !== "GET") {
      return blockedFetch(url, init);
    }
    return Promise.resolve(
      Response.json({ success: true, data: { items: [], next: null } }),
    );
  });
  vi.stubGlobal("fetch", fetcher);
  const result = mount(...args);
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    suggestionsUrl,
    expect.anything(),
  );
  return result;
}
it("shows digest completion time in the instance zone and keeps its UTC value", () => {
  const createdAt = "2026-11-17T19:15:00Z";
  mountWithEmptySuggestions(
    webDigestSchema.parse({
      bodyMd: "A digest",
      lang: "en",
      final: true,
      createdAt,
    }),
  );
  const timestamp = screen.getByText("18 Nov 2026, 03:15 GMT+8");
  expect(timestamp.getAttribute("datetime")).toBe(createdAt);
});
it.each([true, false])(
  "shows a useful digest pending state without empty cards (loading=%s)",
  (loading) => {
    mount(null, loading);
    if (loading) {
      expect(screen.getByRole("status").textContent).toBe(
        "Loading the morning brief…",
      );
    } else {
      expect(screen.getByText("Digest pending")).toBeTruthy();
      expect(screen.getByText(/Papers can be read below/)).toBeTruthy();
    }
    expect(screen.queryByRole("region", { name: "Radar" })).toBeNull();
  },
);
it("shows that a known gap has no digest", () => {
  mount(null, false, null, { ...feed, status: "empty", items: [] });
  expect(screen.getByText("No digest for this day")).toBeTruthy();
  expect(screen.getByText("There was no listing on this date.")).toBeTruthy();
  expect(screen.queryByText("Digest pending")).toBeNull();
});
it("explains a failed brief while leaving the paper workflow available", () => {
  mount(null, false, Error("Temporary failure"));
  expect(screen.getByText("Brief unavailable")).toBeTruthy();
  expect(screen.getByText("Temporary failure")).toBeTruthy();
});
it("renders structured radar and topic picks as links and suggestions as read-only Markdown", () => {
  const { container } = mountWithEmptySuggestions(
    webDigestSchema.parse({
      bodyMd:
        "## Idea suggestions\n\nTry screen-space completion.\n\n<script>bad()</script>\n\n[bad](javascript:alert)",
      lang: "en",
      final: true,
      picks: [{ paperId: "pap_a", source: "arxiv", day: feed.day }],
      radar: [
        {
          paperId: "pap_a",
          source: "arxiv",
          day: feed.day,
          level: "high",
          fullTextRead: true,
          project: "FYP · stereo conversion",
          reason: "A useful baseline.",
          action: "Compare its depth completion.",
        },
      ],
    }),
  );
  const radar = within(screen.getByRole("region", { name: "Radar" }));
  expect(radar.getByText("high")).toBeTruthy();
  expect(radar.getByText("FYP · stereo conversion")).toBeTruthy();
  expect(radar.getByText("A useful baseline.")).toBeTruthy();
  expect(
    radar.getByRole("link", { name: "Depth study" }).getAttribute("href"),
  ).toContain("paper=pap_a&paperSource=arxiv");
  const picks = within(screen.getByRole("region", { name: "Picks per topic" }));
  expect(picks.queryByRole("link", { name: "Depth study" })).toBeNull();
  const suggestions = within(
    screen.getByRole("region", { name: "Idea suggestions" }),
  );
  expect(suggestions.getByText("Try screen-space completion.")).toBeTruthy();
  expect(suggestions.queryByRole("button")).toBeNull();
  expect(suggestions.queryByRole("link")).toBeNull();
  expect(container.querySelector("script")).toBeNull();
});
it("explains why a radar paper matters and the ways it could help", () => {
  mountWithEmptySuggestions(
    webDigestSchema.parse({
      bodyMd: "## Radar",
      lang: "en",
      final: true,
      radar: [
        {
          paperId: "pap_a",
          source: "arxiv",
          day: feed.day,
          level: "medium",
          fullTextRead: true,
          project: "FYP · stereo conversion",
          reason: "Shows that disparity priors survive domain shift.",
          relevance: "Your stereo conversion keeps failing on the same shift.",
          angles: [
            "Borrow its prior as a regulariser.",
            "Add its shifted test split as a baseline.",
          ],
          action: "Run the split on the current checkpoint.",
        },
      ],
    }),
  );
  const radar = within(screen.getByRole("region", { name: "Radar" }));
  expect(
    radar.getByText("Shows that disparity priors survive domain shift."),
  ).toBeTruthy();
  expect(radar.getByText("Why it matters")).toBeTruthy();
  expect(
    radar.getByText("Your stereo conversion keeps failing on the same shift."),
  ).toBeTruthy();
  const ways = radar.getByRole("list", { name: "Ways it could help" });
  expect(
    within(ways)
      .getAllByRole("listitem")
      .map((li) => li.textContent),
  ).toEqual([
    "Borrow its prior as a regulariser.",
    "Add its shifted test split as a baseline.",
  ]);
  expect(
    radar.getByText("Run the split on the current checkpoint."),
  ).toBeTruthy();
});
it("shows an older radar entry without relevance or angles as before", () => {
  mountWithEmptySuggestions(
    webDigestSchema.parse({
      bodyMd: "## Radar",
      lang: "en",
      final: true,
      radar: [
        {
          paperId: "pap_a",
          source: "arxiv",
          day: feed.day,
          level: "borrow",
          reason: "A useful baseline.",
        },
      ],
    }),
  );
  const radar = within(screen.getByRole("region", { name: "Radar" }));
  expect(radar.getByText("A useful baseline.")).toBeTruthy();
  expect(radar.queryByText("Why it matters")).toBeNull();
  expect(radar.queryByRole("list", { name: "Ways it could help" })).toBeNull();
});
it("preserves legacy Markdown sections and distinguishes missing suggestions", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ success: true, data: { items: [], next: null } }),
    ),
  );
  mount(
    webDigestSchema.parse({
      bodyMd:
        "**Radar**: None today\n\n**Vision**\n- A topic pick\n\n## Notes\nCheck the paper.",
      lang: "en",
      final: false,
    }),
  );
  expect(
    within(screen.getByRole("region", { name: "Radar" })).getByText(
      /None today/,
    ),
  ).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "Picks per topic" })).getByText(
      "A topic pick",
    ),
  ).toBeTruthy();
  expect(
    await screen.findByText("No idea suggestions in this digest."),
  ).toBeTruthy();
  const complete = screen.getByText("Read the complete digest");
  // The whole digest is parsed only once it is opened.
  expect(screen.queryByRole("heading", { name: "Notes" })).toBeNull();
  const details = complete.closest("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  expect(await screen.findByRole("heading", { name: "Notes" })).toBeTruthy();
});
it("loads a pick outside the current slim page without loading the whole day", async () => {
  const fetcher = vi.fn(async (url: string) =>
    url.includes("/suggestions?")
      ? Response.json({ success: true, data: { items: [], next: null } })
      : Response.json({
          success: true,
          data: {
            items: [
              {
                day: feed.day,
                ...feed.items[0],
                paperId: "pap_b",
                title: "Another paper",
                abstract: null,
                summaries: [],
                links: [],
              },
            ],
          },
        }),
  );
  vi.stubGlobal("fetch", fetcher);
  mount(
    webDigestSchema.parse({
      bodyMd: "",
      lang: "en",
      final: false,
      picks: [{ paperId: "pap_b", source: "arxiv", day: feed.day }],
    }),
  );
  await screen.findByRole("link", { name: "Another paper" });
  expect(fetcher.mock.calls.map(([url]) => url).sort()).toEqual([
    expect.stringContaining("/references?"),
    "/api/v1/suggestions?day=" + feed.day,
  ]);
});
it("names a pick from the digest itself, with no lookup", async () => {
  const fetcher = vi.fn(async (_url: string) =>
    Response.json({ success: true, data: { items: [], next: null } }),
  );
  vi.stubGlobal("fetch", fetcher);
  mount(
    webDigestSchema.parse({
      bodyMd: "",
      lang: "en",
      final: false,
      picks: [
        {
          paperId: "pap_b",
          source: "arxiv",
          day: feed.day,
          title: "Named by the digest",
          topics: ["Vision"],
        },
      ],
    }),
  );
  expect(
    await screen.findByRole("link", { name: "Named by the digest" }),
  ).toBeTruthy();
  expect(
    fetcher.mock.calls.some(([url]) => String(url).includes("/references")),
  ).toBe(false);
});
it("recognises Chinese section names and does not split fenced code", () => {
  const sections = digestSections(
    "## 雷达\n无\n## 主题推荐\n一个推荐\n## 想法建议\n建议\n```\n## Radar\n```",
    [],
  );
  expect(sections.radar).toContain("无");
  expect(sections.picks).toContain("一个推荐");
  expect(sections.suggestions).toContain("## Radar");
});

it("shows one pick per topic without duplicating radar papers", () => {
  const first = feed.items[0]!;
  mountWithEmptySuggestions(
    webDigestSchema.parse({
      bodyMd: "## Vision\nFull report",
      lang: "en",
      final: true,
      picks: ["pap_a", "pap_b", "pap_c", "pap_d"].map((paperId) => ({
        paperId,
        source: "arxiv",
        day: feed.day,
      })),
      radar: [
        {
          paperId: "pap_a",
          source: "arxiv",
          day: feed.day,
          level: "borrow",
          reason: "Radar first",
        },
      ],
    }),
    false,
    null,
    {
      ...feed,
      items: [
        first,
        { ...first, paperId: "pap_b", title: "First Vision pick" },
        { ...first, paperId: "pap_c", title: "Second Vision pick" },
        {
          ...first,
          paperId: "pap_d",
          title: "Language pick",
          topics: ["Language"],
        },
      ],
    },
  );
  const picks = within(screen.getByRole("region", { name: "Picks per topic" }));
  expect(picks.getAllByRole("link").map((link) => link.textContent)).toEqual([
    "First Vision pick",
    "Language pick",
  ]);
  expect(picks.queryByText("Depth study")).toBeNull();
  expect(picks.getByText("Vision")).toBeTruthy();
  expect(picks.getByText("Language")).toBeTruthy();
});

it("renders an existing radar project slug as a title", () => {
  mountWithEmptySuggestions(
    webDigestSchema.parse({
      bodyMd: "Brief",
      lang: "en",
      final: true,
      picks: [],
      radar: [
        {
          paperId: "pap_a",
          source: "arxiv",
          day: feed.day,
          level: "borrow",
          reason: "Related work",
          project: "sparse-reward-study",
        },
      ],
    }),
  );
  expect(
    within(screen.getByRole("region", { name: "Radar" })).getByText(
      "Sparse Reward Study",
    ),
  ).toBeTruthy();
});
