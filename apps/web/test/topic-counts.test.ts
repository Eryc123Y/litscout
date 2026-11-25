// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { Filters } from "../src/Filters";
afterEach(cleanup);

// 9 papers came in; 3 matched the reader's topics (all Vision). Robotics had
// none that day.
const counts = {
  total: 9,
  summarised: 9,
  shortlisted: 3,
  arxiv: 9,
  venues: 0,
  topics: { Vision: 3 },
  sources: { arxiv: 9 },
  venueCounts: {},
};
const topics = ["Vision", "Robotics"];
const radio = (name: RegExp) =>
  screen.getByRole<HTMLButtonElement>("radio", { name });

it("counts only papers on the reader's topics in the topic row, without a Shortlisted filter", () => {
  render(
    createElement(Filters, { counts, topics, value: {}, onChange: vi.fn() }),
  );
  expect(radio(/^All/).textContent).toContain("3");
  expect(radio(/Robotics/).disabled).toBe(true);
  expect(screen.queryByText("Shortlisted")).toBeNull();
});
