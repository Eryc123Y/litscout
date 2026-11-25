// @vitest-environment jsdom
// The reader fixes from the 21 Nov UI audit (items #1, #5-#10, #12, #14,
// P6, P12 and the row that shifted when a paper became read).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
import { paperStaleTime } from "../src/api";
import { Paper } from "../src/Paper";
import { Filters } from "../src/Filters";
import { DayHeading } from "../src/FeedParts";
import { PaperSummary } from "../src/PaperParts";

const css = readFileSync(
  resolve(__dirname, "../src/style.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

const summary = {
  lang: "en" as const,
  content: {
    tldr: "TLDR text",
    motivation: "Why",
    method: "How",
    result: "What",
    conclusion: "Then",
  },
};
function makePaper(id: string, title: string, arxiv?: string) {
  return {
    paperId: id,
    title,
    abstract: "Depth estimation",
    authors: [{ name: "Ada" }],
    authorCount: 1,
    source: arxiv ? "arxiv" : "journal",
    topics: ["Vision"],
    shortlisted: true,
    summaries: [summary],
    tldr: [{ lang: "en", text: "TLDR text" }],
    identifiers: arxiv ? [{ scheme: "arxiv", value: arxiv }] : [],
    links: [],
    venue: arxiv ? null : "JMLR",
    venueKind: "preprint",
    year: 2026,
    publishedOn: null,
    categories: ["cs.CV"],
    hfUpvotes: null,
  };
}
const papers = [
  makePaper("pap_a", "Alpha study", "2611.00001"),
  makePaper("pap_b", "Beta study"),
  makePaper("pap_c", "Gamma study", "2611.00003"),
];
const instance = {
  name: "LitScout",
  publicFeed: true,
  language: "en" as const,
  timezone: "UTC",
  topics: ["Vision"],
};
const counts = (total: number, shortlisted: number) => ({
  total,
  summarised: shortlisted,
  shortlisted,
  arxiv: total,
  venues: 0,
  topics: { Vision: shortlisted },
  sources: { arxiv: total },
  venueCounts: {},
});
const json = (data: unknown) => Response.json({ success: true, data });

let media: (query: string) => boolean = () => false;
beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.scrollTo = vi.fn();
});
function stubMedia(matches: (query: string) => boolean) {
  media = matches;
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: media(query),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

type Day = {
  day?: string;
  items?: typeof papers;
  status?: string;
  digest?: unknown;
  days?: { day: string; status: string; counts: { total: number } }[];
};
function serve({
  day = "2026-11-17",
  items = papers,
  status = "final",
  digest = null,
  days = [],
}: Day = {}) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, "https://local").pathname.replace("/api/v1", "");
    if (/\/papers\//.test(path)) {
      const id = decodeURIComponent(path.split("/").at(-1)!);
      return json(papers.find((paper) => paper.paperId === id) ?? null);
    }
    if (path.endsWith("/digest")) return json(digest);
    if (/\/days$/.test(path)) return json({ items: days, nextBefore: null });
    if (/\/days\/\d{4}-\d\d-\d\d$/.test(path))
      return json({
        day,
        status,
        // One listing paper is off the reader's topics.
        counts: counts(items.length && items.length + 1, items.length),
        items,
        nextCursor: null,
      });
    if (path === "/state")
      return json({
        items: [
          {
            paperId: "pap_a",
            readAt: null,
            starred: false,
            readLater: false,
            rating: "none",
            libraryRev: null,
          },
        ],
        nextCursor: null,
      });
    if (init?.method === "POST") return json(null);
    return json({ items: [], nextCursor: null });
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
function mount(path: string, isPublic = true) {
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
        h(Feed, { isPublic, instance }),
      ),
    ),
  );
}
const row = (name: string) =>
  screen.getByRole("button", { name: new RegExp(`Read ${name}`) });

it("#1 focuses the reader's title without drawing a focus box", () => {
  render(
    h(
      MemoryRouter,
      {},
      h(Paper, { paper: papers[0]!, fullHref: "/app/papers/pap_a" }),
    ),
  );
  const title = screen.getByRole("heading", { name: "Alpha study" });
  expect(title.tabIndex).toBe(-1);
  expect(title.className).toContain("focus:outline-none");
});

