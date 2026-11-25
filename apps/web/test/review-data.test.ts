// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  webDigestSchema,
  webFeedSchema,
} from "@litscout/pipeline/web-contracts";
import { Digest } from "../src/Digest";
import { Days } from "../src/Days";
import { AppShell } from "../src/AppShell";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const day = "2026-11-17";
const counts = {
  total: 24,
  summarised: 24,
  shortlisted: 0,
  arxiv: 24,
  venues: 0,
  topics: {},
  sources: { arxiv: 24 },
  venueCounts: {},
};
const feed = webFeedSchema.parse({
  day,
  status: "final",
  counts,
  items: [],
  nextCursor: null,
});
function locationProbe() {
  return createElement(
    "output",
    { "aria-label": "Location" },
    useLocation().search,
  );
}
function mount(node: React.ReactNode, path = "/app/today") {
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
        { initialEntries: [path] },
        node,
        createElement(locationProbe),
      ),
    ),
  );
}
function brief(
  picks: { paperId: string; source: string; day: string }[],
  radar: unknown[] = [],
) {
  return createElement(Digest, {
    timezone: "UTC",
    feed,
    topics: [],
    query: {
      isPending: false,
      error: null,
      data: webDigestSchema.parse({
        bodyMd: "Report",
        lang: "en",
        final: true,
        picks,
        radar,
      }),
    },
  });
}
it("V3 resolves twenty-four missing picks in one bounded request", async () => {
  const picks = Array.from({ length: 24 }, (_, i) => ({
    paperId: `pap_${i}`,
    source: "arxiv",
    day,
  }));
  const fetcher = vi.fn(async (url: RequestInfo | URL) =>
    String(url).includes("/suggestions?")
      ? Response.json({ success: true, data: { items: [], next: null } })
      : Response.json({
          success: true,
          data: {
            items: picks.map((p, i) => ({
              ...p,
              title: `Pick ${i}`,
              topics: [`Topic ${i}`],
            })),
          },
        }),
  );
  vi.stubGlobal("fetch", fetcher);
  mount(brief(picks));
  // The brief shows four picks first; the rest are one click away.
  const region = () =>
    within(screen.getByRole("region", { name: "Picks per topic" }));
  fireEvent.click(
    await region().findByRole("button", { name: "Show all 24 picks" }),
  );
  await waitFor(() => expect(region().getAllByRole("link")).toHaveLength(24));
  expect(fetcher.mock.calls.map(([url]) => String(url)).sort()).toEqual([
    expect.stringContaining("/references?"),
    "/api/v1/suggestions?day=" + day,
  ]);
});
it("V4 preserves two sources of one paper in radar and topic picks", async () => {
  const refs = ["arxiv", "journal"].map((source) => ({
    paperId: "pap_shared",
    source,
    day,
  }));
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        success: true,
        data: {
          items: refs.map((ref) => ({
            ...ref,
            title: `From ${ref.source}`,
            topics: [ref.source],
          })),
        },
      }),
    ),
  );
  const { unmount } = mount(brief(refs));
  await screen.findByRole("link", { name: "From journal" });
  expect(
    screen.getByRole("link", { name: "From arxiv" }).getAttribute("href"),
  ).toContain("paperSource=arxiv");
  unmount();
  mount(
    brief(
      [],
      refs.map((ref) => ({ ...ref, level: "borrow", reason: "Relevant" })),
    ),
  );
  await screen.findByRole("link", { name: "From journal" });
  expect(
    error.mock.calls.filter((args) =>
      /same key|unique.*key/i.test(args.join(" ")),
    ),
  ).toHaveLength(0);
});
it.each([
  { desktop: false, initialCount: 3 },
  { desktop: true, initialCount: 5 },
])(
  "discloses additional radar hits after $initialCount (desktop=$desktop)",
  async ({ desktop, initialCount }) => {
    vi.stubGlobal("matchMedia", () => ({
      matches: desktop,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    const refs = Array.from({ length: initialCount + 2 }, (_, i) => ({
      paperId: `pap_${i}`,
      source: "arxiv",
      day,
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          success: true,
          data: {
            items: refs.map((ref, i) => ({
              ...ref,
              title: `Radar ${i}`,
              topics: [],
            })),
          },
        }),
      ),
    );
    mount(
      brief(
        [],
        refs.map((ref) => ({ ...ref, level: "borrow", reason: "Relevant" })),
      ),
    );
    await screen.findByRole("link", { name: "Radar 0" });
    const radar = within(screen.getByRole("region", { name: "Radar" }));
    expect(radar.getAllByRole("link")).toHaveLength(initialCount);
    expect(radar.getByText(/and 2 more/)).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Show more radar hits" }),
    );
    await radar.findByRole("link", { name: `Radar ${initialCount + 1}` });
  },
);
it("V5 the shell requests stored counts rather than a paper page", async () => {
  const fetcher = vi.fn(async (_url: RequestInfo | URL) =>
    Response.json({ success: true, data: { day, status: "final", counts } }),
  );
  vi.stubGlobal("fetch", fetcher);
  mount(
    createElement(AppShell, {
      theme: "journal",
      onAppearance: () => {},
      isPublic: false,
      instance: {
        name: "LitScout",
        publicFeed: true,
        language: "en",
        timezone: "UTC",
        topics: [],
      },
      children: createElement("main", {}, "Settings"),
    }),
    "/app/settings",
  );
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  expect(String(fetcher.mock.calls[0]![0])).toMatch(/\/counts$/);
});
const days = Array.from({ length: 30 }, (_, i) => ({
  day: new Date(Date.parse(day) - i * 86400000).toISOString().slice(0, 10),
  status: "final",
  counts: { total: 2, sources: { arxiv: 2 } },
}));
it("V8 pagination retains the old list, stores before in the URL, and resumes it", async () => {
  const cursor = days.at(-1)!.day;
  const fetcher = vi.fn(async (url: RequestInfo | URL) =>
    String(url).includes("before=")
      ? new Promise<Response>(() => undefined)
      : Response.json({
          success: true,
          data: { items: days, nextBefore: cursor },
        }),
  );
  vi.stubGlobal("fetch", fetcher);
  const view = mount(
    createElement(Days, { isPublic: false, timezone: "UTC" }),
    "/app/days",
  );
  fireEvent.click(await screen.findByRole("button", { name: "Older days" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Location").textContent).toContain(
      `before=${cursor}`,
    ),
  );
  expect(screen.getByRole("link", { name: "17 Nov 2026" })).toBeTruthy();
  expect(screen.queryByText("Loading LitScout…")).toBeNull();
  view.unmount();
  mount(
    createElement(Days, { isPublic: false, timezone: "UTC" }),
    `/app/days?before=${cursor}`,
  );
  await waitFor(() =>
    expect(String(fetcher.mock.calls.at(-1)![0])).toContain(`before=${cursor}`),
  );
});
it("V8 a full final page has no Older days action without an API cursor", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ success: true, data: { items: days, nextBefore: null } }),
    ),
  );
  mount(createElement(Days, { isPublic: false, timezone: "UTC" }), "/app/days");
  await screen.findByRole("link", { name: "17 Nov 2026" });
  expect(screen.queryByRole("button", { name: "Older days" })).toBeNull();
});

