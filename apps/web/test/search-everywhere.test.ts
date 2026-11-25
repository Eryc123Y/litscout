// @vitest-environment jsdom
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { ListPaper } from "@litscout/pipeline/read-contracts";
import { AppShell } from "../src/AppShell";
import { SearchPapers } from "../src/SearchPapers";

beforeAll(() => {
  // cmdk measures its list; jsdom has no layout.
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
// The search box sits in the top bar of every signed-in page and finds
// papers from every day; on a day page that day's papers come first.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const json = (data: unknown) => Response.json({ success: true, data });
const hits = [
  {
    paperId: "pap_here",
    title: "Stereo here",
    authors: [{ name: "Ada" }],
    authorCount: 1,
    day: "2026-11-17",
    source: "arxiv",
    venue: null,
  },
  {
    paperId: "pap_older",
    title: "Stereo older",
    authors: [{ name: "Bo" }],
    authorCount: 1,
    day: "2026-11-10",
    source: "journal",
    venue: "IEEE TPAMI",
  },
  {
    paperId: "pap_saved",
    title: "Stereo saved only",
    authors: [],
    authorCount: 0,
    day: null,
    source: null,
    venue: "ICLR",
  },
];
function serve() {
  const fetcher = vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url);
    if (path.includes("/search?")) return json({ items: hits });
    return json({
      day: "2026-11-17",
      status: "final",
      counts: { total: 0, sources: {} },
    });
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
const searches = (fetcher: ReturnType<typeof serve>) =>
  fetcher.mock.calls
    .map(([url]) => String(url))
    .filter((url) => url.includes("/search?"));
function Where() {
  const at = useLocation();
  return createElement(
    "output",
    { "aria-label": "Location" },
    at.pathname + at.search,
  );
}
function mount(node: React.ReactNode, path: string) {
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
        createElement(Where),
      ),
    ),
  );
}
const shell = (isPublic: boolean, child = "Library", topVenues?: string[]) =>
  createElement(AppShell, {
    theme: "journal",
    onAppearance: () => {},
    isPublic,
    instance: {
      name: "LitScout",
      publicFeed: true,
      language: "en",
      timezone: "UTC",
      topics: [],
      topVenues,
    },
    children: createElement("main", {}, child),
  });
// The search input (the Type filter beside it is a combobox too).
const searchInput = () => screen.getByPlaceholderText(/\(3\+ characters\)$/);
const type = (value: string) =>
  fireEvent.change(searchInput(), { target: { value } });

