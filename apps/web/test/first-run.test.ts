// @vitest-environment jsdom
// A new LitScout, before its first fetch: the reader says what LitScout is,
// shows the reader's own topics, and gives the commands for the first day.
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

const day = "2026-11-25";
const instance = {
  name: "LitScout",
  publicFeed: false,
  language: "en" as const,
  timezone: "UTC",
  topics: ["Depth estimation", "Speech"],
  keywordOnly: true,
};
const json = (data: unknown) => Response.json({ success: true, data });
const counts = (total: number) => ({
  total,
  summarised: 0,
  shortlisted: total,
  arxiv: total,
  venues: 0,
  topics: {},
  sources: {},
  venueCounts: {},
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

/** An instance whose earlier days are `days`: none, for a new one. */
function serve(
  days: { day: string; status: string; total: number }[],
  nextBefore: string | null = null,
) {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const parsed = new URL(url, "https://local");
      const path = parsed.pathname.replace(/^\/api\/v1/, "");
      if (path === "/feed/days" || path === "/public/days")
        return json({
          items: days.map((d) => ({
            day: d.day,
            status: d.status,
            counts: counts(d.total),
          })),
          nextBefore,
        });
      if (path.endsWith("/digest")) return json(null);
      if (path.endsWith("/triage")) return json({ day, items: [], toRead: 0 });
      if (/\/days\/\d{4}-\d\d-\d\d$/.test(path))
        return json({
          day,
          status: "pending",
          counts: counts(0),
          items: [],
          nextCursor: null,
        });
      return json({ items: [], nextCursor: null });
    }),
  );
}
function mount(isPublic = false) {
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
        {
          initialEntries: [`${isPublic ? "/public" : "/app"}/today?day=${day}`],
        },
        h(Feed, { isPublic, instance }),
      ),
    ),
  );
}

it("welcomes a new reader with their topics and the first commands", async () => {
  serve([]);
  const writeText = vi.fn(async () => undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  mount();
  const welcome = await screen.findByRole("region", {
    name: "Welcome to LitScout",
  });
  const topics = within(welcome).getByRole("list", { name: "Your topics" });
  expect(
    within(topics)
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual(["Depth estimation", "Speech"]);
  const commands = within(welcome).getByText(/litscout daily fetch --json/);
  expect(commands.textContent).toContain(
    "litscout token create --name scheduler --scopes read,ingest --save-only",
  );
  // Keyword mode says how summaries are turned on.
  expect(welcome.textContent).toMatch(/agent\.mode/);
  fireEvent.click(
    within(welcome).getByRole("button", { name: "Copy the commands" }),
  );
  await waitFor(() =>
    expect(writeText).toHaveBeenCalledWith(
      "litscout token create --name scheduler --scopes read,ingest --save-only\nlitscout daily fetch --json",
    ),
  );
  // The status starts empty and is filled once the copy is done.
  const status = within(welcome).getByRole("status");
  await waitFor(() => expect(status.textContent).toBe("Copied"));
});

it("says when copying failed, without hiding the commands", async () => {
  serve([]);
  vi.stubGlobal("navigator", {
    ...navigator,
    clipboard: { writeText: vi.fn(async () => Promise.reject(new Error())) },
  });
  mount();
  const welcome = await screen.findByRole("region", {
    name: "Welcome to LitScout",
  });
  fireEvent.click(
    within(welcome).getByRole("button", { name: "Copy the commands" }),
  );
  // The status starts empty and is filled once the copy is done.
  const status = within(welcome).getByRole("status");
  await waitFor(() => expect(status.textContent).toBe("Copy failed"));
  expect(within(welcome).getByText(/litscout daily fetch/)).toBeTruthy();
});

it("is gone once any day has papers, and never on the public feed", async () => {
  serve([{ day: "2026-11-24", status: "final", total: 12 }]);
  mount();
  expect(await screen.findByText("No papers yet today.")).toBeTruthy();
  expect(
    screen.queryByRole("region", { name: "Welcome to LitScout" }),
  ).toBeNull();
  cleanup();

  // Older days on a later page: not a new LitScout.
  serve([{ day: "2026-11-24", status: "empty", total: 0 }], "2026-11-20");
  mount();
  expect(await screen.findByText("No papers yet today.")).toBeTruthy();
  expect(
    screen.queryByRole("region", { name: "Welcome to LitScout" }),
  ).toBeNull();
  cleanup();

  serve([]);
  mount(true);
  await waitFor(() =>
    expect(
      screen.queryAllByText(/No papers yet for this day|No papers yet today/),
    ).not.toHaveLength(0),
  );
  expect(
    screen.queryByRole("region", { name: "Welcome to LitScout" }),
  ).toBeNull();
});