it("#7 j, k, o and Escape work from the list as well as the reader", async () => {
  stubMedia(() => false);
  serve();
  mount("/public/days/2026-11-17");
  await screen.findByRole("button", { name: /Read Alpha/ });
  // From a list row, j opens the first paper, then the next.
  fireEvent.keyDown(row("Alpha"), { key: "j" });
  await screen.findByRole("heading", { name: "Alpha study" });
  fireEvent.keyDown(row("Gamma"), { key: "j" });
  await screen.findByRole("heading", { name: "Beta study" });
  // From the reader, k goes back.
  fireEvent.keyDown(screen.getByRole("heading", { name: "Beta study" }), {
    key: "k",
  });
  await screen.findByRole("heading", { name: "Alpha study" });
  // Inputs, selects and popovers keep their keys.
  const select = screen.getByLabelText("Source");
  fireEvent.keyDown(select, { key: "j" });
  fireEvent.keyDown(select, { key: "Escape" });
  expect(screen.getByRole("heading", { name: "Alpha study" })).toBeTruthy();
  // o opens the PDF from the list (a new tab below 1280 px).
  const open = vi.fn();
  vi.stubGlobal("open", open);
  fireEvent.keyDown(row("Beta"), { key: "o" });
  expect(open).toHaveBeenCalledWith(
    "https://arxiv.org/pdf/2611.00001",
    "_blank",
    "noopener,noreferrer",
  );
  // Escape from the list closes the paper.
  fireEvent.keyDown(row("Beta"), { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByRole("heading", { name: "Alpha study" })).toBeNull(),
  );
  // Modified keys are left to the browser.
  fireEvent.keyDown(row("Alpha"), { key: "j", metaKey: true });
  expect(screen.queryByRole("heading", { name: "Alpha study" })).toBeNull();
});

it("#6 PDF mode steps aside for a paper without an arXiv PDF and comes back", async () => {
  stubMedia((query) => query === "(width >= 80rem)");
  serve();
  mount("/public/days/2026-11-17");
  fireEvent.click(await screen.findByRole("button", { name: /Read Alpha/ }));
  await screen.findByRole("heading", { name: "Alpha study" });
  // The title shows from the list row first; the link comes with the record.
  fireEvent.click(await screen.findByRole("link", { name: "Read PDF" }));
  expect(screen.getByRole("region", { name: "PDF" })).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("heading", { name: "Alpha study" }), {
    key: "j",
  });
  await screen.findByRole("heading", { name: "Beta study" });
  // No framable PDF: the two columns return, with the list and divider.
  await waitFor(() =>
    expect(screen.queryByRole("region", { name: "PDF" })).toBeNull(),
  );
  expect(screen.getByRole("separator")).toBeTruthy();
  expect(screen.queryByText(/no arXiv PDF to show/)).toBeNull();
  // The next paper with one opens its PDF again.
  fireEvent.keyDown(screen.getByRole("heading", { name: "Beta study" }), {
    key: "j",
  });
  await screen.findByRole("heading", { name: "Gamma study" });
  await screen.findByRole("region", { name: "PDF" });
  // Escape still closes the PDF first, then the paper.
  fireEvent.keyDown(screen.getByRole("heading", { name: "Gamma study" }), {
    key: "Escape",
  });
  await waitFor(() =>
    expect(screen.queryByRole("region", { name: "PDF" })).toBeNull(),
  );
  expect(screen.getByRole("heading", { name: "Gamma study" })).toBeTruthy();
});

