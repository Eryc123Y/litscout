// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import {
  act,
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import {
  defaultScheduler,
  notifyManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { App } from "../src/App";
import { Markdown } from "../src/Markdown";
import { Paper } from "../src/Paper";
const paper = {
  paperId: "pap_a",
  title: "Stereo study",
  abstract: "Depth estimation",
  authors: [{ name: "Ada" }],
  source: "arxiv",
  topics: ["Vision"],
  shortlisted: true,
  summaries: [
    {
      lang: "en" as const,
      content: {
        tldr: "TLDR text",
        motivation: "Motivation text",
        method: "Method text",
        result: "Result text",
        conclusion: "Conclusion text",
      },
    },
  ],
  identifiers: [{ scheme: "arxiv", value: "2611.00001" }],
  links: [{ kind: "landing", url: "https://example.org" }],
  venue: null,
  venueKind: "preprint",
  year: 2026,
  publishedOn: null,
  categories: ["cs.CV"],
  hfUpvotes: 12,
};
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-17T04:00:00Z"));
});
beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  HTMLElement.prototype.scrollIntoView = vi.fn();
  Object.defineProperty(window, "matchMedia", {
    value: () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
/** When set, the first feed page is an empty filtered window with a
 * continuation, as the server returns for a sparse topic. */
let sparseFirstPage = false;
afterEach(() => {
  sparseFirstPage = false;
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});
function mount(
  path = "/app/today",
  publicFeed = true,
  keywordOnly = false,
  status = "final",
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const papers = [
        paper,
        {
          ...paper,
          paperId: "pap_b",
          title: "Language study",
          topics: ["Language"],
          source: "journal",
          venue: "JMLR",
          // It has a topic, so it is on the reader's topics, as in real data.
          shortlisted: true,
        },
      ];
      const parsed = new URL(url, "https://local");
      if (parsed.pathname.includes("/papers/")) {
        const id = decodeURIComponent(parsed.pathname.split("/").at(-1)!);
        const found = papers.find(
          (p) => p.paperId === id || p.identifiers.some((i) => i.value === id),
        );
        return found
          ? Response.json({ success: true, data: found })
          : Response.json({ success: false }, { status: 404 });
      }
      const data = url.endsWith("/instance")
        ? {
            name: "LitScout",
            publicFeed,
            keywordOnly,
            language: "en",
            timezone: "UTC",
            topics: ["Vision", "Language"],
          }
        : /\/digest(?:s\/|\?)/.test(url)
          ? {
              bodyMd: "## Radar\n\nNo new radar\n\n## Vision\n\nA pick",
              lang: "en",
              final: false,
            }
          : url.match(/days(?:\?|$)/)
            ? {
                items: [{ day: "2026-11-17", status, counts: { total: 2 } }],
                nextBefore: null,
              }
            : {
                day: "2026-11-17",
                status,
                counts: {
                  total: 2,
                  arxiv: 1,
                  venues: 1,
                  summarised: 2,
                  shortlisted: 2,
                  topics: { Vision: 1, Language: 1 },
                  sources: { arxiv: 1, journal: 1 },
                  venueCounts: { JMLR: 1 },
                },
                items: (sparseFirstPage && !parsed.searchParams.get("cursor")
                  ? []
                  : papers
                )
                  .filter(
                    (p) =>
                      (!parsed.searchParams.get("q") ||
                        p.title.includes(parsed.searchParams.get("q")!)) &&
                      (parsed.searchParams.get("shortlisted") !== "true" ||
                        p.shortlisted),
                  )
                  .map((p) => ({
                    ...p,
                    authorCount: p.authors.length,
                    tldr: p.summaries.map((s) => ({
                      lang: s.lang,
                      text: s.content.tldr,
                    })),
                  })),
                nextCursor:
                  sparseFirstPage && !parsed.searchParams.get("cursor")
                    ? "next-window"
                    : null,
              };
      return Response.json({ success: true, data });
    }),
  );
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
        createElement(App),
      ),
    ),
  );
}
it("loads today, filters, opens the reading pane and restores the list", async () => {
  mount();
  await screen.findByRole("button", { name: /Read Stereo study/ });
  fireEvent.click(screen.getByRole("radio", { name: /^Vision 1$/ }));
  expect(screen.queryByRole("button", { name: /Read Language/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Read Stereo/ }));
  await screen.findByRole("heading", { name: "Stereo study" });
  expect(document.activeElement?.textContent).toBe("Stereo study");
  fireEvent.click(screen.getByRole("button", { name: "Back to brief" }));
  await waitFor(() =>
    expect(screen.queryByRole("heading", { name: "Stereo study" })).toBeNull(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
  fireEvent.click(screen.getByRole("button", { name: "Search papers" }));
  fireEvent.change(screen.getByLabelText("Search titles and authors"), {
    target: { value: "Language" },
  });
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await screen.findByRole("button", { name: /Read Language/ });
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: /Read Stereo/ })).toBeNull(),
  );
});
it("shows sign-in landing when public feed is off", async () => {
  mount("/", false);
  await screen.findAllByRole("link", { name: "Sign in" });
  expect(screen.queryByText("Stereo study")).toBeNull();
});
it("renders days and paper routes, with missing-paper feedback", async () => {
  mount("/app/papers/missing?day=2026-11-17");
  await screen.findByText(/Paper not found/);
});
it("sanitises Markdown and drops non-http links and raw HTML", () => {
  const { container } = render(
    createElement(Markdown, {
      text: "<script>alert(1)</script>\n\n[bad](javascript:alert) [good](https://example.org) ![image](https://evil.example/track)",
    }),
  );
  expect(container.querySelectorAll("script,img,style")).toHaveLength(0);
  expect(container.querySelectorAll("a")).toHaveLength(1);
  expect(container.querySelector("a")?.getAttribute("rel")).toBe(
    "noopener noreferrer",
  );
});
it("escapes all paper text, supports legacy summary language and safe links", () => {
  const { container } = render(
    createElement(
      MemoryRouter,
      {},
      createElement(Paper, {
        paper: {
          ...paper,
          title: "<img src=x onerror=alert(1)>",
          links: [{ kind: "bad", url: "javascript:alert(1)" }],
          summaries: [{ ...paper.summaries[0]!, lang: "zh" }],
        },
      }),
    ),
  );
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
  // One PDF and one other link: alphaXiv when the paper is on arXiv.
  expect(screen.getByRole("link", { name: "Read PDF" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "alphaXiv" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: "arXiv page" })).toBeNull();
  expect(screen.getByText(/Summary language: Chinese/)).toBeTruthy();
});
it("Days calendar navigates months and opens a chosen date", async () => {
  mount("/app/days");
  await screen.findByRole("heading", { name: "Days" });
  fireEvent.click(
    await screen.findByRole("button", { name: "Previous month" }),
  );
  expect(
    screen.getByLabelText("Wednesday, 28 October 2026: Status not loaded"),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Next month" }));
  fireEvent.click(
    screen.getByLabelText("Monday, 16 November 2026: Status not loaded"),
  );
  await screen.findByRole("button", { name: /Read Stereo/ });
});
it("Settings switches appearance with one choice on its own page", async () => {
  mount();
  fireEvent.click(await screen.findByRole("link", { name: "Settings" }));
  await screen.findByRole("heading", { name: "Settings" });
  const group = within(screen.getByRole("radiogroup", { name: "Appearance" }));
  expect(
    (
      group.getByRole("radio", {
        name: "Follow the system",
      }) as HTMLInputElement
    ).checked,
  ).toBe(true);
  fireEvent.click(group.getByRole("radio", { name: "Dark" }));
  await waitFor(() =>
    expect(document.documentElement.dataset.theme).toBe("graphite"),
  );
  fireEvent.click(group.getByRole("radio", { name: "Light" }));
  await waitFor(() =>
    expect(document.documentElement.dataset.theme).toBe("journal"),
  );
  expect(screen.queryByLabelText("Dark theme")).toBeNull();
  expect(
    screen.getByRole("link", { name: "Settings" }).getAttribute("aria-current"),
  ).toBe("page");
});
it("source, venue and clearing controls change visible papers", async () => {
  mount();
  await screen.findByRole("button", { name: /Read Stereo/ });
  // Source, venue and unread live in the Filters popover. The list holds
  // only papers on the reader's topics, so there is no Shortlisted control.
  expect(screen.queryByRole("button", { name: "Shortlisted" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Filters" }));
  fireEvent.change(screen.getByLabelText("Source"), {
    target: { value: "journal" },
  });
  expect(screen.queryByRole("button", { name: /Read Stereo/ })).toBeNull();
  expect(screen.getByRole("button", { name: "Filters (1)" })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Venue"), {
    target: { value: "JMLR" },
  });
  expect(screen.getByRole("button", { name: /Read Language/ })).toBeTruthy();
  // Active filters show as chips; removing one undoes only that filter.
  fireEvent.click(
    screen.getByRole("button", { name: "Remove filter: Venue JMLR" }),
  );
  // The removed chip is gone, so focus moves to the Filters button.
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: /^Filters/ }),
  );
  expect(screen.getByRole("button", { name: /Read Language/ })).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Remove filter: Source journal" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
  expect(screen.getAllByRole("button", { name: /Read .*study/ })).toHaveLength(
    2,
  );
});
it("keeps reading past an empty filtered page instead of showing an empty list", async () => {
  sparseFirstPage = true;
  mount();
  // The first window held none of the papers; the next one does, and the
  // list loads it without a click on Load more.
  expect(
    await screen.findByRole("button", { name: /Read Stereo/ }),
  ).toBeTruthy();
  expect(screen.queryByText("No papers match these filters.")).toBeNull();
});
it("places the Filters popover under its button where anchor positioning is missing", async () => {
  mount();
  await screen.findByRole("button", { name: /Read Stereo/ });
  const trigger = screen.getByRole("button", { name: /^Filters/ });
  const panel = screen.getByRole("group", { name: "Filters" });
  trigger.getBoundingClientRect = () =>
    ({ bottom: 100, right: 400 }) as DOMRect;
  // Measured once open: the closed panel has no width.
  Object.defineProperty(panel, "offsetWidth", {
    configurable: true,
    get: () => (panel.dataset.open ? 288 : 0),
  });
  const toggle = (newState: "open" | "closed") => {
    panel.dataset.open = newState === "open" ? "1" : "";
    panel.dispatchEvent(Object.assign(new Event("toggle"), { newState }));
  };
  toggle("open");
  expect([panel.style.top, panel.style.left]).toEqual(["106px", "112px"]);
  // Phones use the bottom-sheet CSS, so the inline placement is cleared.
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("47.99rem"),
  }));
  toggle("open");
  expect([panel.style.top, panel.style.left]).toEqual(["", ""]);
});
it("public and full-paper routes never display private digest text", async () => {
  mount("/public/papers/pap_a?day=2026-11-17");
  await screen.findByRole("heading", { name: "Stereo study" });
  expect(screen.queryByRole("heading", { name: "Daily digest" })).toBeNull();
});
it("unknown routes and invalid dates are explained", async () => {
  mount("/app/days/not-a-day");
  await screen.findByRole("heading", { name: "Invalid date" });
  cleanup();
  mount("/missing");
  await screen.findByRole("heading", { name: "Page not found" });
});
it("old deep links retain selection in the redirected page", async () => {
  mount("/#day=2026-11-17&topic=Vision&paper=2611.00001");
  await screen.findByRole("heading", { name: "Stereo study" });
  expect(screen.queryByRole("heading", { name: "Daily digest" })).toBeNull();
});
it("Paper supports keyboard navigation, Escape and pending summaries", () => {
  const close = vi.fn(),
    move = vi.fn();
  const { container } = render(
    createElement(
      MemoryRouter,
      {},
      createElement(Paper, {
        paper: { ...paper, abstract: null, summaries: [] },
        close,
        onMove: move,
      }),
    ),
  );
  fireEvent.keyDown(container.querySelector("article")!, { key: "j" });
  fireEvent.keyDown(container.querySelector("article")!, { key: "k" });
  fireEvent.keyDown(container.querySelector("article")!, { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: "Next paper" }));
  fireEvent.click(screen.getByRole("button", { name: "Previous paper" }));
  expect(move.mock.calls).toEqual([[1], [-1], [1], [-1]]);
  expect(close).toHaveBeenCalledOnce();
  expect(screen.getByText("Abstract not available yet.")).toBeTruthy();
});
it("opens the PDF with o from the reader, but not while typing", () => {
  const open = vi.fn();
  vi.stubGlobal("open", open);
  const { container } = render(
    createElement(
      MemoryRouter,
      {},
      createElement(Paper, { paper, close: vi.fn(), onMove: vi.fn() }),
    ),
  );
  const pdf = screen.getByRole("link", { name: "Read PDF" });
  expect(pdf.getAttribute("aria-keyshortcuts")).toBe("o");
  expect(screen.getByText(/o to open the PDF/)).toBeTruthy();
  const article = container.querySelector("article")!;
  fireEvent.keyDown(article, { key: "o" });
  expect(open).toHaveBeenCalledWith(
    pdf.getAttribute("href"),
    "_blank",
    "noopener,noreferrer",
  );
  const field = document.createElement("input");
  article.appendChild(field);
  fireEvent.keyDown(field, { key: "o" });
  expect(open).toHaveBeenCalledOnce();
});
it("reads an arXiv PDF beside the summary on a wide screen", async () => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(width >= 80rem)",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: /Read Stereo/ }));
  await screen.findByRole("heading", { name: "Stereo study" });
  const list = () => document.querySelector(".reader-list-pane")!;
  // A plain click on Read PDF opens it beside the summary, scrolled into
  // view; the list steps aside.
  // (beforeAll stubs scrollIntoView for jsdom.)
  const scrollIntoView = vi.mocked(HTMLElement.prototype.scrollIntoView);
  scrollIntoView.mockClear();
  fireEvent.click(screen.getByRole("link", { name: "Read PDF" }));
  const panel = screen.getByRole("region", { name: "PDF" });
  expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
  expect(scrollIntoView.mock.contexts).toContain(panel);
  expect(
    within(panel).getByTitle("PDF: Stereo study").getAttribute("src"),
  ).toBe("https://arxiv.org/pdf/2611.00001");
  expect(
    within(panel)
      .getByRole("link", { name: "Open in new tab" })
      .getAttribute("target"),
  ).toBe("_blank");
  expect(list().hasAttribute("hidden")).toBe(true);
  // The PDF follows j to the next paper.
  fireEvent.keyDown(screen.getByRole("article", { name: "Stereo study" }), {
    key: "j",
  });
  await within(panel).findByTitle("PDF: Language study");
  // Escape closes the PDF first, then the reader.
  const article = screen.getByRole("article", { name: "Language study" });
  fireEvent.keyDown(article, { key: "Escape" });
  expect(screen.queryByRole("region", { name: "PDF" })).toBeNull();
  expect(list().hasAttribute("hidden")).toBe(false);
  expect(screen.getByRole("heading", { name: "Language study" })).toBeTruthy();
  // o opens it again; Close puts it away.
  fireEvent.keyDown(article, { key: "o" });
  fireEvent.click(
    within(screen.getByRole("region", { name: "PDF" })).getByRole("button", {
      name: "Close PDF",
    }),
  );
  expect(screen.queryByRole("region", { name: "PDF" })).toBeNull();
  // A modified click is left to the browser (a new tab).
  fireEvent.click(screen.getByRole("link", { name: "Read PDF" }), {
    metaKey: true,
  });
  expect(screen.queryByRole("region", { name: "PDF" })).toBeNull();
});
it("reads a day in two columns: the brief fills the reader until a paper opens", async () => {
  mount("/app/today", false);
  await screen.findByRole("button", { name: /Read Stereo/ });
  // No rail: the brief is the reader's first page, and the list offers it
  // as its first entry.
  expect(screen.queryByRole("complementary", { name: "This day" })).toBeNull();
  const reader = screen.getByRole("region", { name: "Reader" });
  expect(
    within(reader).getByRole("region", { name: "Morning brief" }),
  ).toBeTruthy();
  // The brief is always open in the reader: nothing to collapse.
  expect(
    within(reader).queryByRole("button", { name: /Collapse|Expand/ }),
  ).toBeNull();
  const entry = screen.getByRole("button", { name: /^Morning brief/ });
  expect(entry.getAttribute("aria-current")).toBe("true");
  expect(screen.getAllByRole("radiogroup", { name: "Topics" })).toHaveLength(1);
  expect(
    screen.getByRole("separator", { name: "Resize the paper list" }),
  ).toBeTruthy();
  // A paper takes the reader's place; the list and its topics stay put.
  fireEvent.click(screen.getByRole("button", { name: /Read Stereo/ }));
  await screen.findByRole("heading", { name: "Stereo study" });
  expect(screen.queryByRole("region", { name: "Reader" })).toBeNull();
  expect(entry.getAttribute("aria-current")).toBeNull();
  expect(
    screen
      .getByRole("button", { name: /Read Stereo/ })
      .getAttribute("aria-current"),
  ).toBe("true");
  expect(screen.getAllByRole("radiogroup", { name: "Topics" })).toHaveLength(1);
  // Back to brief (or the list's brief entry) brings the brief back, and
  // the list stays where it was (no jump up to the brief entry).
  const scrolled = vi.fn();
  Element.prototype.scrollIntoView = scrolled;
  fireEvent.click(screen.getByRole("button", { name: "Back to brief" }));
  await screen.findByRole("region", { name: "Reader" });
  expect(scrolled).not.toHaveBeenCalled();
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  fireEvent.click(screen.getByRole("button", { name: /Read Stereo/ }));
  await screen.findByRole("heading", { name: "Stereo study" });
  fireEvent.click(screen.getByRole("button", { name: /^Morning brief/ }));
  await screen.findByRole("region", { name: "Reader" });
});
it("forgets an open PDF when the reader closes", async () => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(width >= 80rem)",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: /Read Stereo/ }));
  await screen.findByRole("heading", { name: "Stereo study" });
  fireEvent.click(screen.getByRole("link", { name: "Read PDF" }));
  expect(screen.getByRole("region", { name: "PDF" })).toBeTruthy();
  // The list steps aside for the PDF; closing the paper brings it back.
  expect(screen.queryByRole("separator")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Back to brief" }));
  await waitFor(() =>
    expect(screen.queryByRole("region", { name: "PDF" })).toBeNull(),
  );
  // Opening a paper again shows its summary, not the old PDF.
  fireEvent.click(await screen.findByRole("button", { name: /Read Stereo/ }));
  await screen.findByRole("heading", { name: "Stereo study" });
  expect(screen.queryByRole("region", { name: "PDF" })).toBeNull();
});
it("returns focus and selects the adjacent visible paper", async () => {
  mount();
  await screen.findByRole("button", { name: /Read Stereo/ });
  fireEvent.click(screen.getByRole("button", { name: /Read Stereo/ }));
  await screen.findByRole("heading", { name: "Stereo study" });
  fireEvent.click(screen.getByRole("button", { name: "Next paper" }));
  await screen.findByRole("heading", { name: "Language study" });
  fireEvent.click(screen.getByRole("button", { name: "Previous paper" }));
  await screen.findByRole("heading", { name: "Stereo study" });
});
it("a failed feed can be retried without an empty page", async () => {
  mount();
  await screen.findByRole("button", { name: /Read Stereo/ });
  cleanup();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        { success: false, error: { message: "Temporary failure" } },
        { status: 503 },
      ),
    ),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(MemoryRouter, {}, createElement(App)),
    ),
  );
  await screen.findByRole("heading", { name: "Feed unavailable" });
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(screen.getByText("Temporary failure")).toBeTruthy();
});
it("opens the search command with the keyboard and emits no style elements", async () => {
  mount();
  await screen.findByRole("button", { name: "Search papers" });
  fireEvent.keyDown(document, { key: "k", metaKey: true });
  await screen.findByRole("dialog", { name: "Search papers" });
  expect(document.querySelector("style")).toBeNull();
  expect(document.querySelector('[role="dialog"] h2')).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Search papers" }),
    ),
  );
});