it("puts the search box in the top bar of a page that is not a day, and finds papers from every day", async () => {
  const fetcher = serve();
  mount(shell(false), "/app/library");
  const bar = document.querySelector<HTMLElement>(
    'header[aria-label="Top bar"]',
  )!;
  const trigger = within(bar).getByRole("button", { name: "Search papers" });
  expect(trigger.getAttribute("aria-keyshortcuts")).toContain("Meta+k");
  // ⌘K opens it here too.
  fireEvent.keyDown(document, { key: "k", metaKey: true });
  const dialog = await screen.findByRole("dialog", { name: "Search papers" });
  expect(searches(fetcher)).toHaveLength(0);
  type("ste");
  const older = await within(dialog).findByRole("option", {
    name: /Stereo older/,
  });
  expect(searches(fetcher)).toEqual(["/api/v1/search?q=ste"]);
  expect(older.textContent).toContain("10 Nov 2026");
  expect(within(dialog).getByRole("group", { name: "All days" })).toBeTruthy();
  // A paper opens on the day it was listed, in the reader.
  fireEvent.click(older);
  await waitFor(() =>
    expect(screen.getByLabelText("Location").textContent).toBe(
      "/app/days/2026-11-10?paper=pap_older&paperSource=journal",
    ),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("opens a paper that was never listed on its own page", async () => {
  serve();
  mount(shell(false), "/app/trends");
  fireEvent.click(screen.getByRole("button", { name: "Search papers" }));
  type("stereo");
  fireEvent.click(
    await screen.findByRole("option", { name: /Stereo saved only/ }),
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Location").textContent).toBe(
      "/app/papers/pap_saved",
    ),
  );
});

it("leaves the top bar to the day page on a day, and has no search on public pages", () => {
  serve();
  mount(shell(false, "Today"), "/app/days/2026-11-17");
  // The day page puts its own search there (Feed), with that day first.
  expect(screen.queryByRole("button", { name: "Search papers" })).toBeNull();
  cleanup();
  mount(shell(true, "Days"), "/public/days");
  expect(screen.queryByRole("button", { name: "Search papers" })).toBeNull();
});

it("on a day page, lists that day's papers first and leaves them out of the other days", async () => {
  const fetcher = serve();
  const here = {
    paperId: "pap_here",
    source: "arxiv",
    title: "Stereo here",
  } as ListPaper;
  mount(
    createElement(SearchPapers, {
      q: "stereo",
      papers: [here],
      onSearch: vi.fn(),
      onOpen: vi.fn(),
      searching: false,
      everyDay: true,
      day: "2026-11-17",
    }),
    "/app/days/2026-11-17?q=stereo",
  );
  fireEvent.click(screen.getByRole("button", { name: /Search papers/ }));
  const dialog = await screen.findByRole("dialog", { name: "Search papers" });
  await within(dialog).findByRole("option", { name: /Stereo older/ });
  const day = within(dialog).getByRole("group", { name: "This day's papers" });
  const others = within(dialog).getByRole("group", { name: "Other days" });
  // The day's own papers come first.
  expect(
    day.compareDocumentPosition(others) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  const other = within(others);
  expect(other.queryByRole("option", { name: /Stereo here/ })).toBeNull();
  expect(other.getByRole("option", { name: /Stereo older/ })).toBeTruthy();
  expect(searches(fetcher)).toEqual(["/api/v1/search?q=stereo"]);
});

it("searches only the day on a public day page", async () => {
  const fetcher = serve();
  mount(
    createElement(SearchPapers, {
      q: "stereo",
      papers: [],
      onSearch: vi.fn(),
      onOpen: vi.fn(),
      searching: false,
    }),
    "/public/days/2026-11-17?q=stereo",
  );
  fireEvent.click(screen.getByRole("button", { name: /Search papers/ }));
  await screen.findByRole("dialog", { name: "Search papers" });
  type("stereos");
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(searches(fetcher)).toHaveLength(0);
  expect(screen.queryByRole("group", { name: "Other days" })).toBeNull();
});

it("filters every day's results by type and top venues, and names each hit's venue", async () => {
  const fetcher = serve();
  mount(shell(false, "Library", ["ICLR", "IEEE TPAMI"]), "/app/library");
  fireEvent.click(screen.getByRole("button", { name: "Search papers" }));
  const dialog = within(
    await screen.findByRole("dialog", { name: "Search papers" }),
  );
  // The input keeps the first focus; the filters sit between it and the list.
  const input = searchInput();
  expect(input.getAttribute("role")).toBe("combobox");
  await waitFor(() => expect(document.activeElement).toBe(input));
  const filters = within(dialog.getByRole("group", { name: "Search filters" }));
  const kind = filters.getByLabelText("Type");
  expect(
    input.compareDocumentPosition(kind) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    Array.from(kind.querySelectorAll("option"), (o) => o.textContent),
  ).toEqual(["All types", "Preprints", "Conference papers", "Journal papers"]);
  type("ste");
  const older = await dialog.findByRole("option", { name: /Stereo older/ });
  // The venue sits next to the day it was listed.
  expect(older.textContent).toContain("IEEE TPAMI");
  expect(older.textContent).toContain("10 Nov 2026");
  expect(
    dialog.getByRole("option", { name: /Stereo saved only/ }).textContent,
  ).toContain("ICLR");
  fireEvent.change(kind, { target: { value: "journal" } });
  await waitFor(() =>
    expect(searches(fetcher).at(-1)).toBe("/api/v1/search?q=ste&kind=journal"),
  );
  const topOnly = filters.getByRole("button", { name: "Top venues" });
  expect(topOnly.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(topOnly);
  await waitFor(() =>
    expect(searches(fetcher).at(-1)).toBe(
      "/api/v1/search?q=ste&kind=journal&top=true",
    ),
  );
  expect(topOnly.getAttribute("aria-pressed")).toBe("true");
  // The list's keys stay with the filters while they have focus: Enter and
  // the arrows reach the select and the toggle, not the results.
  for (const key of ["Enter", "ArrowDown", "ArrowUp", "Home", "End"]) {
    expect(fireEvent.keyDown(kind, { key })).toBe(true);
    expect(fireEvent.keyDown(topOnly, { key })).toBe(true);
  }
  expect(screen.getByLabelText("Location").textContent).toBe("/app/library");
});

it("leaves out the Top venues toggle when the instance lists none, and has no filters for a public day", async () => {
  serve();
  mount(shell(false), "/app/library");
  fireEvent.click(screen.getByRole("button", { name: "Search papers" }));
  const dialog = within(
    await screen.findByRole("dialog", { name: "Search papers" }),
  );
  const filters = within(dialog.getByRole("group", { name: "Search filters" }));
  expect(filters.getByLabelText("Type")).toBeTruthy();
  expect(filters.queryByRole("button", { name: "Top venues" })).toBeNull();
  cleanup();
  mount(
    createElement(SearchPapers, {
      q: "",
      papers: [],
      onSearch: vi.fn(),
      onOpen: vi.fn(),
      searching: false,
      topVenues: ["ICLR"],
    }),
    "/public/days/2026-11-17",
  );
  fireEvent.click(screen.getByRole("button", { name: /Search papers/ }));
  await screen.findByRole("dialog", { name: "Search papers" });
  expect(screen.queryByLabelText("Type")).toBeNull();
  expect(screen.queryByRole("button", { name: "Top venues" })).toBeNull();
});

it("on a day page, filters only the other days and leaves the day's own list alone", async () => {
  const fetcher = serve();
  const onSearch = vi.fn();
  const here = {
    paperId: "pap_here",
    source: "arxiv",
    title: "Stereo here",
  } as ListPaper;
  mount(
    createElement(SearchPapers, {
      q: "stereo",
      papers: [here],
      onSearch,
      onOpen: vi.fn(),
      searching: false,
      everyDay: true,
      day: "2026-11-17",
      topVenues: ["IEEE TPAMI"],
    }),
    "/app/days/2026-11-17?q=stereo",
  );
  fireEvent.click(screen.getByRole("button", { name: /Search papers/ }));
  const dialog = within(
    await screen.findByRole("dialog", { name: "Search papers" }),
  );
  const filters = within(
    dialog.getByRole("group", { name: "Filters for other days" }),
  );
  fireEvent.click(filters.getByRole("button", { name: "Top venues" }));
  await waitFor(() =>
    expect(searches(fetcher).at(-1)).toBe("/api/v1/search?q=stereo&top=true"),
  );
  expect(
    within(dialog.getByRole("group", { name: "This day's papers" })).getByRole(
      "option",
      { name: /Stereo here/ },
    ),
  ).toBeTruthy();
  expect(onSearch).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Location").textContent).toBe(
    "/app/days/2026-11-17?q=stereo",
  );
});