it("#8 phone reading has a bottom bar with Back, Previous and Next", async () => {
  stubMedia((query) => query === "(width < 48rem)");
  serve();
  mount("/public/days/2026-11-17");
  fireEvent.click(await screen.findByRole("button", { name: /Read Alpha/ }));
  await screen.findByRole("heading", { name: "Alpha study" });
  const bar = screen.getByRole("navigation", { name: "Move between papers" });
  expect(bar.className).toContain("phone-reader-nav");
  const controls = within(bar).getAllByRole("button");
  expect(controls.map((b) => b.getAttribute("aria-label"))).toEqual([
    "Back to the list",
    "Previous paper",
    "Next paper",
  ]);
  // The first paper has nothing before it.
  expect(
    within(bar)
      .getByRole("button", { name: "Previous paper" })
      .getAttribute("aria-disabled"),
  ).toBe("true");
  // One set of Previous / Next on the phone.
  expect(screen.getAllByRole("button", { name: "Next paper" })).toHaveLength(1);
  fireEvent.click(within(bar).getByRole("button", { name: "Next paper" }));
  await screen.findByRole("heading", { name: "Beta study" });
  // The keyboard hint is hidden on touch screens.
  expect(css).toMatch(
    /@media \(pointer: coarse\)\s*\{[^}]*\.shortcut-hint\s*\{\s*display: none;/,
  );
  expect(css).toMatch(/\.phone-reader-nav\s*\{[^}]*position: sticky;/);
  expect(css).toMatch(
    /\.phone-reader-nav\s*\{[^}]*env\(safe-area-inset-bottom\)/,
  );
});

it("#8 the hint stays for keyboards and names the keys", async () => {
  stubMedia(() => false);
  serve();
  mount("/public/days/2026-11-17");
  fireEvent.click(await screen.findByRole("button", { name: /Read Alpha/ }));
  await screen.findByRole("heading", { name: "Alpha study" });
  expect((await screen.findByText(/j \/ k to move/)).className).toContain(
    "shortcut-hint",
  );
});

it("#9 #10 shows the read status on the meta line and keeps the actions together", async () => {
  serve();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    h(
      QueryClientProvider,
      { client },
      h(
        MemoryRouter,
        {},
        h(Paper, {
          paper: { ...papers[0]!, readingState: undefined },
          privateActions: true,
          fullHref: "/app/papers/pap_a",
        }),
      ),
    ),
  );
  const meta = document.querySelector<HTMLElement>('[data-slot="paper-meta"]')!;
  const chip = await within(meta).findByText("Unread");
  expect(chip.getAttribute("data-slot")).toBe("badge");
  const toolbar = screen.getByRole("toolbar", { name: "Reading actions" });
  expect(toolbar.textContent).not.toMatch(/Unread|^Read$/);
  // Desktop: icon buttons, each named and with a tooltip; phone: a tidy
  // two-by-two grid whose labels never wrap.
  for (const button of within(toolbar).getAllByRole("button")) {
    const name = button.getAttribute("aria-label")!;
    expect(
      button.parentElement?.querySelector("[data-slot=tooltip]")?.textContent,
    ).toBe(name);
  }
  expect(toolbar.className).toContain("max-md:grid-cols-2");
  expect(toolbar.querySelector("[data-slot=phone-label]")?.className).toContain(
    "whitespace-nowrap",
  );
  // Left-aligned beside the links, not pushed to the far edge.
  expect(toolbar.closest(".md\\:ml-auto")).toBeNull();
});

it("#12 fades the topic row on the side that has more to scroll", () => {
  render(
    h(Filters, {
      counts: counts(4, 3),
      topics: ["Vision", "Language", "Robotics", "Systems"],
      value: {},
      onChange: vi.fn(),
    }),
  );
  const row = screen.getByRole("radiogroup", { name: "Topics" });
  const size = (scrollLeft: number) => {
    Object.defineProperty(row, "scrollWidth", {
      configurable: true,
      value: 600,
    });
    Object.defineProperty(row, "clientWidth", {
      configurable: true,
      value: 300,
    });
    row.scrollLeft = scrollLeft;
    fireEvent.scroll(row);
  };
  size(0);
  expect(row.dataset.fadeEnd).toBe("");
  expect(row.dataset.fadeStart).toBeUndefined();
  size(150);
  expect(row.dataset.fadeEnd).toBe("");
  expect(row.dataset.fadeStart).toBe("");
  size(300);
  expect(row.dataset.fadeEnd).toBeUndefined();
  expect(row.dataset.fadeStart).toBe("");
  expect(css).toMatch(/\.topic-row\[data-fade-end\]/);
  expect(css).toMatch(/\.topic-row\[data-fade-start\]/);
});

function heading(phone: boolean) {
  stubMedia((query) => phone && query === "(width < 48rem)");
  return render(
    h(
      MemoryRouter,
      {},
      h(DayHeading, {
        feed: {
          day: "2026-11-17",
          status: "final",
          counts: counts(4, 3),
          items: [],
          nextCursor: null,
        } as never,
        base: "/app",
        search: null,
      }),
    ),
  );
}
it("#5 P12 counts the papers on your topics the same way everywhere", () => {
  heading(false);
  const line = screen.getByText(/papers on your topics/).parentElement!;
  expect(line.textContent).toBe(
    "3 papers on your topics · 4 in the listing · Final digest",
  );
  // Each phrase keeps its words together in a narrow column.
  for (const part of line.querySelectorAll("[data-slot=summary-part]"))
    expect(part.className).toContain("whitespace-nowrap");
  cleanup();
  heading(true);
  expect(screen.getByText(/papers on your topics/).textContent).toContain(
    "3 papers on your topics",
  );
  expect(screen.queryByText(/4 papers/)).toBeNull();
});