it("P1 renders the sign-in landing from only the generic instance name", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ success: true, data: { name: "LitScout" } }),
    ),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        { initialEntries: ["/"] },
        createElement(App),
      ),
    ),
  );
  await screen.findAllByRole("link", { name: "Sign in" });
  expect(screen.queryByText("Vision")).toBeNull();
  expect(screen.queryByRole("button", { name: /Read / })).toBeNull();
});

it("selects a paper from the command results and focuses the reading pane", async () => {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Search papers" }));
  fireEvent.click(await screen.findByRole("option", { name: /Stereo study/ }));
  await screen.findByRole("heading", { name: "Stereo study" });
  await waitFor(() =>
    expect(document.activeElement?.textContent).toBe("Stereo study"),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("omits unbuilt suggestion and paper actions from Today", async () => {
  mount("/app/today");
  await screen.findByRole("heading", { name: "Morning brief" });
  expect(
    // "Saved" in the filters is a decision filter, not a paper action.
    screen.queryByRole("button", {
      name: /accept|dismiss|capture|\bsave\b|rate/i,
    }),
  ).toBeNull();
});

it("opens an undated record without inventing a listing date in the breadcrumb", async () => {
  mount("/app/papers/pap_a");
  await screen.findByRole("heading", { name: "Stereo study" });
  expect(
    screen.getByRole("navigation", { name: "Breadcrumb" }).textContent,
  ).toBe("Today/Paper");
});

it("V6 closing a paper selected from the palette focuses the list instead of the previous opener", async () => {
  mount();
  fireEvent.click(
    await screen.findByRole("button", { name: /Read Stereo study/ }),
  );
  await screen.findByRole("heading", { name: "Stereo study" });
  fireEvent.click(screen.getByRole("button", { name: "Back to brief" }));
  fireEvent.click(screen.getByRole("button", { name: "Search papers" }));
  fireEvent.click(
    await screen.findByRole("option", { name: /Language study/ }),
  );
  await screen.findByRole("heading", { name: "Language study" });
  fireEvent.click(screen.getByRole("button", { name: "Back to brief" }));
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("region", { name: "Paper list" }),
    ),
  );
});
it("V6 closing a URL-selected paper focuses the list", async () => {
  mount("/app/today?paper=pap_a&paperSource=arxiv");
  await screen.findByRole("heading", { name: "Stereo study" });
  fireEvent.click(screen.getByRole("button", { name: "Back to brief" }));
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("region", { name: "Paper list" }),
    ),
  );
});

