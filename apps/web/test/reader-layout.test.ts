import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createElement, createRef } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { PageHeader } from "../src/PageHeader";
import { EmptyState, LoadingState } from "../src/ReaderState";
import {
  countOf,
  formatCount,
  formatDay,
  formatTimestamp,
} from "../src/format";

afterEach(cleanup);

it("renders one page heading with its description and an accessible action", () => {
  const titleRef = createRef<HTMLHeadingElement>();
  render(
    createElement(PageHeader, {
      title: "Library",
      titleRef,
      description: "Your saved papers.",
      context: "Research",
      actions: createElement("button", null, "Find a paper"),
    }),
  );

  const heading = screen.getByRole("heading", { level: 1, name: "Library" });
  expect(titleRef.current).toBe(heading);
  expect(heading.tabIndex).toBe(-1);
  expect(screen.getByText("Your saved papers.")).toBeTruthy();
  expect(screen.getByText("Research")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Find a paper" })).toBeTruthy();
});

it("shows empty-state guidance and makes an error and its recovery action available", () => {
  const retry = vi.fn();
  const { rerender } = render(
    createElement(EmptyState, {
      title: "No papers yet.",
      description: "Find a paper to add it.",
    }),
  );
  expect(screen.getByText("No papers yet.")).toBeTruthy();
  expect(screen.getByText("Find a paper to add it.")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();

  rerender(
    createElement(EmptyState, {
      compact: true,
      role: "alert",
      title: "Library unavailable",
      description: "Something went wrong.",
      actions: createElement("button", { onClick: retry }, "Retry"),
    }),
  );
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain("Library unavailable");
  expect(alert.textContent).toContain("Something went wrong.");
  fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
  expect(retry).toHaveBeenCalledOnce();
});

it("announces loading while keeping the placeholder bars out of the accessibility tree", () => {
  render(createElement(LoadingState, { label: "Loading papers…" }));
  const status = screen.getByRole("status");
  expect(status.textContent).toBe("Loading papers…");
  expect(
    status.querySelectorAll('[aria-hidden="true"] [data-slot="skeleton"]'),
  ).toHaveLength(2);
});

it("shows a loading placeholder only after a short wait, so fast answers do not flash one", () => {
  render(createElement(LoadingState, { label: "Loading papers…" }));
  // The words are announced at once; only what is seen waits.
  expect(screen.getByRole("status").className).toContain("loading-state");
  const css = readFileSync(resolve(__dirname, "../src/style.css"), "utf8");
  const rule = /\.loading-state\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  expect(rule).toMatch(/animation:\s*loading-in[^;]*\b200ms\b[^;]*backwards/);
  expect(css).toMatch(/@keyframes loading-in\s*\{\s*from\s*\{\s*opacity:\s*0/);
});

it("formats dates, timestamps and counts consistently", () => {
  expect(formatDay("2026-11-17")).toBe("17 Nov 2026");
  expect(formatDay("2026-11-17", "heading")).toMatch(/^Tuesday,? 17 November$/);
  expect(formatTimestamp("2026-11-17T16:20:00+08:00", "UTC")).toBe(
    "17 Nov 2026, 08:20 UTC",
  );
  expect(formatCount(17200)).toBe("17,200");
});

it("names counts in the singular for one", () => {
  // 2026-11-19 on the public Today page: "1 papers · 0 summaries".
  expect(countOf(1, "paper")).toBe("1 paper");
  expect(countOf(0, "paper")).toBe("0 papers");
  expect(countOf(17200, "paper")).toBe("17,200 papers");
  expect(countOf(1, "summary", "summaries")).toBe("1 summary");
  expect(countOf(2, "summary", "summaries")).toBe("2 summaries");
  expect(countOf(1, "keyword match", "keyword matches")).toBe(
    "1 keyword match",
  );
});

it.each([
  ["Asia/Kuala_Lumpur", "2026-11-17T18:20:00Z", "18 Nov 2026, 02:20 GMT+8"],
  ["America/Los_Angeles", "2026-11-17T04:20:00Z", "16 Nov 2026, 20:20 GMT-8"],
])("formats an instant across midnight in %s", (timezone, at, expected) => {
  expect(formatTimestamp(at, timezone)).toBe(expected);
});

it("gives every page one header and two widths", () => {
  const css = readFileSync(resolve(__dirname, "../src/style.css"), "utf8");
  // Actions sit on the title's line, not the description's.
  const header = /\.reader-header\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  expect(header).toContain("items-start");
  expect(header).not.toContain("items-end");
  // A form page keeps to one readable column; everything else is full width.
  expect(css).toMatch(/\.page-column\s*\{[^}]*max-w-3xl/);
  for (const file of ["Health.tsx", "Library.tsx", "Ideas.tsx", "Trends.tsx"])
    expect(
      readFileSync(resolve(__dirname, "../src", file), "utf8"),
      file,
    ).not.toMatch(/className="reader-page[^"]*max-w-/);
  expect(
    readFileSync(resolve(__dirname, "../src/Settings.tsx"), "utf8"),
  ).toContain("page-column");
});
