// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PaperActions } from "../src/PaperActions";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("sends the open again when the first one failed", async () => {
  let fail = true;
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST" && fail) {
      fail = false;
      return Response.json({ success: false }, { status: 503 });
    }
    return Response.json({
      success: true,
      data:
        init?.method === "POST"
          ? {
              paperId: "pap_retry",
              readAt: "2026-11-20T08:00:00.000Z",
              starred: false,
              readLater: false,
              rating: "none",
              libraryRev: null,
            }
          : { items: [], nextCursor: null },
    });
  });
  vi.stubGlobal("fetch", fetcher);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const mount = () =>
    render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(PaperActions, { paperId: "pap_retry", inReader: true }),
      ),
    );
  const posts = () =>
    fetcher.mock.calls.filter(([, init]) => init?.method === "POST").length;
  const first = mount();
  await waitFor(() => expect(posts()).toBe(1));
  await new Promise((resolve) => setTimeout(resolve, 20));
  first.unmount();
  mount();
  await waitFor(() => expect(posts()).toBe(2));
});

// Opening a paper used to refetch every loaded page of the day's list and
// post an open event on every mount (independent review, 2026-11-20).
it("marks the paper read in the loaded list without refetching it, once per session", async () => {
  const state = {
    paperId: "pap_open",
    readAt: "2026-11-20T08:00:00.000Z",
    starred: false,
    readLater: false,
    rating: "none",
    libraryRev: null,
  };
  const fetcher = vi.fn(async (url: string, init?: RequestInit) =>
    Response.json({
      success: true,
      data:
        init?.method === "POST"
          ? state
          : { items: [{ ...state, readAt: null }], nextCursor: null },
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const feedKey = ["feed", false, "2026-11-20", "shortlisted=true"];
  client.setQueryData(feedKey, {
    pageParams: [""],
    pages: [
      {
        items: [
          { paperId: "pap_open", readingState: { readAt: null } },
          { paperId: "pap_other", readingState: { readAt: null } },
        ],
        nextCursor: null,
      },
    ],
  });
  const mount = () =>
    render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(PaperActions, { paperId: "pap_open", inReader: true }),
      ),
    );
  const first = mount();
  await waitFor(() =>
    expect(
      fetcher.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1),
  );
  await waitFor(() =>
    expect(
      (
        client.getQueryData(feedKey) as {
          pages: {
            items: {
              paperId: string;
              readingState: { readAt: string | null };
            }[];
          }[];
        }
      ).pages[0]!.items.map((item) => item.readingState.readAt),
    ).toEqual([state.readAt, null]),
  );
  expect(client.getQueryState(feedKey)?.isInvalidated).toBe(false);
  first.unmount();
  mount();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(
    fetcher.mock.calls.filter(([, init]) => init?.method === "POST"),
  ).toHaveLength(1);
  expect(
    fetcher.mock.calls.some(([url]) => String(url).includes("/feed/days")),
  ).toBe(false);
});