it("V7 a legacy-link replacement retains initial focus", async () => {
  // Flush the instance, feed and paper updates with React instead of
  // depending on how quickly the test worker services timers.
  notifyManager.setScheduler(queueMicrotask);
  try {
    mount("/#day=2026-11-17&topic=Vision&paper=2611.00001");
    const skipLink = screen.getByRole("link", { name: "Skip to content" });
    await act(async () => {
      skipLink.focus();
      expect(document.activeElement).toBe(skipLink);
    });
    const reader = screen.getByRole("region", { name: "Selected paper" });
    expect(
      within(reader).getByRole("heading", { name: "Stereo study" }),
    ).toBeTruthy();
    expect(document.activeElement).toBe(skipLink);
    expect(skipLink.getAttribute("href")).toBe("#main");
  } finally {
    notifyManager.setScheduler(defaultScheduler);
  }
});

it("Days has one matching heading, its page h1", async () => {
  mount("/app/days");
  await screen.findByRole("heading", { name: /^Days$/, level: 1 });
  expect(screen.getAllByRole("heading", { name: /days/i })).toHaveLength(1);
});

it.each(["/app/today", "/public/today"])(
  "shows abstracts without summary or digest chrome in keyword mode on %s",
  async (path) => {
    mount(path, true, true);
    const row = await screen.findByRole("button", {
      name: /Read Stereo study/,
    });
    expect(row.textContent).toContain("Depth estimation");
    expect(row.textContent).not.toContain("TLDR text");
    fireEvent.click(row);
    expect(
      await screen.findByRole("heading", { name: "Stereo study" }),
    ).toBeTruthy();
    expect(screen.queryByText("TLDR text")).toBeNull();
    expect(screen.queryByText("Summary pending")).toBeNull();
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([url]) => String(url).includes("/digest?")),
    ).toBe(false);
  },
);

