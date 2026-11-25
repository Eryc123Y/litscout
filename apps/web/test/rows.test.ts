// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createElement, createRef } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ListPaper } from "@litscout/pipeline/read-contracts";
import { PaperList } from "../src/FeedParts";

afterEach(cleanup);

function paper(id: string, readAt: string | null | undefined): ListPaper {
  return {
    paperId: id,
    title: `Paper ${id}`,
    authors: [{ name: "A. Author" }],
    authorCount: 1,
    topics: ["Vision"],
    identifiers: [],
    venue: null,
    venueKind: "preprint",
    source: "arxiv",
    year: 2026,
    publishedOn: "2026-11-17",
    categories: ["cs.CV"],
    hfUpvotes: null,
    shortlisted: false,
    tldr: [{ lang: "en", text: `Summary of ${id}` }],
    ...(readAt !== undefined && { readingState: { readAt } }),
  };
}

function list(
  selected?: ListPaper,
  papers = [paper("a", null), paper("b", "2026-11-17T09:00:00Z")],
) {
  render(
    createElement(PaperList, {
      papers,
      selected: selected ?? papers[1],
      language: "en",
      topics: ["Vision"],
      status: "final",
      onOpen: vi.fn(),
      listRef: createRef<HTMLElement>(),
    } as never),
  );
  const rows = screen.getAllByRole("button", { name: /Read Paper / });
  return { unread: rows[0]!, read: rows[1]! };
}

it("fades a read paper's whole row and adds no mark to either kind", () => {
  // The first paper is open, so the read one is an ordinary row.
  const papers = [paper("a", null), paper("b", "2026-11-17T09:00:00Z")];
  const { unread, read } = list(papers[0], papers);
  expect(unread.getAttribute("aria-description")).toBe("Unread");
  expect(read.getAttribute("aria-description")).toBe("Read");
  // style.css fades the children of a row that carries data-read.
  expect(read.hasAttribute("data-read")).toBe(true);
  expect(unread.hasAttribute("data-read")).toBe(false);
  // No dot, no check and no empty gutter: the fade is the whole signal.
  for (const row of [unread, read]) {
    expect(row.querySelector('[data-slot="unread-dot"]')).toBeNull();
    expect(row.querySelector('[data-slot="read-mark"]')).toBeNull();
    expect(row.querySelector('[data-slot="row-gutter"]')).toBeNull();
    expect(row.querySelector("svg")).toBeNull();
  }
  // Same weight and colour either way, so a row keeps its height when its
  // paper is opened and becomes read.
  expect(read.querySelector("strong")?.className).toBe(
    unread.querySelector("strong")?.className,
  );
});

it("fades read rows in the stylesheet, except the open, hovered or focused one", () => {
  const css = readFileSync(resolve(__dirname, "../src/style.css"), "utf8");
  const rule =
    /\.reader-row\[data-read\]:not\(([^)]*)\)\s*>\s*\*\s*\{([^}]*)\}/.exec(css);
  expect(rule?.[1]).toContain('[aria-current="true"]');
  expect(rule?.[1]).toContain(":hover");
  expect(rule?.[1]).toContain(":focus-visible");
  expect(rule?.[2]).toMatch(/opacity:\s*var\(--read-fade\)/);
  expect(css).toMatch(/--read-fade:\s*0\.45/);
});

it("highlights the open paper with a neutral rounded fill, no side bar", () => {
  const { unread, read } = list();
  expect(read.getAttribute("aria-current")).toBe("true");
  for (const row of [unread, read]) {
    expect(row.className).toContain("aria-current:bg-row-on");
    expect(row.className).not.toMatch(/border-l|bg-accent/);
  }
});

it("shows topics as a dot and a muted name", () => {
  const { unread } = list();
  const topic = within(unread).getByText("Vision");
  expect(topic.className).toContain("text-muted-foreground");
  expect(topic.querySelector('[data-slot="topic-dot"]')).not.toBeNull();
});

it("fetches a paper when the pointer rests on its row, is pressed on it, or focus reaches it", () => {
  vi.useFakeTimers();
  try {
    const onIntent = vi.fn();
    const papers = [paper("a", null), paper("b", null)];
    render(
      createElement(PaperList, {
        papers,
        language: "en",
        topics: ["Vision"],
        status: "final",
        onOpen: vi.fn(),
        onIntent,
        listRef: createRef<HTMLElement>(),
      } as never),
    );
    const [first, second] = screen.getAllByRole("button", {
      name: /Read Paper /,
    }) as [HTMLElement, HTMLElement];
    // Passing over a row on the way down the list fetches nothing.
    fireEvent.pointerEnter(first);
    vi.advanceTimersByTime(60);
    fireEvent.pointerLeave(first);
    vi.advanceTimersByTime(200);
    expect(onIntent).not.toHaveBeenCalled();
    // Resting on it does.
    fireEvent.pointerEnter(first);
    vi.advanceTimersByTime(100);
    expect(onIntent).toHaveBeenCalledExactlyOnceWith(papers[0]);
    // A press or keyboard focus does not wait.
    fireEvent.pointerDown(second);
    expect(onIntent).toHaveBeenLastCalledWith(papers[1]);
    onIntent.mockClear();
    fireEvent.focus(first);
    expect(onIntent).toHaveBeenCalledExactlyOnceWith(papers[0]);
  } finally {
    vi.useRealTimers();
  }
});

it("plays the page entrance on the page frame, not on each page's main", () => {
  const css = readFileSync(resolve(__dirname, "../src/style.css"), "utf8");
  // A loading page and the page that replaces it are two <main> elements:
  // an entrance on main played twice. The frame is there once per visit.
  expect(css).toMatch(/\.page-enter\s*\{\s*animation:\s*page-in/);
  expect(css).not.toMatch(/main\.reader-page\s*\{\s*animation/);
});

it("lists four authors on a row however many the record names", () => {
  const long = {
    ...paper("a", null),
    authors: ["A", "B", "C", "D", "E", "F"].map((name) => ({ name })),
    authorCount: 9,
  };
  render(
    createElement(PaperList, {
      papers: [long],
      language: "en",
      topics: ["Vision"],
      status: "final",
      onOpen: vi.fn(),
      listRef: createRef<HTMLElement>(),
    } as never),
  );
  const row = screen.getByRole("button", { name: /Read Paper a/ });
  expect(within(row).getByText(/A, B, C, D \+5/)).toBeTruthy();
  expect(row.textContent).not.toContain("E, F");
});
