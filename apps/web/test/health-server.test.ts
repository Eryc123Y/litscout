// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { Health } from "../src/Health";

// On an own server Health shows the server's facts: storage against the
// cap, the newest snapshot and the newest run of each timer.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const GB = 1024 ** 3;
const days = Array.from({ length: 30 }, (_, index) => ({
  day: new Date(Date.UTC(2026, 9, 24 + index)).toISOString().slice(0, 10),
  status: "on-time",
  reported: true,
  digestAt: null,
}));
const health = (extra: Record<string, unknown>) => ({
  timezone: "UTC",
  onTimeBy: "23:59",
  firstRunDay: "2026-11-16",
  days,
  runs: [],
  budget: {
    used: 0,
    reserved: 0,
    limit: 1_000_000,
    resetAt: "2026-11-23T00:00:00.000Z",
    rowsRead: 10,
  },
  storage: { sizeBytes: 55_000_000, feedItems: 0, summaries: 0, vaultNotes: 0 },
  links: { unchecked: 0, capped: false },
  mirror: { activeAt: null, completedAt: null },
  ...extra,
});
const server = {
  checkedAt: "2026-11-22T13:50:00Z",
  footprintBytes: Math.round(2.8 * GB),
  warningBytes: 4 * GB,
  capBytes: 5 * GB,
  snapshot: { at: "2026-11-22T04:30:12Z", bytes: 6_800_000 },
  runs: [
    { mode: "main", startedAt: "2026-11-22T01:45:00Z", failed: false },
    { mode: "final", startedAt: "2026-11-22T13:45:00Z", failed: true },
  ],
};
function show(data: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ success: true, data })),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(createElement(QueryClientProvider, { client }, createElement(Health)));
}

it("shows storage against the cap, the newest snapshot and each timer's last run", async () => {
  show(health({ runtime: "server", server }));
  const heading = await screen.findByRole("heading", { name: "Server" });
  const card = within(heading.closest("[data-slot=card]") as HTMLElement);
  expect(card.getByText("2.8 GB of 5 GB")).toBeTruthy();
  const meter = card.getByRole("progressbar", { name: "Server storage used" });
  expect(meter.getAttribute("value")).toBe("56");
  // Short times: the tile is narrow and the page names the time zone.
  expect(card.getByText("Snapshot 22 Nov, 04:30 · 6.8 MB")).toBeTruthy();
  const runs = within(
    card.getByRole("list", { name: "Last run of each timer" }),
  );
  expect(runs.getAllByRole("listitem").map((item) => item.textContent)).toEqual(
    ["Morning22 Nov, 01:45OK", "RetryNo run yet", "Evening22 Nov, 13:45Failed"],
  );
  expect(card.getByText("Reported 22 Nov, 13:50")).toBeTruthy();
});

it("warns near the cap and says when the server has not reported", async () => {
  show(
    health({
      runtime: "server",
      server: {
        ...server,
        footprintBytes: Math.round(4.5 * GB),
        snapshot: null,
      },
    }),
  );
  const heading = await screen.findByRole("heading", { name: "Server" });
  const card = within(heading.closest("[data-slot=card]") as HTMLElement);
  expect(card.getByText("Above the 4 GB warning level")).toBeTruthy();
  expect(card.getByText("No snapshot yet")).toBeTruthy();
  cleanup();
  show(health({ runtime: "server", server: null }));
  expect(await screen.findByText("No report from the server yet")).toBeTruthy();
});

it("has no Server tile on Cloudflare", async () => {
  show(health({}));
  await screen.findByRole("heading", { name: "Last run" });
  expect(screen.queryByRole("heading", { name: "Server" })).toBeNull();
});
