// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { App } from "../src/App";

const paperId = "pap_one";
const title = "A paper from the library";
const item = {
  paperId,
  title,
  authors: [{ name: "Ada Smith" }],
  status: "saved",
  tags: ["vision"],
  addedVia: "web",
  addedAt: "2026-11-18T00:00:00Z",
  updatedAt: "2026-11-18T00:00:00Z",
  deletedAt: null,
  rev: 1,
  origin: ["litscout"],
  year: 2026,
  venue: "TOG",
  readAt: null,
  link: { kind: "doi", url: "https://doi.org/10.1000/paper" },
};
const paper = {
  paperId,
  title,
  authors: [{ name: "Ada Smith" }],
  source: "crossref",
  topics: [],
  shortlisted: false,
  venue: "TOG",
  venueKind: "journal",
  year: 2026,
  publishedOn: null,
  categories: [],
  hfUpvotes: null,
  identifiers: [{ scheme: "doi", value: "10.1000/paper" }],
  abstract: null,
  links: [],
  summaries: [],
};
const counters = {
  total: 1,
  summarised: 0,
  shortlisted: 0,
  arxiv: 0,
  venues: 1,
  topics: {},
  sources: {},
  venueCounts: {},
};
function harness(
  path: string,
  unverified = false,
  libraryPage?: unknown,
  instance: Record<string, unknown> = {},
) {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  let saved = false;
  const state = {
    paperId,
    readAt: null as string | null,
    rating: "none",
    starred: false,
    readLater: false,
    libraryRev: null as number | null,
  };
  let notes: {
    id: string;
    targetId: string;
    bodyMd: string;
    origin: string;
    rev: number;
    createdAt: string;
    updatedAt: string;
    client?: string;
  }[] = unverified
    ? [
        {
          id: "note_fixture",
          targetId: paperId,
          bodyMd: "Agent note",
          origin: "mcp",
          client: "Test client (unverified)",
          rev: 1,
          createdAt: item.addedAt,
          updatedAt: item.updatedAt,
        },
      ]
    : [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const dest = new URL(url, "https://local.example");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    let data: unknown;
    if (dest.pathname.endsWith("/instance"))
      data = {
        name: "LitScout",
        publicFeed: true,
        language: "en",
        timezone: "Asia/Kuala_Lumpur",
        topics: [],
        ...instance,
      };
    else if (dest.pathname.endsWith("/library/save")) {
      if (!body.dry_run) saved = true;
      data = body.dry_run
        ? {
            status: "confirm",
            candidates: [
              {
                query: "10.1000/paper",
                title: "Matched work",
                verified: !unverified,
                authors: ["Ada Smith"],
                source: "crossref",
                link: item.link,
              },
            ],
          }
        : { status: "saved", item, paperId };
    } else if (dest.pathname.endsWith("/library") && method === "GET")
      data =
        typeof libraryPage === "function"
          ? libraryPage(dest)
          : (libraryPage ?? {
              items: saved ? [{ ...item, verified: !unverified }] : [],
              nextCursor: null,
            });
    else if (dest.pathname.endsWith("/library") && method === "POST") {
      saved = true;
      state.libraryRev = 1;
      data = item;
    } else if (dest.pathname.endsWith("/state"))
      data = { items: [{ ...state }], nextCursor: null };
    else if (dest.pathname.includes("/papers/"))
      data = { ...paper, verified: !unverified };
    else if (dest.pathname.endsWith("/events")) {
      if (body.kind === "open") state.readAt = "2026-11-18T01:00:00Z";
      if (body.kind === "star") state.starred = true;
      if (body.kind === "rate_up") state.rating = "up";
      if (body.kind === "rate_clear") state.rating = "none";
      data = { ...state };
    } else if (dest.pathname.includes("/notes")) {
      if (method === "GET") data = { items: [...notes], nextCursor: null };
      else if (method === "POST") {
        const note = {
          id: "note_one",
          targetId: paperId,
          bodyMd: body.bodyMd,
          origin: "web",
          rev: 1,
          createdAt: item.addedAt,
          updatedAt: item.updatedAt,
        };
        notes = [note];
        data = note;
      } else if (method === "PATCH") {
        const note = { ...notes[0]!, bodyMd: body.bodyMd, rev: 2 };
        notes = [note];
        data = note;
      } else {
        data = notes[0];
        notes = [];
      }
    } else
      data = {
        counts: counters,
        status: "final",
        day: "2026-11-18",
        nextCursor: null,
        items: [
          {
            ...paper,
            authorCount: 1,
            tldr: [],
            readingState: { readAt: state.readAt },
          },
        ],
      };
    return Response.json({ success: true, data });
  });
  vi.stubGlobal("fetch", fetcher);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        { initialEntries: [path] },
        createElement(
          Routes,
          {},
          createElement(Route, { path: "*", element: createElement(App) }),
        ),
      ),
    ),
  );
  return fetcher;
}
afterEach(cleanup);

