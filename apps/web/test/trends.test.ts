// @vitest-environment jsdom
import { createElement as h, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { TrendsResponse } from "@litscout/pipeline/trends-contracts";
import type { InstanceInfo } from "@litscout/pipeline/web-contracts";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { Days } from "../src/Days";
import { Trends } from "../src/Trends";

const instance: InstanceInfo = {
  name: "LitScout",
  language: "en",
  publicFeed: false,
  timezone: "UTC",
  topics: ["Computer Vision", "Language"],
};
const currentMonth = "2026-11";
const detail: NonNullable<TrendsResponse["detail"]> = {
  month: currentMonth,
  volume: 1200,
  shortlisted: 25,
  radar: { high: 3, medium: 4, borrow: 2 },
  recurring: [{ term: "stereo", count: 12, score: 0.2 }],
  rising: [{ term: "深度估计", count: 4, score: 0.2 }],
  pickCount: 21,
  saveCount: 20,
  ratingCount: 2,
  picks: [{ paperId: "arxiv/2611.001", title: "Stereo baseline" }],
  activity: [
    {
      paperId: "pap_saved",
      title: "Saved baseline",
      saved: true,
      rating: "up",
    },
    {
      paperId: "pap_down",
      title: "Rated baseline",
      saved: false,
      rating: "down",
    },
    { paperId: "pap_missing", title: null, saved: true, rating: null },
  ],
  nextPickOffset: null,
  nextActivityOffset: null,
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-17T04:00:00Z"));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function json(data: unknown) {
  return Response.json({ success: true, data });
}

function trends(data: Partial<TrendsResponse> = {}) {
  return json({
    topic: "Computer Vision",
    month: currentMonth,
    currentMonth,
    history: [{ month: currentMonth, volume: 1200, picks: 21, radarHits: 9 }],
    detail,
    ...data,
  } satisfies TrendsResponse);
}

function mount(page: ReactNode, path = "/app/trends") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  function CurrentUrl() {
    const { pathname, search } = useLocation();
    return h("output", { "aria-label": "Current URL" }, pathname + search);
  }
  return render(
    h(
      QueryClientProvider,
      { client },
      h(MemoryRouter, { initialEntries: [path] }, page, h(CurrentUrl)),
    ),
  );
}

function card(title: string) {
  return within(
    screen
      .getByRole("heading", { name: title })
      .closest<HTMLElement>("[data-slot=card]")!,
  );
}

it("explains when the first month will appear and draws no empty charts", async () => {
  const fetcher = vi.fn(async () => trends({ history: [], detail: null }));
  vi.stubGlobal("fetch", fetcher);
  mount(h(Trends, { instance }));

  expect(await screen.findByText("No trends for November 2026")).toBeTruthy();
  expect(
    screen.getByText(
      "This month will appear with the first refresh after a daily digest.",
    ),
  ).toBeTruthy();
  // With no month refreshed yet there is nothing to chart: no empty charts
  // or a table of dashes, only the explanation.
  expect(screen.queryByRole("figure")).toBeNull();
  expect(screen.queryByRole("region", { name: "Monthly totals" })).toBeNull();
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    "/api/v1/trends?month=2026-11&topic=Computer+Vision",
    expect.anything(),
  );
});

it("explains how to configure topics without sending a trends request", () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  mount(h(Trends, { instance: { ...instance, topics: [] } }));

  expect(screen.getByText("No topics configured")).toBeTruthy();
  expect(screen.queryByLabelText("Month")).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});

