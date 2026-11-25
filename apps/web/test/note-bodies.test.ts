// @vitest-environment jsdom
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Projects } from "../src/Projects";
import { obsidianMarkdown, withoutTitle } from "../src/VaultNote";

// Project, idea and draft notes read read-only on the web. The body is
// fetched only when opened; a note without an uploaded body says where its
// text lives.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const json = (data: unknown) => Response.json({ success: true, data });
const project = "a".repeat(64);
function mount(element: ReturnType<typeof createElement>) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(MemoryRouter, {}, element),
    ),
  );
}
function stub(bodyMd: string | null) {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/vault/notes/"))
      return json({
        id: project,
        kind: "project",
        title: "Stereo project",
        path: "Projects/Stereo.md",
        bodyMd,
      });
    if (url.includes("/vault/info"))
      return json({ name: "Lab", configured: true });
    return json({
      next: null,
      items: [
        {
          id: project,
          title: "Stereo project",
          status: "active",
          summary: null,
          path: "Projects/Stereo.md",
          ideas: [],
          papers: [],
          radar: [],
        },
      ],
    });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const noteCalls = (fetch: ReturnType<typeof stub>) =>
  fetch.mock.calls.filter(([url]) => String(url).includes("/vault/notes/"));

it("reads a project note on demand, in the project's Note section", async () => {
  const fetch = stub("## Plan\n\n- Read the **depth** papers");
  mount(createElement(Projects));
  const link = await screen.findByRole("link", { name: "Note" });
  expect(noteCalls(fetch)).toHaveLength(0);
  fireEvent.click(link);
  const pane = screen.getByRole("region", { name: "Project: Stereo project" });
  expect(
    await within(pane).findByRole("heading", { name: "Plan" }),
  ).toBeTruthy();
  expect(within(pane).getByText("depth").tagName).toBe("STRONG");
  expect(String(noteCalls(fetch)[0]![0])).toContain("/vault/notes/" + project);
  expect(link.getAttribute("aria-current")).toBe("page");
});

it("drops a first heading that repeats the note's title", () => {
  expect(withoutTitle("# Stereo project\n\n## Plan", "Stereo Project")).toBe(
    "## Plan",
  );
  expect(withoutTitle("# Other\n\nText", "Stereo project")).toBe(
    "# Other\n\nText",
  );
  expect(withoutTitle("Text first", "Text first")).toBe("Text first");
  expect(withoutTitle("# C#\r\nBody", "C#")).toBe("Body");
  expect(withoutTitle("# **Stereo** project #\n\nBody", "Stereo project")).toBe(
    "Body",
  );
  // A second-level heading or an indented code line is not the title.
  expect(withoutTitle("## Stereo project\n\nBody", "Stereo project")).toBe(
    "## Stereo project\n\nBody",
  );
  expect(withoutTitle("    # Stereo project", "Stereo project")).toBe(
    "    # Stereo project",
  );
});

it("explains a note whose text stays in the vault", async () => {
  stub(null);
  mount(createElement(Projects));
  fireEvent.click(await screen.findByRole("link", { name: "Note" }));
  expect(
    await screen.findByText(/body upload is off or the note is excluded/),
  ).toBeTruthy();
});

it("shows Obsidian links and embeds as plain names", () => {
  expect(
    obsidianMarkdown(
      "See [[Ideas/Depth idea|the idea]], [[Folder/Plan.md#Goals]] and ![[Figure.png]].",
    ),
  ).toBe("See the idea, Plan and *Figure.png*.");
  // Code keeps its brackets.
  expect(
    obsidianMarkdown(
      "Use `[[Note]]` here:\n\n```\n[[Kept]]\n```\n\nthen [[Folder/Changed]].",
    ),
  ).toBe("Use `[[Note]]` here:\n\n```\n[[Kept]]\n```\n\nthen Changed.");
});
