// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Feed } from "../src/Feed";
import { Paper } from "../src/Paper";
const instance = {
  name: "LitScout",
  publicFeed: true,
  language: "en" as const,
  timezone: "America/Los_Angeles",
  topics: ["Vision"],
};
const full = {
  paperId: "pap_a",
  source: "arxiv",
  title: "Reading example",
  authors: [{ name: "Ada" }],
  topics: ["Vision"],
  shortlisted: false,
  abstract:
    "A **safe** abstract.\n\n<script>bad()</script>\n\n[bad](javascript:alert)",
  identifiers: [{ scheme: "arxiv", value: "2611.00001" }],
  links: [
    {
      kind: "landing",
      url: "https://arxiv.org/abs/2611.00001",
      checkedAt: "2026-11-17T08:00:00Z",
      httpStatus: 404,
      oaStatus: "green",
    },
  ],
  summaries: [
    {
      lang: "en" as const,
      content: {
        tldr: "A short account.",
        motivation: "Why",
        method: "How",
        result: "What",
        conclusion: "Then",
      },
    },
  ],
  venue: "A venue",
  venueKind: "conference",
  year: 2026,
  publishedOn: "2026-11-17",
  categories: ["cs.CV"],
  hfUpvotes: null,
};
function envelope(status = "final") {
  return {
    success: true,
    data: {
      day: "2026-11-17",
      status,
      counts: {
        total: 0,
        summarised: 0,
        shortlisted: 0,
        arxiv: 0,
        venues: 0,
        topics: {},
        sources: {},
        venueCounts: {},
      },
      items: [],
      nextCursor: null,
    },
  };
}
function mount(path = "/public/days/2026-11-17") {
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
        createElement(Feed, { isPublic: true, instance }),
      ),
    ),
  );
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it.each([
  ["pending", "Waiting for an announcement.", "No papers yet for this day."],
  [
    "empty",
    "No announcement for this day.",
    "arXiv made no announcement for this day.",
  ],
  ["final", "No papers match these filters.", "No papers on this day."],
])("explains the %s paper-list state", async (status, text, readerText) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(envelope(status))),
  );
  mount();
  await screen.findByText(text);
  expect(screen.getByText("17 Nov 2026").getAttribute("datetime")).toBe(
    "2026-11-17",
  );
  // The public feed has no brief: with no papers, the reader column says
  // so rather than inviting a choice (UI audit #14).
  const reader = screen.getByRole("region", { name: "Selected paper" });
  expect(reader.textContent).toContain(readerText);
  expect(reader.textContent).not.toContain("Choose a paper");
  if (status === "pending") {
    expect(screen.getByText(/arXiv announces new papers/)).toBeTruthy();
    // This is the public feed: its own days, and no private Library link.
    expect(
      screen
        .getByRole("link", { name: "Choose another day" })
        .getAttribute("href"),
    ).toBe("/public/days");
    expect(screen.queryByRole("link", { name: "Library" })).toBeNull();
  }
});
it("allows a failed full-record fetch to be retried without losing the day", async () => {
  let fail = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (!url.includes("/papers/")) return Response.json(envelope());
      if (fail)
        return Response.json(
          { success: false, error: { message: "Detail unavailable" } },
          { status: 503 },
        );
      return Response.json({ success: true, data: full });
    }),
  );
  mount("/public/days/2026-11-17?paper=pap_a&paperSource=arxiv");
  await screen.findByText("Detail unavailable");
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry paper" }));
  await screen.findByRole("heading", { name: "Reading example" });
  expect(
    screen.getByRole("link", { name: "Open full record" }).getAttribute("href"),
  ).toContain("day=2026-11-17&source=arxiv");
});
it("labels the publication date on a paper", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.includes("/papers/")
        ? Response.json({ success: true, data: full })
        : Response.json(envelope()),
    ),
  );
  mount("/public/days/2026-11-18?paper=pap_a&paperSource=arxiv");
  await screen.findByRole("heading", { name: "Reading example" });
  const published = screen.getByText("Published 17 Nov 2026");
  expect(published.getAttribute("datetime")).toBe("2026-11-17");
});
it("distinguishes a missing selected record from an empty list", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.includes("/papers/")
        ? Response.json({ success: false }, { status: 404 })
        : Response.json(envelope()),
    ),
  );
  mount("/public/days/2026-11-17?paper=pap_missing&paperSource=arxiv");
  await screen.findByText("Paper not found in this day.");
});
it("renders four summary terms, sanitised abstract, arXiv links and stored check dates", () => {
  const { container } = render(
    createElement(
      MemoryRouter,
      {},
      createElement(Paper, {
        paper: full,
        topics: ["Vision"],
        timezone: "America/Los_Angeles",
      }),
    ),
  );
  expect(screen.getAllByRole("term").map((term) => term.textContent)).toEqual([
    "Motivation",
    "Method",
    "Result",
    "Conclusion",
    "arxiv",
  ]);
  expect(
    screen.getByRole("link", { name: "Read PDF" }).getAttribute("href"),
  ).toBe("https://arxiv.org/pdf/2611.00001");
  expect(
    screen.getByRole("link", { name: "alphaXiv" }).getAttribute("href"),
  ).toContain("alphaxiv.org/abs/2611.00001");
  const checkedAt = screen.getByText("17 Nov 2026, 00:00 GMT-8");
  expect(checkedAt.getAttribute("datetime")).toBe("2026-11-17T08:00:00Z");
  expect(checkedAt.parentElement?.textContent).toContain("HTTP 404 · Checked");
  expect(screen.getByText("Link unavailable")).toBeTruthy();
  expect(container.querySelector("script")).toBeNull();
  expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
  expect(
    screen.queryByRole("button", { name: /save|rate|capture|vault/i }),
  ).toBeNull();
});

it("loads an archived paper's abstract only after Load details is clicked", async () => {
  const requests = vi.fn(async (url: string) => {
    if (url !== "/api/v1/papers/pap_a/details")
      return Response.json(
        { success: false, error: { message: "Panel unavailable" } },
        { status: 404 },
      );
    return Response.json({
      success: true,
      data: {
        available: true,
        abstract: "Recovered abstract",
        authors: [{ name: "Recovered Author" }],
      },
    });
  });
  vi.stubGlobal("fetch", requests);
  render(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(
        MemoryRouter,
        null,
        createElement(Paper, {
          paper: {
            ...full,
            compact: true,
            abstract: null,
            authors: [],
            summaries: [],
            links: [],
          },
          privateActions: true,
        }),
      ),
    ),
  );
  // The page still loads its independent private action panels.
  expect(requests.mock.calls.some(([url]) => url.endsWith("/details"))).toBe(
    false,
  );
  fireEvent.click(screen.getByRole("button", { name: "Load details" }));
  await screen.findByText("Recovered abstract");
  expect(
    requests.mock.calls.filter(([url]) => url.endsWith("/details")),
  ).toHaveLength(1);
});