it("#14 a private day with no papers and no digest links to the last digest", async () => {
  stubMedia(() => false);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-25T04:00:00Z"));
  serve({
    day: "2026-11-21",
    items: [],
    status: "pending",
    days: [
      { day: "2026-11-21", status: "pending", counts: { total: 0 } },
      { day: "2026-11-20", status: "final", counts: { total: 40 } },
      { day: "2026-11-19", status: "final", counts: { total: 38 } },
    ],
  });
  mount("/app/days/2026-11-21", false);
  const reader = await screen.findByRole("region", { name: "Reader" });
  await within(reader).findByText("No papers or digest yet for this day.");
  const link = await within(reader).findByRole("link", {
    name: /^Read Friday,? 20 November$/,
  });
  expect(link.getAttribute("href")).toBe("/app/days/2026-11-20");
  vi.useRealTimers();
});

it("#14 public Today with no papers says so", async () => {
  stubMedia(() => false);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-21T04:00:00Z"));
  serve({ day: "2026-11-21", items: [], status: "pending" });
  mount("/public/today");
  const reader = await screen.findByRole("region", { name: "Selected paper" });
  await within(reader).findByText("No papers yet today.");
  expect(reader.textContent).not.toContain("Choose a paper");
  vi.useRealTimers();
});

it("P6 names the summary language", () => {
  render(h(PaperSummary, { paper: papers[0]! as never, language: "en" }));
  expect(screen.getByText(/Summary language: English\./)).toBeTruthy();
});

// Speed (performance audit, 21 Nov): moving between papers should not wait.
const paperCalls = (fetcher: ReturnType<typeof serve>, id: string) =>
  fetcher.mock.calls.filter(([url]) => String(url).includes(`/papers/${id}`))
    .length;

it("fetches the papers next to the open one ahead of time", async () => {
  const fetcher = serve();
  mount("/app/days/2026-11-17?paper=pap_b&paperSource=journal", false);
  await screen.findByRole("heading", { name: "Beta study" });
  await waitFor(() => {
    expect(paperCalls(fetcher, "pap_a")).toBe(1);
    expect(paperCalls(fetcher, "pap_c")).toBe(1);
  });
  // Moving to a neighbour paints from the cache: no second request.
  fireEvent.click(screen.getByRole("button", { name: "Next paper" }));
  expect(
    await screen.findByRole("heading", { name: "Gamma study" }),
  ).toBeTruthy();
  expect(paperCalls(fetcher, "pap_c")).toBe(1);
});

it("shows the row's title and summary while the full record loads", async () => {
  const fetcher = serve();
  const answer = fetcher.getMockImplementation()!;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  fetcher.mockImplementation(async (url: string, init?: RequestInit) => {
    if (String(url).includes("/papers/pap_c")) await held;
    return answer(url, init);
  });
  mount("/public/days/2026-11-17");
  fireEvent.click(await screen.findByRole("button", { name: /Gamma study/ }));
  const pane = await screen.findByRole("region", { name: "Selected paper" });
  // No bare spinner: what the list already knows shows at once.
  expect(
    await within(pane).findByRole("heading", { name: "Gamma study" }),
  ).toBeTruthy();
  expect(within(pane).getByText("TLDR text")).toBeTruthy();
  expect(within(pane).getByText("Loading the full record…")).toBeTruthy();
  expect(
    within(pane).queryByRole("region", { name: "Five-part summary" }),
  ).toBeNull();
  // It is the full view already, drawn from the row: the Back button, the
  // meta line, the title, the authors, the links the row can name and the
  // TL;DR in its box. The record fills in around them; nothing is replaced,
  // so nothing jumps.
  const parts = () => ({
    article: pane.querySelector("article")!,
    back: within(pane).getByRole("button", { name: /^Back to/ }),
    meta: pane.querySelector('[data-slot="paper-meta"]')!,
    title: within(pane).getByRole("heading", { name: "Gamma study" }),
    authors: pane.querySelector("header h2 + p")!,
    links: within(pane).getByRole("navigation", { name: "Paper links" }),
    tldr: within(pane).getByRole("heading", { name: "TL;DR" }),
  });
  const pending = parts();
  expect(pending.links.textContent).not.toContain("No open-access PDF");
  // The row names every author it has (up to twelve) and its links, so the
  // author line and the link buttons are already the final ones.
  const text = {
    authors: pending.authors.textContent,
    links: pending.links.textContent,
  };
  release();
  expect(
    await within(pane).findByRole("region", { name: "Five-part summary" }),
  ).toBeTruthy();
  expect(within(pane).queryByText("Loading the full record…")).toBeNull();
  // The same elements, not look-alikes mounted in their place.
  const full = parts();
  for (const key of [
    "article",
    "back",
    "meta",
    "title",
    "authors",
    "links",
  ] as const)
    expect(full[key], key).toBe(pending[key]);
  expect(full.tldr.parentElement!.className).toBe(
    pending.tldr.parentElement!.className,
  );
  expect({
    authors: full.authors.textContent,
    links: full.links.textContent,
  }).toEqual(text);
});

