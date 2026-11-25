// @vitest-environment jsdom
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Projects, orderProjects } from "../src/Projects";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (data: unknown) => Response.json({ success: true, data });
const hash = (c: string) => c.repeat(64);
const lean = {
  id: hash("b"),
  title: "Lean agent",
  status: "planning",
  summary: null,
  path: "Projects/Lean.md",
  ideas: [],
  papers: [],
  radar: [
    {
      id: "rad_lean",
      paperId: "pap_sorry",
      title: "From Sorry to QED",
      day: "2026-11-18",
      level: "borrow",
      reason: "Repairs Lean proofs",
    },
  ],
};
const quiet = {
  id: hash("a"),
  title: "Quiet partner project",
  status: "active",
  summary: null,
  path: "Projects/Quiet.md",
  ideas: [],
  papers: [],
  radar: [],
};
const ablation = {
  id: hash("c"),
  title: "Ablation project",
  status: "active",
  summary: "Supervision and data reuse",
  path: "Projects/Ablation.md",
  ideas: [{ id: hash("d"), title: "Batch echoing", path: "Ideas/Echo.md" }],
  papers: [{ id: "pap_linked", title: "Linked paper" }],
  radar: [
    {
      id: "rad_old",
      paperId: "pap_old",
      title: "Older hit",
      day: "2026-11-18",
      level: "borrow",
      reason: "Ideal observer",
    },
    {
      id: "rad_new",
      paperId: "pap_new",
      title: "Budget Internalization",
      day: "2026-11-20",
      level: "medium",
      reason: "Rollout caps",
    },
  ],
};

function stub() {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/vault/notes/"))
      return json({
        id: ablation.id,
        kind: "project",
        title: "Ablation project",
        path: "Projects/Ablation.md",
        bodyMd: "# Ablation project\n\n## Plan\n\nReuse the **records**.",
      });
    if (url.includes("/vault/info"))
      return json({ name: "Lab", configured: true });
    if (url.endsWith("/instance"))
      return json({
        name: "LitScout",
        publicFeed: true,
        language: "en",
        timezone: "UTC",
        topics: [],
      });
    if (url.includes("/papers/")) return new Response(null, { status: 404 });
    return json({ next: null, items: [quiet, lean, ablation] });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

let location = "";
function Spy() {
  const at = useLocation();
  location = at.pathname + at.search;
  return null;
}
function mount(path = "/app/projects") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
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
            path: "/app/projects",
            element: createElement(
              "div",
              null,
              createElement(Projects),
              createElement(Spy),
            ),
          }),
        ),
      ),
    ),
  );
}
const list = () =>
  within(screen.getByRole("navigation", { name: "Projects list" }));
const detail = () =>
  within(screen.getByRole("region", { name: /^Project: |^Paper$|^Note$/ }));

it("puts the page title on the page, above the two columns", async () => {
  stub();
  mount();
  await screen.findByRole("link", { name: /^Ablation project/ });
  const title = screen.getByRole("heading", { name: "Projects", level: 1 });
  // Not inside the list column: every page's title sits in the same place.
  expect(title.closest(".reader-list-pane")).toBeNull();
  const main = screen.getByRole("main");
  expect(main.className).toContain("reader-workspace");
  expect(main.querySelector(":scope > .reader-split")).not.toBeNull();
  expect(
    main
      .querySelector(".reader-list-pane")!
      .contains(screen.getByRole("navigation", { name: "Projects list" })),
  ).toBe(true);
});

it("orders active projects first, then by their latest radar hit", () => {
  expect(orderProjects([quiet, lean, ablation]).map((p) => p.title)).toEqual([
    "Ablation project",
    "Quiet partner project",
    "Lean agent",
  ]);
});

it("lists projects beside the selected one, grouped by status", async () => {
  stub();
  mount();
  const row = await screen.findByRole("link", { name: /^Ablation project/ });
  expect(row.getAttribute("aria-current")).toBe("true");
  expect(row.textContent).toContain("2 radar hits");
  expect(list().getByText("Active")).toBeTruthy();
  expect(list().getByText("Planning")).toBeTruthy();
  expect(
    list().getByRole("link", { name: /^Quiet partner project/ }).textContent,
  ).toContain("No radar hits");
  // The first project opens on its radar, newest day first, with levels.
  const pane = detail();
  expect(
    pane.getByRole("heading", { level: 2, name: "Ablation project" }),
  ).toBeTruthy();
  expect(pane.getByText("Supervision and data reuse")).toBeTruthy();
  const days = pane.getAllByRole("heading", { level: 3 });
  expect(days.map((d) => d.textContent)).toEqual([
    "20 Nov 2026",
    "18 Nov 2026",
  ]);
  expect(pane.getByText("Medium")).toBeTruthy();
  expect(pane.getByText("Rollout caps")).toBeTruthy();
  expect(
    (await pane.findByRole("link", { name: "Open in Obsidian" })).getAttribute(
      "title",
    ),
  ).toBe("Projects/Ablation.md");
});

it("shows a quiet project without empty columns", async () => {
  stub();
  mount();
  fireEvent.click(
    await screen.findByRole("link", { name: /^Quiet partner project/ }),
  );
  await waitFor(() => expect(location).toContain("project=" + quiet.id));
  const pane = detail();
  expect(pane.getByText(/No radar hits in the last 90 days/)).toBeTruthy();
  expect(pane.queryByText("No linked papers.")).toBeNull();
});

