// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { Health } from "../src/Health";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// 22 Oct to 20 Nov 2026, as on staging on 21 Nov.
const window30 = Array.from({ length: 30 }, (_, index) =>
  new Date(Date.UTC(2026, 9, 22 + index)).toISOString().slice(0, 10),
);
const weekend = (day: string) =>
  [0, 6].includes(new Date(day + "T00:00:00Z").getUTCDay());

function healthData(
  status: (day: string) => string,
  firstRunDay: string | null,
  runs: unknown[] = [],
) {
  return {
    timezone: "UTC",
    onTimeBy: "11:30",
    firstRunDay,
    days: window30.map((day) => ({
      day,
      status: weekend(day) ? "no-listing" : status(day),
      reported: false,
      digestAt: null,
    })),
    runs,
    budget: {
      used: 0,
      reserved: 0,
      limit: 80000,
      resetAt: "2026-11-22T00:00:00.000Z",
      rowsRead: 10,
    },
    storage: { sizeBytes: null, feedItems: 0, summaries: 0, vaultNotes: 0 },
    links: { unchecked: 0, capped: false },
    mirror: { activeAt: null, completedAt: null },
  };
}

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

const pausedRun = {
  id: "b252ded4-acb7-45ba-9ca7-da862550bf1b",
  startedAt: "2026-11-20T02:00:00.000Z",
  finishedAt: "2026-11-20T04:00:00.000Z",
  targetDay: "2026-11-20",
  rowsWritten: 10,
  steps: {
    fetch: { status: "done" },
    summaries: { status: "paused", client: "api", error: "budget" },
    digest: { status: "done" },
    sync: { status: "skipped" },
    legacy: { status: "skipped" },
  },
};

it("counts only listing days since LitScout started in the status line", async () => {
  show(
    healthData(
      (day) =>
        day < "2026-11-16"
          ? "before-start"
          : day === "2026-11-17"
            ? "missed"
            : "late",
      "2026-11-16",
      [pausedRun],
    ),
  );
  expect(
    await screen.findByText(
      "Since LitScout started on 16 Nov: 4 of 5 listing days late, 1 missed; the last run's summaries step paused.",
    ),
  ).toBeTruthy();
  expect(screen.getByText("Needs attention.")).toBeTruthy();
});

it("keeps the 30-day count when LitScout started before the window", async () => {
  show(
    healthData(
      (day) => (day === "2026-11-17" ? "missed" : "on-time"),
      "2026-09-01",
    ),
  );
  expect(
    await screen.findByText("1 of the last 22 listing days missed."),
  ).toBeTruthy();
});

it("says when LitScout has not run yet", async () => {
  show(healthData(() => "before-start", null));
  expect(
    await screen.findByText("LitScout has no recorded runs yet."),
  ).toBeTruthy();
  expect(screen.queryByText("All good.")).toBeNull();
});

it("stacks each step's name and status in the last run card", async () => {
  show(healthData(() => "on-time", "2026-09-01", [pausedRun]));
  const stages = within(
    await screen.findByRole("list", { name: "Last run stages" }),
  );
  const rows = stages.getAllByRole("listitem");
  expect(rows).toHaveLength(4);
  const summaries = rows[1]!;
  // Name and status are separate lines, not one run of text.
  expect(within(summaries).getByText("Summaries")).toBeTruthy();
  expect(within(summaries).getByText("Paused")).toBeTruthy();
  expect(within(rows[2]!).getByText("Digest")).toBeTruthy();
  expect(within(rows[2]!).getByText("Done")).toBeTruthy();
});
