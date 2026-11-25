// @vitest-environment jsdom
import { createElement, Fragment } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { originFor, panelSearch, readPanel } from "../src/origin";
import { PanelLink, SidePanel } from "../src/SidePanel";
import { FullPaper } from "../src/FeedParts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const json = (data: unknown) => Response.json({ success: true, data });
const note = "b".repeat(64);

it("names where a paper was opened from, without the panel itself", () => {
  expect(originFor("/app/projects", "?panel=note%3Aabc")).toEqual({
    label: "Projects",
    path: "/app/projects",
  });
  expect(originFor("/app/trends", "?topic=Vision&month=2026-11")).toEqual({
    label: "Trends",
    path: "/app/trends?topic=Vision&month=2026-11",
  });
  expect(originFor("/app/days/2026-11-20", "?paper=pap_a")).toEqual({
    label: "20 Nov 2026",
    path: "/app/days/2026-11-20?paper=pap_a",
  });
  expect(originFor("/app/today", "")?.label).toBe("Today");
  expect(originFor("/app/library", "")?.label).toBe("Library");
  expect(originFor("/app/ideas", "")?.label).toBe("Ideas");
  expect(originFor("/app/working-papers/wp_1", "")?.label).toBe(
    "Working papers",
  );
  expect(originFor("/app/settings", "")).toBeNull();
});

it("reads and writes the panel target in the address", () => {
  expect(readPanel("paper:pap_a:arxiv")).toEqual({
    kind: "paper",
    id: "pap_a",
    source: "arxiv",
  });
  expect(readPanel("paper:pap_a")).toEqual({
    kind: "paper",
    id: "pap_a",
    source: undefined,
  });
  expect(readPanel(`note:${note}`)).toEqual({ kind: "note", id: note });
  expect(readPanel("paper:arxiv/2611.001")?.id).toBe("arxiv/2611.001");
  for (const bad of [
    null,
    "",
    "paper:",
    "note:",
    "video:x",
    "note:a:b",
    "note:..",
    "note:.",
    "paper:a/../b",
    "paper:/a",
  ])
    expect(readPanel(bad)).toBeNull();
  expect(
    panelSearch("?topic=Vision", {
      kind: "paper",
      id: "pap_a",
      source: "arxiv",
    }),
  ).toBe("?topic=Vision&panel=paper%3Apap_a%3Aarxiv");
  expect(panelSearch("?topic=Vision&panel=note%3Ax", null)).toBe(
    "?topic=Vision",
  );
});

function mount(path: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/vault/notes/"))
        return json({
          id: note,
          kind: "project",
          title: "Stereo project",
          path: "Projects/Stereo.md",
          bodyMd: "## Plan\n\nRead the **depth** papers.",
        });
      return json(null);
    }),
  );
  return render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        { initialEntries: [path] },
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: "*",
            element: createElement(
              Fragment,
              null,
              createElement(
                "main",
                null,
                createElement(PanelLink, {
                  target: { kind: "note", id: note },
                  children: "Read note",
                }),
              ),
              createElement(SidePanel),
            ),
          }),
        ),
      ),
    ),
  );
}

it("opens a note beside the page and closes it with Escape", async () => {
  mount("/app/projects");
  expect(screen.queryByRole("complementary", { name: /^Note/ })).toBeNull();
  fireEvent.click(screen.getByRole("link", { name: "Read note" }));
  const panel = await screen.findByRole("complementary", {
    name: "Note: Stereo project",
  });
  expect(within(panel).getByText("depth").tagName).toBe("STRONG");
  expect(within(panel).getByText(/Read-only/)).toBeTruthy();
  // The page under it is still there, unchanged.
  expect(screen.getByRole("link", { name: "Read note" })).toBeTruthy();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("complementary", { name: /^Note/ })).toBeNull();
});

it("closes from its own button and resizes from the keyboard", async () => {
  mount(`/app/projects?panel=note%3A${note}`);
  const panel = await screen.findByRole("complementary", {
    name: "Note: Stereo project",
  });
  const handle = within(panel).getByRole("separator", {
    name: "Resize the side panel",
  });
  const width = Number(handle.getAttribute("aria-valuenow"));
  // The handle sits on the panel's left edge: moving it left widens it.
  fireEvent.keyDown(handle, { key: "ArrowLeft" });
  expect(Number(handle.getAttribute("aria-valuenow"))).toBe(width + 16);
  fireEvent.click(within(panel).getByRole("button", { name: "Close panel" }));
  expect(screen.queryByRole("complementary", { name: /^Note/ })).toBeNull();
});

function mountFullPaper(entry: string | { pathname: string; state?: unknown }) {
  return render(
    createElement(
      MemoryRouter,
      { initialEntries: [entry] },
      createElement(FullPaper, {
        base: "/app",
        day: "2026-11-20",
        language: "en",
        timezone: "UTC",
        topics: [],
      }),
    ),
  );
}

it("names the page a full paper was opened from and goes back to it", () => {
  mountFullPaper({
    pathname: "/app/papers/pap_a",
    state: { from: { label: "Projects", path: "/app/projects" } },
  });
  const crumbs = within(screen.getByRole("navigation", { name: "Breadcrumb" }));
  expect(
    crumbs.getByRole("link", { name: "Projects" }).getAttribute("href"),
  ).toBe("/app/projects");
  expect(crumbs.queryByRole("link", { name: "Today" })).toBeNull();
  expect(screen.getByRole("button", { name: "Back to Projects" })).toBeTruthy();
});

it("falls back to Today and the paper's day without an origin, ignoring foreign ones", () => {
  mountFullPaper({
    pathname: "/app/papers/pap_a",
    state: { from: { label: "Elsewhere", path: "https://example.com" } },
  });
  const crumbs = within(screen.getByRole("navigation", { name: "Breadcrumb" }));
  expect(crumbs.getByRole("link", { name: "Today" })).toBeTruthy();
  expect(crumbs.getByRole("link", { name: "20 Nov 2026" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Back to/ })).toBeNull();
});

it("gives focus back to the link that opened the panel when it closes", async () => {
  mount("/app/projects");
  const link = screen.getByRole("link", { name: "Read note" });
  link.focus();
  fireEvent.click(link);
  const panel = await screen.findByRole("complementary", {
    name: "Note: Stereo project",
  });
  await waitFor(() => expect(document.activeElement).toBe(panel));
  fireEvent.click(within(panel).getByRole("button", { name: "Close panel" }));
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("link", { name: "Read note" }),
    ),
  );
});