it("switches between radar, papers, ideas and the note", async () => {
  const fetch = stub();
  mount();
  await screen.findByRole("link", { name: /^Ablation project/ });
  const sections = within(
    screen.getByRole("navigation", { name: "Project sections" }),
  );
  expect(
    sections
      .getByRole("link", { name: "Radar 2" })
      .getAttribute("aria-current"),
  ).toBe("page");
  fireEvent.click(sections.getByRole("link", { name: "Papers 1" }));
  expect(
    await screen.findByRole("link", { name: "Linked paper" }),
  ).toBeTruthy();
  fireEvent.click(sections.getByRole("link", { name: "Ideas 1" }));
  expect(
    await screen.findByRole("link", { name: "Batch echoing" }),
  ).toBeTruthy();
  const noteCalls = () =>
    fetch.mock.calls.filter(([url]) => String(url).includes("/vault/notes/"));
  expect(noteCalls()).toHaveLength(0);
  fireEvent.click(sections.getByRole("link", { name: "Note" }));
  expect(await screen.findByRole("heading", { name: "Plan" })).toBeTruthy();
  expect(screen.getByText("records").tagName).toBe("STRONG");
  // The note's own title line is not repeated under the project heading.
  expect(
    screen.getAllByRole("heading", { name: "Ablation project" }),
  ).toHaveLength(1);
  expect(location).toContain("tab=note");
});

it("reads a radar paper in place and goes back to the project", async () => {
  stub();
  mount();
  const pane = await screen.findByRole("region", {
    name: "Project: Ablation project",
  });
  fireEvent.click(
    within(pane).getByRole("link", { name: /Budget Internalization/ }),
  );
  await waitFor(() => expect(location).toContain("open=paper%3Apap_new"));
  const back = await screen.findByRole("button", {
    name: "Back to Ablation project",
  });
  expect(
    await screen.findByText("This paper is no longer in LitScout."),
  ).toBeTruthy();
  fireEvent.click(back);
  await waitFor(() => expect(location).not.toContain("open="));
  expect(
    await screen.findByRole("region", { name: "Project: Ablation project" }),
  ).toBeTruthy();
});

it("closes an open paper with Escape and keeps the address tidy", async () => {
  stub();
  mount(`/app/projects?project=${ablation.id}&open=paper%3Apap_new`);
  expect(
    await screen.findByRole("button", { name: "Back to Ablation project" }),
  ).toBeTruthy();
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(location).not.toContain("open="));
  expect(location).toContain("project=" + ablation.id);
});

it("pins the first project in the address and drops one it cannot find", async () => {
  stub();
  mount();
  await screen.findByRole("link", { name: /^Ablation project/ });
  await waitFor(() => expect(location).toContain("project=" + ablation.id));
  cleanup();
  mount(`/app/projects?project=${hash("f")}&tab=papers`);
  await waitFor(() =>
    expect(location).toBe("/app/projects?project=" + ablation.id),
  );
  expect(
    await screen.findByRole("region", { name: "Project: Ablation project" }),
  ).toBeTruthy();
});

it("looks for a project named in the address on the next page", async () => {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/vault/info"))
      return json({ name: "Lab", configured: true });
    return url.includes("after=")
      ? json({ next: null, items: [lean] })
      : json({ next: ablation.id, items: [quiet, ablation] });
  });
  vi.stubGlobal("fetch", fetch);
  mount(`/app/projects?project=${lean.id}`);
  expect(
    await screen.findByRole("region", { name: "Project: Lean agent" }),
  ).toBeTruthy();
  expect(location).toContain("project=" + lean.id);
});

it("opens an idea's note in place from the Ideas section", async () => {
  stub();
  mount(`/app/projects?project=${ablation.id}&tab=ideas`);
  fireEvent.click(await screen.findByRole("link", { name: "Batch echoing" }));
  await waitFor(() => expect(location).toContain("open=note%3A" + hash("d")));
  expect(
    await screen.findByRole("button", { name: "Back to Ablation project" }),
  ).toBeTruthy();
});

it("on a phone, shows the list first and the project on its own", async () => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(width < 48rem)",
    addEventListener() {},
    removeEventListener() {},
  }));
  stub();
  mount();
  fireEvent.click(await screen.findByRole("link", { name: /^Lean agent/ }));
  await screen.findByRole("button", { name: "Back to projects" });
  expect(
    screen.queryByRole("navigation", { name: "Projects list" }),
  ).toBeNull();
  expect(
    screen.getByRole("heading", { level: 2, name: "Lean agent" }),
  ).toBeTruthy();
  // A paper opened from the project goes back to the project first.
  fireEvent.click(
    await screen.findByRole("link", { name: /From Sorry to QED/ }),
  );
  // The reading bar's button comes first; the column's own one is hidden
  // on a phone by CSS, which jsdom does not apply.
  const [up] = await screen.findAllByRole("button", {
    name: "Back to Lean agent",
  });
  fireEvent.click(up!);
  await waitFor(() => expect(location).not.toContain("open="));
  fireEvent.click(
    await screen.findByRole("button", { name: "Back to projects" }),
  );
  await waitFor(() => expect(location).not.toContain("project="));
  expect(
    await screen.findByRole("navigation", { name: "Projects list" }),
  ).toBeTruthy();
});