it("previews, dismisses, confirms and filters a match with a DOI-only link", async () => {
  const fetcher = harness("/app/library");
  await screen.findByRole("heading", { name: "Library" });
  // Adding a paper happens in a dialog opened from the page header.
  fireEvent.click(screen.getByRole("button", { name: "Add paper" }));
  const add = within(
    await screen.findByRole("dialog", { name: "Add a paper" }),
  );
  fireEvent.change(add.getByLabelText("DOI, URL, arXiv ID or title"), {
    target: { value: "Vision paper" },
  });
  fireEvent.click(add.getByRole("button", { name: "Find" }));
  await add.findByText("Matched work");
  fireEvent.click(add.getByRole("button", { name: "Not this one" }));
  expect(add.queryByText("Matched work")).toBeNull();
  fireEvent.click(add.getByRole("button", { name: "Find" }));
  await add.findByText("Matched work");
  fireEvent.click(add.getByRole("button", { name: "Add to library" }));
  // Saving closes the dialog and the paper appears in the list.
  await screen.findByRole("link", { name: title });
  expect(screen.getByText(/^Saved .* to your library\.$/)).toBeTruthy();
  expect(
    screen.getByRole("link", { name: "Publisher page" }).getAttribute("href"),
  ).toBe(item.link.url);
  // Search stays visible and applies on Enter.
  fireEvent.change(screen.getByLabelText("Search title or author"), {
    target: { value: "Ada" },
  });
  fireEvent.submit(screen.getByRole("search", { name: "Search the library" }));
  await waitFor(() =>
    expect(fetcher.mock.calls.some(([url]) => url.includes("q=Ada"))).toBe(
      true,
    ),
  );
});