it("announces loading and retries the failed month request", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json(
        { success: false, error: { message: "Trends storage is busy" } },
        { status: 503 },
      ),
    )
    .mockResolvedValueOnce(trends());
  vi.stubGlobal("fetch", fetcher);
  mount(h(Trends, { instance }));

  expect(screen.getByText("Loading trends…")).toBeTruthy();
  expect(screen.getByRole("main", { busy: true })).toBeTruthy();
  const error = within(await screen.findByRole("alert"));
  expect(error.getByText("Trends unavailable")).toBeTruthy();
  expect(error.getByText("Trends storage is busy")).toBeTruthy();
  fireEvent.click(error.getByRole("button", { name: "Retry" }));

  expect(
    await screen.findByRole("heading", { name: "November 2026" }),
  ).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("main", { busy: false })).toBeTruthy();
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    "/api/v1/trends?month=2026-11&topic=Computer+Vision",
    "/api/v1/trends?month=2026-11&topic=Computer+Vision",
  ]);
});

it("keeps the month on screen while the next one loads, with no loading step between", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const month = new URL(url, "http://localhost").searchParams.get("month")!;
      if (month === currentMonth) return trends();
      await held;
      return trends({ month, detail: { ...detail, month, volume: 34 } });
    }),
  );
  mount(h(Trends, { instance }));
  await screen.findByRole("heading", { name: "November 2026" });
  fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
  // November stays, numbers and all, until October's answer is in.
  expect(screen.queryByText("Loading trends…")).toBeNull();
  expect(screen.getByRole("heading", { name: "November 2026" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Stereo baseline" })).toBeTruthy();
  expect(screen.getByRole("main", { busy: true })).toBeTruthy();
  release();
  expect(
    await screen.findByRole("heading", { name: "October 2026" }),
  ).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "November 2026" })).toBeNull();
  expect(screen.getByRole("main", { busy: false })).toBeTruthy();
});

it("switches topic and month, resets paging, and shows a month still awaiting backfill", async () => {
  const history = [{ month: "2026-10", volume: 34, picks: 0, radarHits: 2 }];
  const fetcher = vi.fn(async (url: string) => {
    const params = new URL(url, "http://localhost").searchParams;
    const topic = params.get("topic");
    const month = params.get("month")!;
    if (topic === "Computer Vision") return trends();
    return trends({
      topic,
      month,
      history,
      detail:
        month === "2026-10"
          ? {
              ...detail,
              month,
              volume: 34,
              shortlisted: 2,
              radar: { high: 2, medium: 0, borrow: 0 },
              pickCount: 0,
              saveCount: 0,
              ratingCount: 0,
              recurring: [],
              rising: [],
              picks: [],
              activity: [],
            }
          : null,
    });
  });
  vi.stubGlobal("fetch", fetcher);
  mount(h(Trends, { instance }), "/app/trends?pickOffset=20&activityOffset=20");

  await screen.findByRole("link", { name: "Stereo baseline" });
  fireEvent.change(screen.getByRole("combobox", { name: "Topic" }), {
    target: { value: "Language" },
  });
  await screen.findByText("No trends for November 2026");
  expect(screen.queryByRole("link", { name: "Stereo baseline" })).toBeNull();
  expect(screen.getByLabelText("Current URL").textContent).toBe(
    "/app/trends?month=2026-11&topic=Language",
  );

  fireEvent.click(screen.getByRole("button", { name: "Oct 2026" }));
  expect(
    await screen.findByRole("heading", { name: "October 2026" }),
  ).toBeTruthy();
  const totals = within(screen.getByRole("region", { name: "Monthly totals" }));
  expect(
    totals.getByRole("button", { name: "Oct 2026", current: true }),
  ).toBeTruthy();
  const picksRow = within(totals.getByRole("row", { name: /^Picks / }));
  expect(picksRow.getByRole("cell", { name: "0" })).toBeTruthy();
  expect(card("Recurring terms").getByText("No terms yet.")).toBeTruthy();
  expect(
    card("Digest picks").getByText("No papers in this month."),
  ).toBeTruthy();

  fireEvent.change(screen.getByLabelText("Month"), {
    target: { value: "2026-09" },
  });
  await screen.findByText("No trends for September 2026");
  expect(
    screen.getByText(/Earlier months appear as backfill completes/),
  ).toBeTruthy();
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    "/api/v1/trends?month=2026-11&topic=Computer+Vision&pickOffset=20&activityOffset=20",
    "/api/v1/trends?month=2026-11&topic=Language",
    "/api/v1/trends?month=2026-10&topic=Language",
    "/api/v1/trends?month=2026-09&topic=Language",
  ]);
});

