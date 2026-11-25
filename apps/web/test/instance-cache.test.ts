// @vitest-environment jsdom
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useFeed, useFeedCounts, useInstance } from "../src/api";
import { readCachedInstance } from "../src/instance-cache";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});
const json = (data: unknown) => Response.json({ success: true, data });
const instance = {
  name: "LitScout",
  publicFeed: true,
  language: "en",
  timezone: "Asia/Shanghai",
  topics: ["Vision"],
};
const wrap = (child: ReturnType<typeof createElement>) =>
  render(
    createElement(
      QueryClientProvider,
      {
        client: new QueryClient({
          defaultOptions: { queries: { retry: false } },
        }),
      },
      child,
    ),
  );

function ShowInstance() {
  const query = useInstance();
  return createElement(
    "p",
    null,
    query.data
      ? `${query.data.name} ${query.data.topics.join(",")}`
      : "waiting",
  );
}

it("starts from the instance info this browser saw last, then refreshes it", async () => {
  localStorage.setItem("litscout.instance", JSON.stringify(instance));
  let answer!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>((resolve) => (answer = resolve))),
  );
  wrap(createElement(ShowInstance));
  // No wait on the network for the first paint.
  expect(screen.getByText("LitScout Vision")).toBeTruthy();
  expect(fetch).toHaveBeenCalledOnce();
  answer(json({ ...instance, topics: ["Vision", "Language"] }));
  await screen.findByText("LitScout Vision,Language");
  await waitFor(() =>
    expect(readCachedInstance()?.topics).toEqual(["Vision", "Language"]),
  );
});

it("ignores a saved copy it cannot read", () => {
  localStorage.setItem("litscout.instance", "{broken");
  expect(readCachedInstance()).toBeUndefined();
  localStorage.setItem("litscout.instance", JSON.stringify({ topics: "x" }));
  expect(readCachedInstance()).toBeUndefined();
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("blocked");
    },
  });
  expect(readCachedInstance()).toBeUndefined();
});

const counts = {
  total: 9,
  summarised: 9,
  shortlisted: 3,
  arxiv: 9,
  venues: 0,
  topics: { Vision: 3 },
  sources: { arxiv: 9 },
  venueCounts: {},
};
function TodayWithShell() {
  const feed = useFeed("2026-11-21", false, { shortlisted: true });
  // The shell's badge on Today: no request of its own.
  const shell = useFeedCounts("2026-11-21", false, false);
  return createElement(
    "p",
    null,
    `${feed.data ? "feed" : "loading"} ${shell.data?.counts.shortlisted ?? "-"}`,
  );
}

it("fills the shell's count from the day's feed and asks for 100 papers a page", async () => {
  const fetcher = vi.fn(async (_url: string) =>
    json({
      day: "2026-11-21",
      status: "final",
      counts,
      items: [],
      nextCursor: null,
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  wrap(createElement(TodayWithShell));
  await screen.findByText("feed 3");
  expect(fetcher).toHaveBeenCalledOnce();
  const url = new URL(String(fetcher.mock.calls[0]![0]), "https://local");
  expect(url.pathname).toBe("/api/v1/feed/days/2026-11-21");
  expect(url.searchParams.get("limit")).toBe("100");
});