it("opens a saved-only paper and updates its state and sanitised notes", async () => {
  const fetcher = harness("/app/papers/pap_one");
  await screen.findByRole("heading", { name: title });
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(([, init]) =>
        String(init?.body).includes('"open"'),
      ),
    ).toBe(true),
  );
  await within(screen.getByRole("main")).findByText("Read");
  // The four reading actions are icon toggles in one toolbar; their names
  // stay the same and aria-pressed carries the state.
  const toolbar = within(
    screen.getByRole("toolbar", { name: "Reading actions" }),
  );
  expect(
    toolbar.getAllByRole("button").map((b) => b.getAttribute("aria-label")),
  ).toEqual([
    "Save to library",
    "To read",
    "Skip",
    "Star",
    "Rate up",
    "Rate down",
  ]);
  // Each icon shows its name as a tooltip on hover and focus.
  expect(
    toolbar.getByText("Star", { selector: "[data-slot=tooltip]" }),
  ).toBeTruthy();
  const pressed = (name: string) =>
    screen.getByRole("button", { name }).getAttribute("aria-pressed");
  fireEvent.click(screen.getByRole("button", { name: "Save to library" }));
  await waitFor(() => expect(pressed("Save to library")).toBe("true"));
  fireEvent.click(screen.getByRole("button", { name: "Star" }));
  await waitFor(() => expect(pressed("Star")).toBe("true"));
  fireEvent.click(screen.getByRole("button", { name: "Rate up" }));
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Rate up" })
        .getAttribute("aria-pressed"),
    ).toBe("true"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Add note" }));
  fireEvent.change(screen.getByLabelText("Note (Markdown)"), {
    target: {
      value:
        "**Useful**\n\n<script>bad()</script>\n\n[unsafe](javascript:alert)",
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save note" }));
  expect((await screen.findByText("Useful")).tagName).toBe("STRONG");
  expect(screen.queryByRole("link", { name: "unsafe" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
  fireEvent.change(screen.getByLabelText("Note (Markdown)"), {
    target: { value: "Changed note" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save note" }));
  await screen.findByText("Changed note");
  fireEvent.click(screen.getByRole("button", { name: "Delete note" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
  await waitFor(() => expect(screen.queryByText("Changed note")).toBeNull());
});

it("keeps actions and private requests off a public Paper page", async () => {
  const fetcher = harness("/public/papers/pap_one");
  await screen.findByRole("heading", { name: title });
  expect(screen.queryByRole("link", { name: "Library" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "Quick notes" })).toBeNull();
  expect(
    fetcher.mock.calls.every(([url]) => /\/instance$|\/public\//.test(url)),
  ).toBe(true);
});

it("marks the list row read when a private reading pane opens", async () => {
  const fetcher = harness("/app/days/2026-11-18");
  const row = await screen.findByRole("button", {
    name: new RegExp("Read " + title),
  });
  expect(row.getAttribute("aria-description")).toBe("Unread");
  fireEvent.click(row);
  await screen.findByRole("heading", { name: "Quick notes" });
  await waitFor(() =>
    expect(row.getAttribute("aria-description")).toBe("Read"),
  );
  // The open row stays at full ink; the fade shows once another row opens.
  expect(row.hasAttribute("data-read")).toBe(true);
  expect(row.querySelector('[data-slot="read-mark"]')).toBeNull();
  expect(
    fetcher.mock.calls.find(([, init]) =>
      String(init?.body).includes('"open"'),
    )?.[1]?.body,
  ).toContain('"feed"');
});

it("shows an unverified metadata notice in the match, saved row and paper, with labelled MCP notes", async () => {
  harness("/app/library", true);
  await screen.findByRole("heading", { name: "Library" });
  fireEvent.click(screen.getByRole("button", { name: "Add paper" }));
  const add = within(
    await screen.findByRole("dialog", { name: "Add a paper" }),
  );
  fireEvent.change(add.getByLabelText("DOI, URL, arXiv ID or title"), {
    target: { value: "Fixture paper" },
  });
  fireEvent.click(add.getByRole("button", { name: "Find" }));
  const notice = "From page metadata, not verified";
  await add.findByText(notice);
  fireEvent.click(add.getByRole("button", { name: "Add to library" }));
  const result = await screen.findByRole("link", { name: title });
  expect(screen.getByText(notice)).toBeTruthy();
  expect(screen.getByRole("columnheader", { name: "Where" })).toBeTruthy();
  fireEvent.click(result);
  // The paper opens in the side panel; the row stays beside it.
  const panel = await screen.findByRole("complementary", {
    name: "Paper: " + title,
  });
  expect(within(panel).getByRole("heading", { name: title })).toBeTruthy();
  expect(within(panel).getByText(notice)).toBeTruthy();
  // Beside the panel the table keeps what fits: the paper, its status and
  // its link. Venue and origin are in the panel.
  expect(screen.queryByRole("columnheader", { name: "Where" })).toBeNull();
  expect(screen.queryByRole("columnheader", { name: "Origin" })).toBeNull();
  expect(screen.getByRole("columnheader", { name: "Status" })).toBeTruthy();
  expect(await screen.findByText("Test client (unverified)")).toBeTruthy();
});

it("shows merged origins, nested alphaXiv folders and notes, and filters without exposing private metadata", async () => {
  const folder = {
    id: "10000000-0000-4000-8000-000000000001",
    path: "FYP · Stereo Conversion / Depth & Geometry",
  };
  const syncedAt = "2026-11-18T10:00:00.000Z";
  const alphaUrl = "https://www.alphaxiv.org/abs/2611.00001";
  const privateUrl = "https://www.alphaxiv.org/private/upload_7";
  const mirror = {
    url: alphaUrl,
    folders: [folder],
    status: "read",
    hasNotes: true,
    highlightCount: 2,
  };
  const fetcher = harness("/app/library", false, {
    nextCursor: null,
    alphaXiv: { syncedAt, folders: [folder] },
    items: [
      { ...item, origin: ["litscout", "alphaxiv"], alphaXiv: mirror },
      {
        ...item,
        paperId: "pap_mirror",
        title: "Mirror only",
        rev: null,
        addedVia: null,
        status: "read",
        origin: ["alphaxiv"],
        alphaXiv: {
          ...mirror,
          url: alphaUrl + "v2",
          hasNotes: false,
          highlightCount: 0,
        },
      },
      {
        title: "Private draft",
        origin: ["alphaxiv-private"],
        link: { kind: "alphaxiv", url: privateUrl },
      },
    ],
  });
  const freshness = (
    await screen.findByText(/alphaXiv mirror synced/)
  ).querySelector("time");
  expect(freshness?.dateTime).toBe(syncedAt);
  expect(freshness?.textContent).toBe("18 Nov 2026, 18:00 GMT+8");
  const merged = (await screen.findByRole("link", { name: title })).closest(
    "tr",
  )!;
  expect(merged.textContent).toContain("LitScout");
  expect(merged.textContent).toContain(folder.path);
  expect(merged.textContent).toContain("2 highlights");
  expect(merged.textContent).toContain("Has notes");
  expect(merged.textContent).toContain("Done on alphaXiv");
  expect(merged.querySelector('a[href="' + alphaUrl + '"]')).toBeTruthy();

  const mirrorOnly = screen
    .getByRole("link", { name: "Mirror only" })
    .closest("tr")!;
  expect(mirrorOnly.textContent).toContain("Done");
  expect(mirrorOnly.querySelector("button,select")).toBeNull();

  const privateRow = screen.getByText("Private draft").closest("tr")!;
  expect(privateRow.textContent).toBe("Private draftOpen in alphaXiv");
  expect(privateRow.querySelector("a")?.href).toBe(privateUrl);
  expect(privateRow.querySelector("button,select")).toBeNull();
  // Origin, folder, venue, year and tags live in the Filters dialog.
  fireEvent.click(screen.getByRole("button", { name: "Filters" }));
  const filters = within(
    await screen.findByRole("dialog", { name: "Library filters" }),
  );
  fireEvent.change(filters.getByLabelText("Origin"), {
    target: { value: "alphaxiv" },
  });
  fireEvent.change(filters.getByLabelText("Folder"), {
    target: { value: folder.id },
  });
  fireEvent.click(filters.getByRole("button", { name: "Apply filters" }));
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(([url]) =>
        url.includes("origin=alphaxiv&folder=" + folder.id),
      ),
    ).toBe(true),
  );
});

it("filters the Library by type and top venues in the Filters dialog, in the address", async () => {
  const fetcher = harness(
    "/app/library",
    false,
    { items: [item], nextCursor: null },
    { topVenues: ["TOG", "ICLR"] },
  );
  await screen.findByRole("link", { name: title });
  fireEvent.click(screen.getByRole("button", { name: "Filters" }));
  const filters = within(
    await screen.findByRole("dialog", { name: "Library filters" }),
  );
  const kind = filters.getByLabelText("Type");
  expect(
    Array.from(kind.querySelectorAll("option"), (o) => o.textContent),
  ).toEqual(["All types", "Preprints", "Conference papers", "Journal papers"]);
  fireEvent.change(kind, { target: { value: "journal" } });
  const topOnly = filters.getByRole("checkbox", { name: "Top venues only" });
  expect(topOnly.getAttribute("aria-describedby")).toBeTruthy();
  expect(
    document.getElementById(topOnly.getAttribute("aria-describedby")!)
      ?.textContent,
  ).toBe("Venues marked top in your watchlist (2)");
  fireEvent.click(topOnly);
  fireEvent.click(filters.getByRole("button", { name: "Apply filters" }));
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(([url]) =>
        url.endsWith("/library?kind=journal&top=true"),
      ),
    ).toBe(true),
  );
  // Both count in the badge and open checked from the address.
  fireEvent.click(await screen.findByRole("button", { name: "Filters (2)" }));
  const again = within(
    await screen.findByRole("dialog", { name: "Library filters" }),
  );
  expect(
    again.getByRole("option", { name: "Journal papers", selected: true }),
  ).toBeTruthy();
  expect(
    (
      again.getByRole("checkbox", {
        name: "Top venues only",
      }) as HTMLInputElement
    ).checked,
  ).toBe(true);
  fireEvent.click(again.getByRole("button", { name: "Clear filters" }));
  await screen.findByRole("button", { name: "Filters" });
  // The list loads again without the two filters.
  await waitFor(() =>
    expect(
      fetcher.mock.calls.filter(([url]) => url.endsWith("/library?")),
    ).toHaveLength(2),
  );
});

it("offers Top venues in the Library only when the instance lists some", async () => {
  harness("/app/library?kind=preprint", false, {
    items: [item],
    nextCursor: null,
  });
  await screen.findByRole("link", { name: title });
  fireEvent.click(screen.getByRole("button", { name: "Filters (1)" }));
  const filters = within(
    await screen.findByRole("dialog", { name: "Library filters" }),
  );
  expect(
    filters.getByRole("option", { name: "Preprints", selected: true }),
  ).toBeTruthy();
  expect(
    filters.queryByRole("checkbox", { name: "Top venues only" }),
  ).toBeNull();
});

it("can continue a sparse Library search from an empty page", async () => {
  const fetcher = harness("/app/library?q=geometry", false, (url: URL) => ({
    items: url.searchParams.has("cursor") ? [item] : [],
    nextCursor: url.searchParams.has("cursor") ? null : "next",
  }));
  fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
  await screen.findByRole("link", { name: title });
  expect(fetcher.mock.calls.some(([url]) => url.includes("cursor=next"))).toBe(
    true,
  );
});

it("filters the Library by status with one row of toggles", async () => {
  const fetcher = harness("/app/library", false, {
    items: [item],
    nextCursor: null,
  });
  await screen.findByRole("link", { name: title });
  const status = within(screen.getByRole("group", { name: "Status" }));
  expect(status.getAllByRole("button").map((b) => b.textContent)).toEqual([
    "All",
    "To read",
    "Reading",
    "Saved",
    "Done",
    "Archived",
  ]);
  expect(
    status.getByRole("button", { name: "All" }).getAttribute("aria-pressed"),
  ).toBe("true");
  fireEvent.click(status.getByRole("button", { name: "Reading" }));
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(([url]) => url.includes("status=reading")),
    ).toBe(true),
  );
  expect(
    status
      .getByRole("button", { name: "Reading" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
});

it("puts no read mark on a saved paper: the Status column says where it stands", async () => {
  harness("/app/library", false, {
    items: [{ ...item, readAt: "2026-11-18T01:00:00Z" }],
    nextCursor: null,
  });
  const row = (await screen.findByRole("link", { name: title })).closest("tr")!;
  expect(within(row).queryByRole("img", { name: "Read" })).toBeNull();
  expect(row.querySelector("td svg.lucide-check")).toBeNull();
  expect(row.hasAttribute("data-read")).toBe(false);
});

it("keeps row actions in one menu and confirms before removing", async () => {
  const fetcher = harness("/app/library", false, {
    items: [item],
    nextCursor: null,
  });
  const row = (await screen.findByRole("link", { name: title })).closest("tr")!;
  const menu = () =>
    within(row).getByRole("button", { name: "Actions for " + title });
  fireEvent.click(menu());
  fireEvent.click(within(row).getByRole("button", { name: "Edit tags" }));
  // Each inline form takes focus, and closing it hands focus back to the menu.
  await waitFor(() =>
    expect(within(row).getByLabelText("Comma-separated tags")).toBe(
      document.activeElement,
    ),
  );
  within(row).getByRole("button", { name: "Cancel" }).focus();
  fireEvent.click(within(row).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(menu()).toBe(document.activeElement));
  fireEvent.click(menu());
  fireEvent.click(
    within(row).getByRole("button", { name: "Remove from library…" }),
  );
  await waitFor(() =>
    expect(within(row).getByRole("button", { name: "Confirm remove" })).toBe(
      document.activeElement,
    ),
  );
  fireEvent.click(within(row).getByRole("button", { name: "Confirm remove" }));
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(([, init]) => init?.method === "DELETE"),
    ).toBe(true),
  );
});

it("gives focus back to the row's link when the side panel closes", async () => {
  const fetcher = harness("/app/library", false, {
    items: [item],
    nextCursor: null,
  });
  const libraryGets = () =>
    fetcher.mock.calls.filter(
      ([url, init]) =>
        new URL(url, "https://local.example").pathname.endsWith("/library") &&
        (init?.method ?? "GET") === "GET",
    ).length;
  const link = await screen.findByRole("link", { name: title });
  link.focus();
  fireEvent.click(link);
  await screen.findByRole("complementary", { name: `Paper: ${title}` });
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByRole("complementary", { name: /^Paper/ })).toBeNull(),
  );
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("link", { name: title }),
    ),
  );
  // Opening and closing the panel is not a new search.
  expect(libraryGets()).toBe(1);
});

it("lines the search and filters up with the table, under the header", async () => {
  harness("/app/library", false, { items: [item], nextCursor: null });
  await screen.findByRole("link", { name: title });
  const search = screen.getByRole("search", { name: "Search the library" });
  // Not floated to the right of the title, where it starts mid-row.
  expect(search.closest("header")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Filters" }).closest("header"),
  ).toBeNull();
  // The one primary action stays with the title.
  expect(
    screen.getByRole("button", { name: "Add paper" }).closest("header"),
  ).toBeTruthy();
});
