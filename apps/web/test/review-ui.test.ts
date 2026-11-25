// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, useSearchParams } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Paper } from "../src/Paper";
import { SearchPapers } from "../src/SearchPapers";
import { useFeed } from "../src/api";
import { Filters } from "../src/Filters";
import { TopicLabel } from "../src/TopicLabel";
import { App } from "../src/App";
const paper = {
  paperId: "pap_a",
  title: "A paper",
  source: "arxiv",
  topics: [],
  shortlisted: false,
  abstract: null,
  authors: [],
  identifiers: [],
  links: [],
  summaries: [],
  venue: null,
  venueKind: "preprint",
  year: null,
  publishedOn: null,
  categories: [],
  hfUpvotes: null,
};
beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function wrapper(child: React.ReactNode) {
  return createElement(
    QueryClientProvider,
    {
      client: new QueryClient({
        defaultOptions: { queries: { retry: false } },
      }),
    },
    createElement(MemoryRouter, {}, child),
  );
}
it.each(["metaKey", "ctrlKey", "altKey"])(
  "V1 ignores modified reader shortcuts (%s)",
  (modifier) => {
    const move = vi.fn(),
      close = vi.fn();
    const { container } = render(
      wrapper(createElement(Paper, { paper, onMove: move, close })),
    );
    for (const key of ["j", "k", "Escape"])
      fireEvent.keyDown(container.querySelector("article")!, {
        key,
        [modifier]: true,
      });
    expect(move).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    fireEvent.keyDown(container.querySelector("article")!, { key: "k" });
    expect(move).toHaveBeenCalledWith(-1);
  },
);
function SearchHarness() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  useFeed("2026-11-17", true, { q });
  return createElement(SearchPapers, {
    q,
    papers: [],
    searching: false,
    onOpen: vi.fn(),
    onSearch: (value) => setParams({ q: value }),
  });
}
it("V2 typing a word performs one debounced feed search", async () => {
  const fetcher = vi.fn(async (_url: RequestInfo | URL) =>
    Response.json({
      success: true,
      data: {
        day: "2026-11-17",
        status: "final",
        counts: {
          total: 0,
          summarised: 0,
          shortlisted: 0,
          arxiv: 0,
          venues: 0,
          topics: {},
          sources: {},
          venueCounts: {},
        },
        items: [],
        nextCursor: null,
      },
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  render(wrapper(createElement(SearchHarness)));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Search papers" }));
  vi.useFakeTimers();
  for (const value of ["s", "st", "ste", "ster", "stere", "stereo"]) {
    fireEvent.change(screen.getByRole("combobox"), { target: { value } });
    await act(() => vi.advanceTimersByTimeAsync(50));
  }
  expect(fetcher).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(250));
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(String(fetcher.mock.calls.at(-1)?.[0])).toContain("q=stereo");
});
it("V7 a direct paper load does not steal initial keyboard focus", () => {
  const { container } = render(wrapper(createElement(Paper, { paper })));
  expect(document.activeElement).not.toBe(container.querySelector("h1"));
});
it("V10 unchanged topic sets do not reapply their colour", () => {
  const spy = vi.spyOn(CSSStyleDeclaration.prototype, "setProperty");
  const { rerender } = render(
    createElement(TopicLabel, { topic: "Vision", topics: ["Vision"] }),
  );
  const count = () =>
    spy.mock.calls.filter(([name]) => name === "--topic-colour").length;
  expect(count()).toBe(1);
  rerender(createElement(TopicLabel, { topic: "Vision", topics: ["Vision"] }));
  expect(count()).toBe(1);
});
it("V12 initial loading and failures retain a skip-link target", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        { success: false, error: { message: "Offline" } },
        { status: 503 },
      ),
    ),
  );
  render(wrapper(createElement(App)));
  expect(
    screen.getByRole("link", { name: "Skip to content" }).getAttribute("href"),
  ).toBe("#main");
  expect(screen.getByRole("main").id).toBe("main");
  await screen.findByText("Feed unavailable");
  expect(screen.getByRole("main").id).toBe("main");
});

it("V10 filter value changes retain the same topic colour ref", () => {
  const colour = vi.spyOn(CSSStyleDeclaration.prototype, "setProperty");
  const props = {
    counts: {
      total: 1,
      summarised: 0,
      shortlisted: 0,
      arxiv: 1,
      venues: 0,
      topics: { Vision: 1 },
      sources: { arxiv: 1 },
      venueCounts: {},
    },
    topics: ["Vision"],
    value: { topic: "" },
    onChange: vi.fn(),
  };
  const view = render(createElement(Filters, props));
  view.rerender(
    createElement(Filters, { ...props, value: { topic: "Vision" } }),
  );
  expect(
    colour.mock.calls.filter(([name]) => name === "--topic-colour"),
  ).toHaveLength(1);
});
