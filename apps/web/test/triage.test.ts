// @vitest-environment jsdom
// The busy-day reader: a triage queue the brief and public code fill, the
// decisions (skip, to read, save) and the compact list.
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { createElement as h } from "react";
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

const day = "2026-11-24";
function makePaper(id: string, title: string, code = false) {
  return {
    paperId: id,
    title,
    abstract: "Abstract",
    authors: [{ name: "Ada" }],
    authorCount: 1,
    source: "arxiv",
    topics: ["Vision"],
    shortlisted: true,
    summaries: [],
    tldr: [{ lang: "en", text: "TLDR text" }],
    identifiers: [],
    links: code ? [{ kind: "code", url: "https://github.com/a/b" }] : [],
    venue: null,
    venueKind: "preprint",
    year: 2026,
    publishedOn: null,
    categories: [],
    hfUpvotes: null,
    readingState: { readAt: null, skippedAt: null, library: null },
  };
}
const papers = [
  makePaper("pap_a", "Alpha study"),
  makePaper("pap_b", "Beta study", true),
  makePaper("pap_c", "Gamma study"),
  makePaper("pap_d", "Delta study"),
];
const queue = [
  { ...papers[2]!, reason: "radar" },
  { ...papers[0]!, reason: "pick" },
  { ...papers[1]!, reason: "code" },
];
const instance = {
  name: "LitScout",
  publicFeed: false,
  language: "en" as const,
  timezone: "UTC",
  topics: ["Vision"],
};
const json = (data: unknown) => Response.json({ success: true, data });
const state = (paperId: string, more = {}) => ({
  paperId,
  readAt: null,
  starred: false,
  readLater: false,
  rating: "none",
  libraryRev: null,
  libraryStatus: null,
  skippedAt: null,
  ...more,
});

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.scrollTo = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function serve(onTopics = papers.length) {
  const calls: { path: string; method: string; body?: unknown }[] = [];
  const skipped = new Set<string>();
  const kept = new Map<string, string>();
  const skippedState = (paperId: string) => ({
    skippedAt: skipped.has(paperId) ? "2026-11-24T02:00:00Z" : null,
    libraryStatus: kept.get(paperId) ?? null,
    libraryRev: kept.has(paperId) ? 1 : null,
  });
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const parsed = new URL(url, "https://local");
      const path = parsed.pathname.replace("/api/v1", "");
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ path: path + parsed.search, method, body });
      if (path.endsWith("/triage"))
        return json({ day, items: queue, toRead: 2 });
      if (path.endsWith("/digest")) return json(null);
      if (/\/papers\//.test(path))
        return json(
          papers.find((paper) => path.endsWith(paper.paperId)) ?? null,
        );
      if (/\/days\/\d{4}-\d\d-\d\d$/.test(path))
        return json({
          day,
          status: "final",
          counts: {
            total: onTopics + 1,
            summarised: onTopics,
            shortlisted: onTopics,
            arxiv: onTopics + 1,
            venues: 0,
            topics: { Vision: onTopics },
            sources: { arxiv: onTopics + 1 },
            venueCounts: {},
          },
          items: papers,
          nextCursor: null,
        });
      if (path === "/events") {
        if (body.kind === "skip") skipped.add(body.paperId);
        if (body.kind === "unskip") skipped.delete(body.paperId);
        return json(state(body.paperId, skippedState(body.paperId)));
      }
      if (path === "/library") {
        kept.set(body.paperId, body.status);
        return json({
          paperId: body.paperId,
          status: body.status,
          tags: [],
          addedVia: "feed",
          addedAt: "2026-11-24T02:00:00Z",
          updatedAt: "2026-11-24T02:00:00Z",
          deletedAt: null,
          rev: 1,
        });
      }
      if (path === "/state")
        return json({
          items: [
            state(
              parsed.searchParams.get("paperId")!,
              skippedState(parsed.searchParams.get("paperId")!),
            ),
          ],
          nextCursor: null,
        });
      return json({ items: [], nextCursor: null });
    }),
  );
  return calls;
}
function mount(path = `/app/today?day=${day}`) {
  return render(
    h(
      QueryClientProvider,
      {
        client: new QueryClient({
          defaultOptions: { queries: { retry: false } },
        }),
      },
      h(
        MemoryRouter,
        { initialEntries: [path] },
        h(Feed, { isPublic: false, instance }),
      ),
    ),
  );
}
const decisions = (calls: ReturnType<typeof serve>) =>
  calls
    .filter(
      (call) =>
        call.method === "POST" &&
        (call.path === "/library" ||
          (call.body as { kind?: string }).kind !== "open"),
    )
    .map((call) => call.body);

