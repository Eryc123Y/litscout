// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { DeliveryCalendar, calendarCells } from "../src/HealthCalendar";

const days = Array.from({ length: 30 }, (_, index) => {
  const date = new Date(Date.UTC(2026, 9, 21 + index));
  return date.toISOString().slice(0, 10);
});

it("places weekdays on a Monday-to-Friday grid and leaves weekends off it", () => {
  const cells = calendarCells(days);
  expect(cells).toHaveLength(30);
  // 21 Oct 2026 is a Wednesday: third column of the first week.
  expect(cells[0]).toEqual({ day: "2026-10-21", column: 3, row: 1 });
  // Saturday and Sunday stay in the list for screen readers, off the grid.
  expect(cells[3]).toEqual({ day: "2026-10-24", column: null, row: 1 });
  expect(cells[4]).toEqual({ day: "2026-10-25", column: null, row: 1 });
  // The next Monday starts a new row.
  expect(cells[5]).toEqual({ day: "2026-10-26", column: 1, row: 2 });
  // 19 Nov 2026 is a Thursday in the fifth week.
  expect(cells.at(-1)).toEqual({ day: "2026-11-19", column: 4, row: 5 });
  expect(cells.filter((cell) => cell.column !== null)).toHaveLength(22);
});

it("survives a refetch that moves the window past the shown day", () => {
  const window30 = (start: number) =>
    Array.from({ length: 30 }, (_, index) => ({
      day: new Date(Date.UTC(2026, 9, start + index))
        .toISOString()
        .slice(0, 10),
      status: "on-time" as const,
      reported: true,
      digestAt: null,
    }));
  const view = render(
    createElement(DeliveryCalendar, { days: window30(21), timezone: "UTC" }),
  );
  // Show the oldest weekday (Wed 21 Oct), then refetch a window one day later.
  fireEvent.focus(screen.getByRole("button", { name: /^2026-10-21 · / }));
  expect(screen.getByText("Wed 21 Oct")).toBeTruthy();
  view.rerender(
    createElement(DeliveryCalendar, { days: window30(22), timezone: "UTC" }),
  );
  // The readout falls back to the latest day instead of throwing.
  expect(screen.getByText("Fri 20 Nov")).toBeTruthy();
  // Hover and focus show a day; they don't set a pressed state.
  for (const button of screen.getAllByRole("button"))
    expect(button.hasAttribute("aria-pressed")).toBe(false);
  cleanup();
});

it("draws days before LitScout and imported days as neutral, and counts only those present", () => {
  const status = (day: string) =>
    day < "2026-10-27"
      ? ("imported" as const)
      : day < "2026-11-16"
        ? ("before-start" as const)
        : ("on-time" as const);
  const window30 = days.map((day) => ({
    day,
    status: status(day),
    reported: false,
    digestAt: null,
  }));
  render(createElement(DeliveryCalendar, { days: window30, timezone: "UTC" }));
  expect(
    screen.getByRole("button", { name: /^2026-10-21 · Imported/ }),
  ).toBeTruthy();
  const before = screen.getByRole("button", {
    name: /^2026-11-13 · Before LitScout/,
  });
  expect(before.className).toContain("border-dashed");
  fireEvent.focus(before);
  expect(screen.getByText(/: before LitScout, no run report/)).toBeTruthy();
  const totals = screen
    .getAllByRole("list", { name: "Delivery totals" })[0]!
    .textContent!.replace(/\s+/g, " ");
  expect(totals).toContain("before LitScout");
  expect(totals).toContain("imported");
  cleanup();
  // A window with neither leaves them out of the totals.
  render(
    createElement(DeliveryCalendar, {
      days: days.map((day) => ({
        day,
        status: "on-time" as const,
        reported: true,
        digestAt: null,
      })),
      timezone: "UTC",
    }),
  );
  const plain = screen.getByRole("list", { name: "Delivery totals" });
  expect(plain.textContent).not.toMatch(/before LitScout|imported/);
  cleanup();
});