it("says how many papers are on your topics and still unread each day, and marks those days in the calendar", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-21T04:00:00Z"));
  try {
    const items = [
      {
        day: "2026-11-20",
        status: "digested",
        counts: {
          total: 784,
          sources: { arxiv: 603, openalex: 181 },
          shortlisted: 216,
          read: 51,
        },
      },
      {
        day: "2026-11-19",
        status: "final",
        counts: { total: 372, sources: {}, shortlisted: 96, read: 96 },
      },
      {
        day: "2026-11-18",
        status: "summarised",
        counts: { total: 1254, sources: { arxiv: 1254 } },
      },
      {
        day: "2026-11-16",
        status: "empty",
        counts: { total: 0, sources: {} },
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ success: true, data: { items, nextBefore: null } }),
      ),
    );
    mount(
      createElement(Days, { isPublic: false, timezone: "UTC" }),
      "/app/days",
    );
    const row = async (name: string) =>
      (await screen.findByRole("link", { name })).closest("li")!;
    // The same words as the day page, then what is left to read.
    const busy = await row("20 Nov 2026");
    expect(busy.textContent).toContain(
      "216 papers on your topics · 165 unread",
    );
    const meter = within(busy).getByRole("progressbar", {
      name: "51 of 216 read",
    }) as HTMLProgressElement;
    expect([meter.value, meter.max]).toEqual([51, 216]);
    expect(busy.textContent).not.toContain("arxiv");
    expect((await row("19 Nov 2026")).textContent).toContain(
      "96 papers on your topics · all read",
    );
    const none = await row("18 Nov 2026");
    expect(none.textContent).toContain(
      "No papers on your topics yet · 1,254 in the listing",
    );
    expect(within(none).queryByRole("progressbar")).toBeNull();
    // A day with no listing says so, without a count of nothing.
    expect((await row("16 Nov 2026")).textContent).toContain(
      "No papers listed",
    );
    expect((await row("16 Nov 2026")).textContent).not.toContain("0 in");
    // Calendar: a filled dot for a day with a digest, a ring for a day with
    // papers and no digest, nothing for a day with no listing.
    const cell = (label: RegExp) =>
      screen.getByRole("button", { name: label }).closest("td")!;
    expect(cell(/^Friday, 20 November 2026/).className).toContain("day-digest");
    expect(cell(/^Thursday, 19 November 2026/).className).toContain(
      "day-digest",
    );
    expect(cell(/^Wednesday, 18 November 2026/).className).toContain(
      "day-listing",
    );
    expect(cell(/^Tuesday, 17 November 2026/).className).not.toMatch(
      /day-digest|day-listing/,
    );
    const legend = screen.getByRole("list", { name: "Calendar marks" });
    expect(legend.textContent).toContain("Digest ready");
    expect(legend.textContent).toContain("Papers, no digest");
  } finally {
    vi.useRealTimers();
  }
});

it("V3 reuses rows from a previously loaded private feed instead of fetching them again", () => {
  const ref = { paperId: "pap_cached", source: "arxiv", day };
  const cached = {
    ...ref,
    title: "Cached paper",
    authors: [],
    authorCount: 0,
    topics: [],
    identifiers: [],
    venue: null,
    venueKind: "preprint",
    year: null,
    publishedOn: null,
    categories: [],
    hfUpvotes: null,
    shortlisted: false,
    tldr: [],
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(["feed", false, day, ""], {
    pages: [{ ...feed, items: [cached] }],
    pageParams: [""],
  });
  const fetcher = vi.fn(async (_url: string) =>
    Response.json({ success: true, data: { items: [], next: null } }),
  );
  vi.stubGlobal("fetch", fetcher);
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(MemoryRouter, {}, brief([ref])),
    ),
  );
  expect(screen.getByRole("link", { name: "Cached paper" })).toBeTruthy();
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    "/api/v1/suggestions?day=" + day,
  ]);
});