it.each([
  [true, "Keyword list"],
  [false, "Summaries in progress"],
])(
  "labels crawled days when keyword mode is %s",
  async (keywordOnly, label) => {
    mount("/app/today", true, keywordOnly, "crawled");
    await waitFor(() =>
      expect(
        within(screen.getByRole("main")).getByText(new RegExp(label)),
      ).toBeTruthy(),
    );
    // The day's status lives in the page header; the sidebar no longer repeats it.
    expect(screen.queryByText("Abstract-based summaries")).toBeNull();

    fireEvent.click(screen.getByRole("link", { name: "Days" }));
    // Query the page's main each time: it changes when the route does.
    // (The calendar's legend is a list too: take the day's own row.)
    const archive = await waitFor(() =>
      within(screen.getByRole("main"))
        .getByRole("link", { name: "17 Nov 2026" })
        .closest("li")!,
    );
    expect(within(archive).getByText(label)).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: `Tuesday, 17 November 2026: ${label}`,
      }),
    ).toBeTruthy();
  },
);

it("keeps the stored list width when the window grows from phone size", async () => {
  localStorage.setItem("litscout.listWidth", "520");
  const listeners = new Set<() => void>();
  let phone = true;
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return query === "(width < 48rem)" ? phone : false;
    },
    addEventListener: (_: string, listener: () => void) =>
      listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) =>
      listeners.delete(listener),
  }));
  mount("/app/today", false);
  await screen.findByRole("button", { name: /Read Stereo/ });
  expect(screen.queryByRole("separator")).toBeNull();
  phone = false;
  act(() => listeners.forEach((listener) => listener()));
  await screen.findByRole("separator", { name: "Resize the paper list" });
  const main = document.querySelector<HTMLElement>(".reader-split")!;
  expect(main.style.getPropertyValue("--list-width")).toBe("520px");
  localStorage.removeItem("litscout.listWidth");
});