it.each([
  [
    "Asia/Kuala_Lumpur",
    "2026-12-31T18:00:00Z",
    "2027-01",
    "January 2027",
    "Feb 2026",
  ],
  [
    "America/Los_Angeles",
    "2027-01-01T03:00:00Z",
    "2026-12",
    "December 2026",
    "Jan 2026",
  ],
])(
  "uses the instance month in %s at the turn of the year",
  async (timezone, instant, month, heading, oldestLabel) => {
    vi.setSystemTime(new Date(instant));
    // One refreshed month, so the twelve-month table is shown.
    const fetcher = vi.fn(async () =>
      trends({
        month,
        currentMonth: month,
        detail: null,
        history: [{ month, volume: 1, picks: 0, radarHits: 0 }],
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    mount(
      h(Trends, { instance: { ...instance, timezone } }),
      "/app/trends?topic=Unknown&month=2027-02",
    );

    await screen.findByText(`No trends for ${heading}`);
    const input = screen.getByLabelText<HTMLInputElement>("Month");
    expect(input.value).toBe(month);
    expect(input.max).toBe(month);
    expect(screen.getByRole("button", { name: oldestLabel })).toBeTruthy();
    fireEvent.change(input, { target: { value: "2027-02" } });
    fireEvent.change(input, { target: { value: "" } });
    expect(input.value).toBe(month);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      `/api/v1/trends?month=${month}&topic=Computer+Vision`,
      expect.anything(),
    );
  },
);

it("pages picks and saved or rated papers independently while keeping the current lists during loading", async () => {
  const firstPage = { ...detail, nextPickOffset: 20, nextActivityOffset: 20 };
  const secondPick = { paperId: "pap_second_pick", title: "More stereo picks" };
  const secondActivity = {
    paperId: "pap_second_save",
    title: "More saved papers",
    saved: true,
    rating: null,
  };
  let finishPickPage!: (response: Response) => void;
  const pendingPickPage = new Promise<Response>((resolve) => {
    finishPickPage = resolve;
  });
  const fetcher = vi.fn(async (url: string) => {
    const params = new URL(url, "http://localhost").searchParams;
    const pickPage = params.has("pickOffset");
    const activityPage = params.has("activityOffset");
    if (pickPage && !activityPage) return pendingPickPage;
    return trends({
      detail: {
        ...firstPage,
        ...(pickPage && { picks: [secondPick], nextPickOffset: null }),
        ...(activityPage && {
          activity: [secondActivity],
          nextActivityOffset: null,
        }),
      },
    });
  });
  vi.stubGlobal("fetch", fetcher);
  mount(h(Trends, { instance }));

  const firstPick = await screen.findByRole("link", {
    name: "Stereo baseline",
  });
  // Picks open beside the page in the side panel.
  expect(firstPick.getAttribute("href")).toBe(
    "/app/trends?panel=paper%3Aarxiv%2F2611.001",
  );
  const picks = card("Digest picks");
  const activity = card("Saved and rated papers");
  expect(activity.getByText("Saved · Rated up")).toBeTruthy();
  expect(activity.getByText("Rated down")).toBeTruthy();
  expect(activity.getByText("Paper unavailable")).toBeTruthy();
  expect(
    activity.queryByRole("link", { name: "Paper unavailable" }),
  ).toBeNull();
  expect(
    activity.getByRole("link", { name: "Saved baseline" }).getAttribute("href"),
  ).toBe("/app/trends?panel=paper%3Apap_saved");

  fireEvent.click(picks.getByRole("button", { name: "More papers" }));
  expect(picks.getByRole("link", { name: "Stereo baseline" })).toBe(firstPick);
  expect(
    picks.getByRole<HTMLButtonElement>("button", { name: "Previous papers" })
      .disabled,
  ).toBe(true);
  expect(
    activity.getByRole<HTMLButtonElement>("button", { name: "More papers" })
      .disabled,
  ).toBe(true);
  finishPickPage(
    trends({
      detail: { ...firstPage, picks: [secondPick], nextPickOffset: null },
    }),
  );
  await picks.findByRole("link", { name: secondPick.title });
  expect(picks.queryByRole("button", { name: "More papers" })).toBeNull();

  fireEvent.click(activity.getByRole("button", { name: "More papers" }));
  await activity.findByRole("link", { name: secondActivity.title });
  expect(picks.getByRole("link", { name: secondPick.title })).toBeTruthy();
  expect(activity.queryByRole("button", { name: "More papers" })).toBeNull();
  fireEvent.click(picks.getByRole("button", { name: "Previous papers" }));
  await picks.findByRole("link", { name: "Stereo baseline" });
  expect(
    activity.getByRole("link", { name: secondActivity.title }),
  ).toBeTruthy();
  fireEvent.click(activity.getByRole("button", { name: "Previous papers" }));
  await activity.findByRole("link", { name: "Saved baseline" });
  expect(screen.getByLabelText("Current URL").textContent).toBe(
    "/app/trends?month=2026-11&topic=Computer+Vision",
  );
  expect(
    fetcher.mock.calls.map(([url]) => new URL(url, "http://localhost").search),
  ).toEqual([
    "?month=2026-11&topic=Computer+Vision",
    "?month=2026-11&topic=Computer+Vision&pickOffset=20",
    "?month=2026-11&topic=Computer+Vision&pickOffset=20&activityOffset=20",
    "?month=2026-11&topic=Computer+Vision&activityOffset=20",
  ]);
});

it("opens Trends from the phone menu and follows a term to the private Days search", async () => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(width < 48rem)",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  const recurringUrl =
    "/app/days?month=2026-11&topic=Computer+Vision&term=stereo";
  const fetcher = vi.fn(async (url: string) => {
    if (url === "/api/v1/instance") return json(instance);
    if (url === "/api/v1/feed/days/2026-11-17/counts") {
      return json({
        day: "2026-11-17",
        status: "final",
        counts: {
          total: 1,
          summarised: 1,
          shortlisted: 1,
          arxiv: 1,
          venues: 0,
          topics: {},
          sources: {},
          venueCounts: {},
        },
      });
    }
    if (url === "/api/v1/trends?month=2026-11&topic=Computer+Vision")
      return trends();
    expect(url).toBe(
      recurringUrl.replace("/app/days", "/api/v1/trends/search"),
    );
    return json({
      items: [{ paperId: "pap_stereo", title: "Stereo matching in practice" }],
      nextCursor: null,
    });
  });
  vi.stubGlobal("fetch", fetcher);
  mount(h(App), "/app/settings");

  const more = await screen.findByRole("button", { name: "More" });
  fireEvent.click(more);
  const menu = within(screen.getByRole("dialog", { name: "More" }));
  fireEvent.click(menu.getByRole("link", { name: "Trends" }));
  await screen.findByRole("heading", { name: "Trends", level: 1 });
  expect(screen.queryByRole("dialog", { name: "More" })).toBeNull();
  const trendsMore = screen.getByRole("button", { name: "More" });
  expect(trendsMore.getAttribute("data-active")).toBe("true");
  fireEvent.click(trendsMore);
  const trendsMenu = within(
    screen.getByRole("navigation", { name: "More pages" }),
  );
  expect(
    trendsMenu.getByRole("link", { name: "Trends", current: "page" }),
  ).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("dialog", { name: "More" }), {
    key: "Escape",
  });

  const recurring = await screen.findByRole("link", { name: "stereo" });
  expect(recurring.getAttribute("href")).toBe(recurringUrl);
  expect(
    card("Rising terms")
      .getByRole("link", { name: "深度估计" })
      .getAttribute("href"),
  ).toBe(
    "/app/days?month=2026-11&topic=Computer+Vision&term=%E6%B7%B1%E5%BA%A6%E4%BC%B0%E8%AE%A1",
  );
  scrollTo.mockClear();
  fireEvent.click(recurring);
  await screen.findByRole("link", { name: "Stereo matching in practice" });
  expect(screen.getByLabelText("Current URL").textContent).toBe(recurringUrl);
  expect(scrollTo).toHaveBeenCalledWith(0, 0);
  expect(
    screen.getByRole("button", { name: "More" }).getAttribute("data-active"),
  ).toBe("false");
  expect(
    screen.getByRole("link", { name: "Back to Trends" }).getAttribute("href"),
  ).toBe("/app/trends?month=2026-11&topic=Computer+Vision");
});

