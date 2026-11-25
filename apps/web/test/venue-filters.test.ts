// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Filters } from "../src/Filters";
import { readFilters } from "../src/useReader";
afterEach(cleanup);

const counts = {
  total: 4,
  summarised: 4,
  shortlisted: 4,
  arxiv: 2,
  venues: 2,
  topics: { Vision: 4 },
  sources: { arxiv: 2, openalex: 2 },
  venueCounts: { ICLR: 1, "IEEE TPAMI": 1 },
};

it("filters by venue type and top venues, with removable chips", () => {
  const onChange = vi.fn();
  const { rerender } = render(
    createElement(Filters, {
      counts,
      topics: ["Vision"],
      topVenues: ["ICLR", "IEEE TPAMI"],
      value: {},
      onChange,
    }),
  );
  fireEvent.change(screen.getByLabelText("Type"), {
    target: { value: "journal" },
  });
  expect(onChange).toHaveBeenLastCalledWith({ kind: "journal" });
  fireEvent.click(screen.getByRole("button", { name: "Top venues" }));
  expect(onChange).toHaveBeenLastCalledWith({ top: true });
  expect(screen.getByText(/marked top in your watchlist \(2\)/)).toBeTruthy();

  rerender(
    createElement(Filters, {
      counts,
      topics: ["Vision"],
      topVenues: ["ICLR"],
      value: { kind: "conference", top: true },
      onChange,
    }),
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: "Remove filter: Type Conference papers",
    }),
  );
  expect(onChange).toHaveBeenLastCalledWith({ kind: "", top: true });
  fireEvent.click(
    screen.getByRole("button", { name: "Remove filter: Top venues" }),
  );
  expect(onChange).toHaveBeenLastCalledWith({
    kind: "conference",
    top: false,
  });
});

it("hides the Top venues toggle when the instance lists none", () => {
  render(
    createElement(Filters, {
      counts,
      topics: ["Vision"],
      value: {},
      onChange: vi.fn(),
    }),
  );
  expect(screen.queryByRole("button", { name: "Top venues" })).toBeNull();
  expect(screen.getByLabelText("Type")).toBeTruthy();
});

it("reads both filters from the address", () => {
  expect(
    readFilters(new URLSearchParams("kind=journal&top=true")),
  ).toMatchObject({ kind: "journal", top: true });
});
