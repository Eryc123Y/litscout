// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { render, screen, within, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppShell } from "../src/AppShell";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const onAppearance = vi.fn();
function mount(
  isPublic: boolean,
  path: string | { pathname: string; state?: unknown },
  publicFeed = true,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        success: true,
        data: {
          day: "2026-11-17",
          status: "final",
          counts: {
            total: 9,
            summarised: 9,
            shortlisted: 2,
            arxiv: 9,
            venues: 0,
            topics: { Vision: 4 },
            sources: { arxiv: 9 },
            venueCounts: {},
          },
          items: [],
          nextCursor: null,
        },
      }),
    ),
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
        createElement(AppShell, {
          isPublic,
          theme: "journal",
          onAppearance,
          instance: {
            name: "LitScout",
            publicFeed,
            language: "en",
            timezone: "UTC",
            topics: ["Vision"],
          },
          children: createElement("main", { id: "main" }, "Reading"),
        }),
      ),
    ),
  );
}
it("shows the private navigation without topic shortcuts in Settings", () => {
  mount(false, "/app/settings");
  const nav = within(screen.getByRole("navigation", { name: "Main" }));
  expect(
    nav.getAllByRole("link").map((link) => link.textContent?.trim()),
  ).toEqual([
    "Today",
    "Days",
    "Library",
    "Trends",
    "Projects",
    "Ideas",
    "Working papers",
  ]);
  // Groups are labelled; system pages sit apart at the bottom.
  for (const group of ["Read", "Research"])
    expect(nav.getByRole("heading", { name: group })).toBeTruthy();
  const system = within(screen.getByRole("navigation", { name: "System" }));
  expect(
    system.getAllByRole("link").map((link) => link.textContent?.trim()),
  ).toEqual(["Vault sync", "Health", "Settings"]);
  expect(
    system.getByRole("link", { name: "Settings" }).getAttribute("aria-current"),
  ).toBe("page");
  expect(screen.queryByRole("region", { name: "Topics today" })).toBeNull();
});
it.each(["/app/today", "/app/days", "/app/days/2026-11-16"])(
  "keeps the sidebar to navigation on %s; topics live with the papers",
  (path) => {
    mount(false, path);
    expect(screen.getByRole("navigation", { name: "Main" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Topics today" })).toBeNull();
    expect(
      screen.queryByRole("region", { name: "Topics on this day" }),
    ).toBeNull();
  },
);
it.each([
  "/app/library",
  "/app/papers/pap_example",
  "/public/papers/pap_example",
])("uses plain navigation on %s", (path) => {
  mount(path.startsWith("/public"), path);
  expect(screen.queryByRole("region", { name: "Topics today" })).toBeNull();
});
it.each(["expanded", "collapsed"])(
  "names brand and navigation links in the %s sidebar",
  async (layout) => {
    // JSDOM does not evaluate responsive CSS. Hide the same text as the
    // collapsed breakpoint while leaving screen-reader-only labels available.
    const style = document.createElement("style");
    if (layout === "collapsed")
      style.textContent = '[class~="md:hidden"] { display: none; }';
    document.head.appendChild(style);
    try {
      // Away from Today the shell fetches today's count itself (on Today
      // the day's feed fills it).
      mount(false, "/app/library");
      const nav = within(
        screen.getByRole("complementary", { name: "Sidebar" }),
      );
      await nav.findByText("2");
      expect(
        screen
          .getByRole("link", {
            name:
              layout === "expanded"
                ? "LitScout Your daily reading"
                : "LitScout",
          })
          .getAttribute("href"),
      ).toBe("/app/today");
      const names = [
        layout === "expanded" ? "Today 2" : "Today",
        "Days",
        "Library",
        "Projects",
        "Ideas",
        "Working papers",
        "Vault sync",
        "Settings",
      ];
      for (const name of names)
        expect(nav.getByRole("link", { name })).toBeTruthy();
    } finally {
      style.remove();
    }
  },
);
it("public navigation exposes only Today and Days and fetches only public data", async () => {
  mount(true, "/public/days");
  const nav = within(screen.getByRole("navigation", { name: "Main" }));
  expect(nav.getAllByRole("link").map((link) => link.textContent)).toEqual([
    "Today",
    "Days",
  ]);
  expect(
    nav.getByRole("link", { name: "Days" }).getAttribute("aria-current"),
  ).toBe("page");
  expect(screen.queryByRole("region", { name: "Topics today" })).toBeNull();
  expect(
    vi
      .mocked(fetch)
      .mock.calls.every(([url]) => String(url).startsWith("/api/v1/public/")),
  ).toBe(true);
  expect(screen.queryByRole("link", { name: "Health" })).toBeNull();
});
it("omits the public variant when the instance has no public feed", () => {
  mount(false, "/app/today", false);
  expect(screen.queryByRole("link", { name: "Public feed" })).toBeNull();
});

it("puts Public feed and the light and dark pair in the top bar, with no footer", async () => {
  onAppearance.mockClear();
  mount(false, "/app/library");
  const bar = within(screen.getByRole("banner", { name: "Top bar" }));
  expect(
    bar.getByRole("link", { name: "Public feed" }).getAttribute("href"),
  ).toBe("/public/today");
  const light = bar.getByRole("button", { name: "Light appearance" });
  const dark = bar.getByRole("button", { name: "Dark appearance" });
  expect(light.getAttribute("aria-pressed")).toBe("true");
  expect(dark.getAttribute("aria-pressed")).toBe("false");
  dark.click();
  expect(onAppearance).toHaveBeenCalledWith("dark");
  expect(bar.getByText("Library")).toBeTruthy();
  expect(screen.queryByRole("contentinfo")).toBeNull();
  expect(screen.queryByText("Abstract-based summaries")).toBeNull();
  expect(
    within(screen.getByRole("navigation", { name: "Main" })).queryByRole(
      "link",
      {
        name: "Public feed",
      },
    ),
  ).toBeNull();
});

it("keeps the page a paper was opened from highlighted on its full page", () => {
  mount(false, {
    pathname: "/app/papers/pap_a",
    state: { from: { label: "Projects", path: "/app/projects" } },
  });
  const nav = within(screen.getByRole("navigation", { name: "Main" }));
  expect(
    nav.getByRole("link", { name: "Projects" }).getAttribute("aria-current"),
  ).toBe("page");
  expect(
    nav.getByRole("link", { name: /^Today/ }).getAttribute("aria-current"),
  ).toBeNull();
  cleanup();
  // Opened from a link with no origin: the paper belongs to Today, as before.
  mount(false, "/app/papers/pap_a");
  expect(
    within(screen.getByRole("navigation", { name: "Main" }))
      .getByRole("link", { name: /^Today/ })
      .getAttribute("aria-current"),
  ).toBe("page");
});