it("continues a term search after an empty page and retries the same search cursor", async () => {
  const search =
    "/api/v1/trends/search?month=2026-11&topic=Computer+Vision&term=stereo";
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(json({ items: [], nextCursor: "scan+2" }))
    .mockResolvedValueOnce(Response.json({ success: false }, { status: 503 }))
    .mockResolvedValueOnce(json({ items: [], nextCursor: null }));
  vi.stubGlobal("fetch", fetcher);
  mount(
    h(Days, { isPublic: false, timezone: "UTC" }),
    "/app/days?month=2026-11&topic=Computer+Vision&term=stereo",
  );

  expect(screen.getByText("Searching titles and abstracts…")).toBeTruthy();
  expect(
    await screen.findByText("No matches in the papers checked so far"),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Search more papers" }));
  const error = within(await screen.findByRole("alert"));
  expect(error.getByText("Could not search more papers")).toBeTruthy();
  fireEvent.click(error.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("No matching papers")).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Search more papers" }),
  ).toBeNull();
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    search,
    search + "&cursor=scan%2B2",
    search + "&cursor=scan%2B2",
  ]);
});

it("summarises the month in one place and charts papers and radar hits by month", async () => {
  const fetcher = vi.fn(async (url: string) => {
    const month = new URL(url, "http://localhost").searchParams.get("month")!;
    return trends({
      month,
      history: [
        { month: "2026-10", volume: 1000, picks: 18, radarHits: 4 },
        { month: currentMonth, volume: 1200, picks: 21, radarHits: 9 },
      ],
      detail: { ...detail, month },
    });
  });
  vi.stubGlobal("fetch", fetcher);
  mount(h(Trends, { instance }));
  // The summary says which month it describes before its numbers.
  const summary = within(
    await screen.findByRole("region", { name: "November 2026 summary" }),
  );
  expect(summary.getByText("1,200")).toBeTruthy();
  expect(summary.getByText("+200 vs Oct")).toBeTruthy();
  expect(summary.getByText(/on your topics/)).toBeTruthy();
  expect(summary.getByText(/saved/)).toBeTruthy();
  // The radar grades are said once, in the summary.
  const grades = within(summary.getByRole("list", { name: "Radar grades" }));
  expect(
    grades.getAllByRole("listitem").map((item) => item.textContent),
  ).toEqual(["3 high", "4 medium", "2 borrow"]);
  expect(screen.getAllByRole("list", { name: "Radar grades" })).toHaveLength(1);
  // Two charts: papers and radar hits. Picks (a handful a month) are a
  // number in the summary, not a chart.
  expect(
    screen.queryByRole("button", { name: "Oct 2026: 18 picks" }),
  ).toBeNull();
  expect(
    screen.getByRole("button", { name: "Oct 2026: 4 radar hits" }),
  ).toBeTruthy();
  expect(screen.queryByText(/^scale /)).toBeNull();
  // The selected month is the current item in each set, not "today".
  const current = [...document.querySelectorAll("[aria-current]")]
    .map((element) => element.getAttribute("aria-current"))
    .filter((value) => value !== "page");
  expect(current.length).toBeGreaterThanOrEqual(2);
  expect(new Set(current)).toEqual(new Set(["true"]));
  fireEvent.click(
    screen.getByRole("button", { name: "Oct 2026: 1,000 papers" }),
  );
  await screen.findByRole("heading", { name: "October 2026" });
  // The month stepper moves forward again; it stops at the current month.
  fireEvent.click(screen.getByRole("button", { name: "Next month" }));
  await screen.findByRole("heading", { name: "November 2026" });
  expect(
    (screen.getByRole("button", { name: "Next month" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  // The exact numbers stay available as a table.
  expect(screen.getByText("Show as table")).toBeTruthy();
  expect(screen.getByRole("region", { name: "Monthly totals" })).toBeTruthy();
});

it("hides rising terms when last month is too thin and says what they compare with", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      trends({
        detail: {
          ...detail,
          comparison: { days: 1, first: "2026-10-30", last: "2026-10-30" },
        },
      }),
    )
    .mockResolvedValueOnce(
      trends({
        month: "2026-10",
        detail: {
          ...detail,
          month: "2026-10",
          comparison: { days: 2, first: "2026-09-29", last: "2026-09-30" },
        },
      }),
    );
  vi.stubGlobal("fetch", fetcher);
  mount(h(Trends, { instance }));
  await screen.findByRole("heading", { name: "Rising terms" });
  const thin = card("Rising terms");
  expect(
    thin.getByText(
      "Rising terms need at least 5 days of last month; October has 1.",
    ),
  ).toBeTruthy();
  expect(thin.queryByRole("link", { name: /深度估计/ })).toBeNull();
  // Recurring terms do not depend on last month.
  expect(
    card("Recurring terms").getByRole("link", { name: /stereo/ }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
  await screen.findByRole("heading", { name: "October 2026" });
  expect(
    card("Rising terms").getByText(
      "Rising terms need at least 5 days of last month; September has 2.",
    ),
  ).toBeTruthy();
});

it("says which days of last month rising terms compare with", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      trends({
        detail: {
          ...detail,
          comparison: { days: 18, first: "2026-10-05", last: "2026-10-30" },
        },
      }),
    ),
  );
  mount(h(Trends, { instance }));
  await screen.findByRole("heading", { name: "Rising terms" });
  const rising = card("Rising terms");
  expect(
    rising.getByText("Compared with 18 days of October (5 Oct–30 Oct)."),
  ).toBeTruthy();
  expect(rising.getByRole("link", { name: /深度估计/ })).toBeTruthy();
});

it("leaves zero grades out of the legend and labels the month group", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      trends({
        detail: { ...detail, radar: { high: 1, medium: 0, borrow: 6 } },
      }),
    ),
  );
  mount(h(Trends, { instance }));
  const summary = within(
    await screen.findByRole("region", { name: "November 2026 summary" }),
  );
  const grades = within(summary.getByRole("list", { name: "Radar grades" }));
  expect(
    grades.getAllByRole("listitem").map((item) => item.textContent),
  ).toEqual(["1 high", "6 borrow"]);
  // The scale's value sits in its own gutter: a full-height bar never
  // covers it.
  const chart = screen.getByText("Radar hits per month").closest("figure")!;
  const scale = within(chart).getByText("10");
  const column = within(chart).getByRole("button", {
    name: "Nov 2026: 9 radar hits",
  });
  expect(column.parentElement!.contains(scale)).toBe(false);
  // "Month" names the whole stepper (previous, picker, next), not just the
  // picker in its middle.
  const group = screen.getByRole("group", { name: "Month" });
  expect(
    within(group).getByRole("button", { name: "Previous month" }),
  ).toBeTruthy();
  expect(within(group).getByLabelText("Month")).toBeTruthy();
  expect(
    within(group).getByRole("button", { name: "Next month" }),
  ).toBeTruthy();
});