it("draws no visible title while a day loads: the day's own sits lower and would jump", async () => {
  const fetcher = serve();
  const answer = fetcher.getMockImplementation()!;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  fetcher.mockImplementation(async (url: string, init?: RequestInit) => {
    if (/\/days\/\d{4}-\d\d-\d\d(\?|$)/.test(String(url))) await held;
    return answer(url, init);
  });
  mount("/public/days/2026-11-17");
  const main = await screen.findByRole("main");
  expect(main.getAttribute("aria-busy")).toBe("true");
  expect(within(main).getByRole("heading", { level: 1 }).className).toContain(
    "sr-only",
  );
  expect(within(main).getByText("Loading papers…")).toBeTruthy();
  release();
  await screen.findByRole("button", { name: /Gamma study/ });
  expect(screen.getByRole("heading", { level: 1 }).className).not.toContain(
    "sr-only",
  );
});

it("fetches a neighbouring day when the pointer or focus reaches its link, but not a day after today", () => {
  const onIntent = vi.fn();
  stubMedia(() => false);
  const draw = (today: string) =>
    render(
      h(
        MemoryRouter,
        {},
        h(DayHeading, {
          feed: {
            day: "2026-11-17",
            status: "final",
            counts: counts(4, 3),
            items: [],
            nextCursor: null,
          } as never,
          base: "/app",
          search: null,
          today,
          onIntent,
        }),
      ),
    );
  draw("2026-11-20");
  fireEvent.pointerEnter(screen.getByRole("link", { name: "Previous day" }));
  expect(onIntent).toHaveBeenLastCalledWith("2026-11-16");
  fireEvent.focus(screen.getByRole("link", { name: "Next day" }));
  expect(onIntent).toHaveBeenLastCalledWith("2026-11-18");
  cleanup();
  onIntent.mockClear();
  // On today's page there is no later day to fetch.
  draw("2026-11-17");
  fireEvent.pointerEnter(screen.getByRole("link", { name: "Next day" }));
  expect(onIntent).not.toHaveBeenCalled();
});

it("asks for the brief while the feed is still loading", async () => {
  const fetcher = serve({ digest: null });
  const answer = fetcher.getMockImplementation()!;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  fetcher.mockImplementation(async (url: string, init?: RequestInit) => {
    if (/\/feed\/days\/\d{4}-\d\d-\d\d(\?|$)/.test(String(url))) await held;
    return answer(url, init);
  });
  mount("/app/days/2026-11-17", false);
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(([url]) => String(url).includes("/digest")),
    ).toBe(true),
  );
  expect(screen.queryByRole("region", { name: "Paper list" })).toBeNull();
  release();
  await screen.findByRole("region", { name: "Paper list" });
});

it("does not fetch ahead on the public feed", async () => {
  const fetcher = serve();
  mount("/public/days/2026-11-17?paper=pap_b&paperSource=journal");
  await screen.findByRole("link", { name: "Open full record" });
  expect(paperCalls(fetcher, "pap_a")).toBe(0);
  expect(paperCalls(fetcher, "pap_c")).toBe(0);
});

it("keeps focus on the phone's Next button at the last paper", async () => {
  stubMedia((query) => query === "(width < 48rem)");
  serve();
  mount("/public/days/2026-11-17?paper=pap_c&paperSource=arxiv");
  const next = await screen.findByRole("button", { name: "Next paper" });
  // Not the disabled attribute: a focused button that disables itself
  // would drop focus to the page.
  expect(next.getAttribute("aria-disabled")).toBe("true");
  expect((next as HTMLButtonElement).disabled).toBe(false);
  next.focus();
  fireEvent.click(next);
  expect(document.activeElement).toBe(next);
  expect(
    await screen.findByRole("heading", { name: "Gamma study" }),
  ).toBeTruthy();
});

it("checks a paper that is still waiting for its summary sooner", () => {
  expect(paperStaleTime({ summaries: [{}] })).toBe(5 * 60_000);
  expect(paperStaleTime({ summaries: [] })).toBe(30_000);
  expect(paperStaleTime(null)).toBe(30_000);
  expect(paperStaleTime(undefined)).toBe(30_000);
});