it("leaves skipped papers out of the signed-in list and marks the rows", async () => {
  const calls = serve();
  mount();
  const list = await screen.findByRole("region", { name: "Paper list" });
  expect(
    calls.map((call) => call.path).filter((path) => path.includes("limit=")),
  ).toEqual([`/feed/days/${day}?shortlisted=true&decision=open&limit=100`]);
  const row = (title: string) =>
    within(list).getByRole("button", { name: new RegExp(title) });
  await waitFor(() =>
    expect(within(row("Gamma study")).getByText("Radar")).toBeTruthy(),
  );
  expect(within(row("Alpha study")).getByText("Brief pick")).toBeTruthy();
  expect(within(row("Beta study")).getByText("Code")).toBeTruthy();
  expect(within(row("Delta study")).queryByText(/Radar|Brief pick|Code/)).toBe(
    null,
  );
});

it("says what the queue holds and walks it one decision at a time", async () => {
  const calls = serve();
  mount();
  const card = await screen.findByRole("region", { name: "Triage queue" });
  await within(card).findByRole("heading", {
    name: "3 of 4 papers are worth a decision",
  });
  expect(card.textContent).toContain(
    "1 on your project radar · 1 picked by the brief · 1 more with public code",
  );
  expect(
    within(card).getByRole("link", { name: "Library · To read 2" }),
  ).toBeTruthy();
  fireEvent.click(within(card).getByRole("button", { name: "Start triage" }));
  // The queue's order, not the list's: the radar paper comes first.
  const bar = await screen.findByRole("toolbar", { name: "Triage decision" });
  expect(screen.getByText("Triage · 1 of 3")).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "Paper list" })).getAllByRole(
      "button",
    )[0]!.textContent,
  ).toContain("Gamma study");
  fireEvent.click(within(bar).getByRole("button", { name: /^Skip/ }));
  await screen.findByText("Triage · 2 of 3");
  fireEvent.click(
    within(screen.getByRole("toolbar", { name: "Triage decision" })).getByRole(
      "button",
      { name: /^To read/ },
    ),
  );
  await screen.findByText("Triage · 3 of 3");
  // A key decides too.
  fireEvent.keyDown(screen.getByRole("toolbar", { name: "Triage decision" }), {
    key: "s",
  });
  await screen.findByRole("heading", { name: "Queue cleared" });
  expect(screen.getByText(/You decided on all 3 papers/).textContent).toContain(
    "1 to read, 1 saved, 1 skipped",
  );
  await waitFor(() =>
    expect(decisions(calls)).toEqual([
      { paperId: "pap_c", kind: "skip", source: "feed" },
      { paperId: "pap_a", source: "feed", status: "to_read" },
      { paperId: "pap_b", source: "feed", status: "saved" },
    ]),
  );
  expect(
    screen.getByRole("link", { name: "Library · To read 3" }),
  ).toBeTruthy();
});

it("takes the last decision back and shows its paper again", async () => {
  const calls = serve();
  mount(`/app/today?day=${day}&triage=1&paper=pap_c&paperSource=arxiv`);
  const bar = await screen.findByRole("toolbar", { name: "Triage decision" });
  fireEvent.click(within(bar).getByRole("button", { name: /^Skip/ }));
  await screen.findByText("Triage · 2 of 3");
  fireEvent.keyDown(screen.getByRole("toolbar", { name: "Triage decision" }), {
    key: "u",
  });
  await screen.findByText("Triage · 1 of 3");
  await waitFor(() =>
    expect(decisions(calls)).toEqual([
      { paperId: "pap_c", kind: "skip", source: "feed" },
      { paperId: "pap_c", kind: "unskip", source: "feed" },
    ]),
  );
});

it("queues the brief's picks alone when asked, and remembers it", async () => {
  serve();
  mount();
  const card = await screen.findByRole("region", { name: "Triage queue" });
  await within(card).findByRole("heading", {
    name: "3 of 4 papers are worth a decision",
  });
  fireEvent.click(
    within(card).getByRole("button", { name: "Brief's picks only" }),
  );
  await screen.findByRole("heading", {
    name: "2 of 4 papers are worth a decision",
  });
  expect(localStorage.getItem("litscout:triage-size")).toBe("picks");
});

it("starts a long day compact and keeps the reader's own choice", async () => {
  serve(61);
  mount();
  const list = await screen.findByRole("region", { name: "Paper list" });
  const first = () => within(list).getAllByRole("button")[0]!;
  expect(first().getAttribute("data-density")).toBe("compact");
  expect(first().textContent).not.toContain("TLDR text");
  fireEvent.click(screen.getByRole("radio", { name: "Summaries" }));
  await waitFor(() => expect(first().textContent).toContain("TLDR text"));
  expect(localStorage.getItem("litscout:list-density")).toBe("summaries");
});

it("keeps a short day's rows with their summaries", async () => {
  serve(4);
  mount();
  const list = await screen.findByRole("region", { name: "Paper list" });
  expect(
    within(list).getAllByRole("button")[0]!.getAttribute("data-density"),
  ).toBe(null);
});
