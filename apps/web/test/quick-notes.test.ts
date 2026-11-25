// @vitest-environment jsdom
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { QuickNotes } from "../src/QuickNotes";

// Notes are mostly written by agents over MCP; writing one by hand opens a
// Markdown editor with a preview only when asked for.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const paperId = "pap_01M7W27PQWYECYC3SXGM6QVQTG";
const json = (data: unknown) => Response.json({ success: true, data });
const note = (id: string, bodyMd: string, client: string | null) => ({
  id,
  targetId: paperId,
  bodyMd,
  client,
  origin: client ? "mcp" : "web",
  rev: 1,
  createdAt: "2026-11-21T01:00:00.000Z",
  updatedAt: "2026-11-21T01:00:00.000Z",
});
function mount(items: unknown[]) {
  const posts: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { bodyMd: string };
        posts.push(body);
        return json(note("n_new", body.bodyMd, null));
      }
      return json({ items, nextCursor: null });
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(QuickNotes, {
        paperId,
        title: "Do Deep Stereo Models Learn Shape Priors?",
      }),
    ),
  );
  return posts;
}

it("starts with how to get a note, not an empty editor", async () => {
  const writeText = vi.fn(async (_text: string) => undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  mount([]);
  const region = await screen.findByRole("region", { name: "Quick notes" });
  await within(region).findByText(/Ask Claude or Codex/);
  expect(within(region).queryByRole("textbox")).toBeNull();
  fireEvent.click(within(region).getByRole("button", { name: "Copy request" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
  const request = writeText.mock.calls[0]![0] as string;
  expect(request).toContain(paperId);
  expect(request).toContain("Do Deep Stereo Models Learn Shape Priors?");
  expect(await within(region).findByText("Copied")).toBeTruthy();
});

it("shows notes rendered, with who wrote them", async () => {
  mount([
    note(
      "n_1",
      "Key idea: **boundaries**.\n\n| a | b |\n| - | - |\n| 1 | 2 |",
      "Claude",
    ),
    note("n_2", "My own check.", null),
  ]);
  const region = await screen.findByRole("region", { name: "Quick notes" });
  expect((await within(region).findByText("boundaries")).tagName).toBe(
    "STRONG",
  );
  expect(within(region).getByRole("table")).toBeTruthy();
  expect(within(region).getByText("Claude")).toBeTruthy();
  expect(within(region).getByText("You")).toBeTruthy();
});

it("writes a note in a Markdown editor with a preview, saved with Cmd+Enter", async () => {
  const posts = mount([]);
  const region = await screen.findByRole("region", { name: "Quick notes" });
  fireEvent.click(within(region).getByRole("button", { name: "Add note" }));
  const editor = within(region).getByLabelText("Note (Markdown)");
  fireEvent.change(editor, { target: { value: "- [ ] check **Table 2**" } });
  fireEvent.click(within(region).getByRole("radio", { name: "Preview" }));
  const preview = within(region).getByRole("region", { name: "Preview" });
  expect(within(preview).getByText("Table 2").tagName).toBe("STRONG");
  expect(within(preview).getByRole("checkbox", { name: "To do" })).toBeTruthy();
  fireEvent.click(within(region).getByRole("radio", { name: "Write" }));
  fireEvent.keyDown(editor, { key: "Enter", metaKey: true });
  await waitFor(() =>
    expect(posts).toEqual([
      { target: paperId, bodyMd: "- [ ] check **Table 2**" },
    ]),
  );
  // Saved: the editor closes again.
  await waitFor(() =>
    expect(within(region).queryByLabelText("Note (Markdown)")).toBeNull(),
  );
});

it("puts the editor away with Escape without saving", async () => {
  const posts = mount([]);
  const region = await screen.findByRole("region", { name: "Quick notes" });
  fireEvent.click(within(region).getByRole("button", { name: "Add note" }));
  const editor = within(region).getByLabelText("Note (Markdown)");
  fireEvent.change(editor, { target: { value: "draft" } });
  fireEvent.keyDown(editor, { key: "Escape" });
  expect(within(region).queryByLabelText("Note (Markdown)")).toBeNull();
  expect(within(region).getByRole("button", { name: "Add note" })).toBeTruthy();
  expect(posts).toEqual([]);
});

it("shows a note's edit and delete actions as small buttons with icons", async () => {
  mount([note("n_1", "My own check.", null)]);
  const region = await screen.findByRole("region", { name: "Quick notes" });
  const edit = await within(region).findByRole("button", { name: "Edit note" });
  const remove = within(region).getByRole("button", { name: "Delete note" });
  for (const button of [edit, remove]) {
    expect(button.dataset.variant).toBe("ghost");
    expect(button.querySelector("svg[aria-hidden=true]")).toBeTruthy();
  }
  // Delete is the destructive action, in the destructive tone.
  expect(remove.className).toContain("text-destructive");
  expect(edit.className).not.toContain("text-destructive");
});

it("holds the empty state's space while notes load, so the card does not jump", async () => {
  mount([]);
  // Before the answer: the loader sits over a hidden copy of the empty state.
  const reserve = document.querySelector<HTMLElement>(
    '[data-slot="notes-reserve"]',
  )!;
  expect(reserve.getAttribute("aria-hidden")).toBe("true");
  expect(reserve.hasAttribute("inert")).toBe(true);
  expect(reserve.className).toContain("invisible");
  expect(reserve.textContent).toContain("No notes yet");
  expect(screen.getByText("Loading notes…")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Copy request" })).toBeNull();
  // After it: the real empty state, and nothing held back.
  await screen.findByRole("button", { name: "Copy request" });
  expect(document.querySelector('[data-slot="notes-reserve"]')).toBeNull();
  expect(screen.queryByText("Loading notes…")).toBeNull();
});
