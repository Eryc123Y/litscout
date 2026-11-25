// @vitest-environment jsdom
import { createElement as h } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { PaperIdeaActions } from "../src/IdeaActions";
import { Suggestions } from "../src/Suggestions";

afterEach(cleanup);
beforeEach(() =>
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })),
);
const first = "a".repeat(64);
const work = "b".repeat(64);
const day = "2026-11-18";
const json = (data: unknown) => Response.json({ success: true, data });
const idea = {
  id: first,
  title: "Stereo idea",
  path: "Ideas/A & B.md",
  status: "seed",
  description: "Monocular depth proposal",
  projectId: null,
  projectTitle: "Vision project",
  paperIds: ["pap_fixture"],
};
function mount(element: ReturnType<typeof h>, route = "/app/ideas") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    h(
      QueryClientProvider,
      { client },
      h(MemoryRouter, { initialEntries: [route] }, element),
    ),
  );
}
const instance = {
  name: "Fixture",
  language: "en",
  timezone: "UTC",
  topics: [],
  publicFeed: true,
};

it("moves idea cards, shows their Obsidian links, and edits and cancels queued captures", async () => {
  let statusRequest: unknown = null;
  let captures = [
    {
      id: "req_draft",
      title: "Draft",
      body: "Short body",
      paperTitle: null,
      applying: false,
    },
  ];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace("/api/v1", "");
    if (path === "/instance") return json(instance);
    if (path === "/vault/info") return json({ name: "Example Vault & Notes" });
    if (path.startsWith("/suggestions?"))
      return json({ items: [], next: null });
    if (path === "/ideas")
      return json({ items: [{ ...idea, statusRequest }], next: null });
    if (path === "/vault/captures") return json(captures);
    if (path === "/vault/requests" && init?.method === "POST") {
      expect(JSON.parse(String(init.body))).toEqual({
        kind: "set_status",
        targetNoteId: first,
        status: "exploring",
      });
      statusRequest = {
        id: "req_move",
        state: "queued",
        status: "exploring",
        reason: null,
      };
      return json({ id: "req_move", state: "queued" });
    }
    if (
      path.startsWith("/vault/requests/req_move") &&
      init?.method === "DELETE"
    ) {
      statusRequest = null;
      return json({ cancelled: true });
    }
    if (path === "/vault/requests/req_draft" && init?.method === "PATCH") {
      captures = [{ ...captures[0]!, ...JSON.parse(String(init.body)) }];
      return json({ edited: true });
    }
    if (path === "/vault/requests/req_draft" && init?.method === "DELETE") {
      captures = [];
      return json({ cancelled: true });
    }
    return json(null);
  });
  vi.stubGlobal("fetch", fetcher);
  mount(h(App));
  const card = await screen.findByText(idea.title);
  expect(card).toBeTruthy();
  expect(screen.getByText("1 paper · Vision project")).toBeTruthy();
  const link = await screen.findByRole("link", { name: "Open in Obsidian" });
  expect(link.getAttribute("href")).toBe(
    "obsidian://open?vault=Example%20Vault%20%26%20Notes&file=Ideas%2FA%20%26%20B.md",
  );
  // Move to lives in the card's menu, not in a select on every card.
  expect(screen.queryByRole("combobox", { name: /^Move / })).toBeNull();
  const actions = screen.getByRole("button", {
    name: "Actions for Stereo idea",
  });
  actions.focus();
  fireEvent.click(actions);
  expect(screen.queryByRole("button", { name: "Move to Seed" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Move to Exploring" }));
  await within(
    await screen.findByRole("region", { name: /Exploring/ }),
  ).findByText(/Waiting for sync/i);
  await waitFor(() =>
    expect(
      screen.getByRole("status", { name: "Page updates" }).textContent,
    ).toBe("Idea move requested. Waiting for sync."),
  );

  const cancelMove = screen.getByRole("button", {
    name: "Cancel move for Stereo idea",
  });
  expect(cancelMove).toBe(document.activeElement);
  fireEvent.click(cancelMove);
  await within(screen.getByRole("region", { name: /Seed/ })).findByText(
    idea.title,
  );
  expect(
    screen.queryByRole("button", { name: "Cancel move for Stereo idea" }),
  ).toBeNull();

  fireEvent.click(
    screen.getByRole("button", { name: "Edit before sync: Draft" }),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
    target: { value: "Edited draft" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save capture" }));
  await screen.findByText("Edited draft");
  fireEvent.click(screen.getByRole("button", { name: "Cancel Edited draft" }));
  await screen.findByText("No captures waiting.");
});

it("keeps keyboard focus through a grip drag and cancels a pick-up on blur", async () => {
  let statusRequest: unknown = null;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace("/api/v1", "");
    if (path === "/instance") return json(instance);
    if (path === "/vault/info") return json({ name: "Example Vault" });
    if (path.startsWith("/suggestions?"))
      return json({ items: [], next: null });
    if (path === "/ideas")
      return json({ items: [{ ...idea, statusRequest }], next: null });
    if (path === "/vault/captures") return json([]);
    expect(path).toBe("/vault/requests");
    expect(init?.method).toBe("POST");
    statusRequest = {
      id: "req_move",
      state: "queued",
      status: "exploring",
      reason: null,
    };
    return json({ id: "req_move", state: "queued" });
  });
  vi.stubGlobal("fetch", fetcher);
  mount(h(App));
  const grip = await screen.findByRole("button", { name: "Drag Stereo idea" });
  const updates = () =>
    screen.getByRole("status", { name: "Page updates" }).textContent;
  // Leaving the grip puts a lifted card back.
  grip.focus();
  fireEvent.keyDown(grip, { key: " " });
  expect(grip.getAttribute("aria-pressed")).toBe("true");
  fireEvent.blur(grip);
  expect(grip.getAttribute("aria-pressed")).toBe("false");
  await waitFor(() => expect(updates()).toBe("Move cancelled."));
  // A keyboard drop lands focus on the moved card's Cancel button.
  grip.focus();
  fireEvent.keyDown(grip, { key: " " });
  fireEvent.keyDown(grip, { key: "ArrowRight" });
  fireEvent.keyDown(grip, { key: " " });
  const cancelMove = await screen.findByRole("button", {
    name: "Cancel move for Stereo idea",
  });
  await waitFor(() => expect(cancelMove).toBe(document.activeElement));
});

it("shows the columns as tabs on a phone and follows a move to its tab", async () => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(width < 48rem)",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  let statusRequest: unknown = null;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace("/api/v1", "");
    if (path === "/instance") return json(instance);
    if (path === "/vault/info") return json({ name: "Example Vault" });
    if (path.startsWith("/suggestions?"))
      return json({ items: [], next: null });
    if (path === "/ideas")
      return json({ items: [{ ...idea, statusRequest }], next: null });
    if (path === "/vault/captures") return json([]);
    if (path.startsWith("/vault/requests/req_move")) {
      expect(init?.method).toBe("DELETE");
      statusRequest = null;
      return json({ cancelled: true });
    }
    expect(path).toBe("/vault/requests");
    statusRequest = {
      id: "req_move",
      state: "queued",
      status: "exploring",
      reason: null,
    };
    return json({ id: "req_move", state: "queued" });
  });
  vi.stubGlobal("fetch", fetcher);
  mount(h(App));
  const tabs = within(
    await screen.findByRole("tablist", { name: "Idea status" }),
  );
  const tab = (name: string) => tabs.getByRole("tab", { name });
  await waitFor(() =>
    expect(tabs.getAllByRole("tab").map((item) => item.textContent)).toEqual([
      "Seed 1",
      "Exploring 0",
      "In a working paper 0",
      "Parked 0",
    ]),
  );
  // Only the selected column shows, as the tab's panel.
  expect(tab("Seed 1").getAttribute("aria-selected")).toBe("true");
  expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
  const panel = screen.getByRole("tabpanel", { name: "Seed 1" });
  expect(within(panel).getByText(idea.title)).toBeTruthy();
  // Arrow keys and Home move between tabs.
  tab("Seed 1").focus();
  fireEvent.keyDown(tab("Seed 1"), { key: "ArrowRight" });
  expect(tab("Exploring 0").getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(tab("Exploring 0"));
  fireEvent.keyDown(tab("Exploring 0"), { key: "Home" });
  expect(tab("Seed 1").getAttribute("aria-selected")).toBe("true");
  // A lifted card marks the tab it would land on.
  const grip = screen.getByRole("button", { name: "Drag " + idea.title });
  grip.focus();
  fireEvent.keyDown(grip, { key: " " });
  fireEvent.keyDown(grip, { key: "ArrowRight" });
  expect(tab("Exploring 0").hasAttribute("data-drop-target")).toBe(true);
  expect(screen.getByText(/^Drop on/).textContent).toBe(
    "Drop on Exploring to move it there",
  );
  // The view follows the drop, with focus on the moved card's Cancel.
  fireEvent.keyDown(grip, { key: " " });
  const cancel = await screen.findByRole("button", {
    name: "Cancel move for " + idea.title,
  });
  await waitFor(() => expect(cancel).toBe(document.activeElement));
  expect(tab("Exploring 1").getAttribute("aria-selected")).toBe("true");
  // Cancelling opens the card's own column again, with focus on its menu.
  fireEvent.click(cancel);
  const actions = await screen.findByRole("button", {
    name: "Actions for " + idea.title,
  });
  await waitFor(() => expect(actions).toBe(document.activeElement));
  expect(tab("Seed 1").getAttribute("aria-selected")).toBe("true");
});

it("keeps a phone's tabs in reach and stays put when a cancel fails", async () => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(width < 48rem)",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  const statusRequest = {
    id: "req_move",
    state: "queued",
    status: "exploring",
    reason: null,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = url.replace("/api/v1", "");
      if (path === "/instance") return json(instance);
      if (path === "/vault/info") return json({ name: "Example Vault" });
      if (path.startsWith("/suggestions?"))
        return json({ items: [], next: null });
      if (path === "/ideas")
        return json({ items: [{ ...idea, statusRequest }], next: null });
      if (path === "/vault/captures") return json([]);
      if (path.startsWith("/vault/requests/req_move"))
        return Response.json(
          { success: false, error: "Network unavailable" },
          { status: 503 },
        );
      return json(null);
    }),
  );
  mount(h(App));
  const tablist = await screen.findByRole("tablist", { name: "Idea status" });
  // The tabs stay on screen while a long column scrolls (drop targets).
  expect(tablist.className).toMatch(/\bsticky\b/);
  const tabs = within(tablist);
  fireEvent.click(await tabs.findByRole("tab", { name: "Exploring 1" }));
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Cancel move for " + idea.title,
    }),
  );
  // The cancel failed, so the card is still in Exploring and so is the view.
  await screen.findByRole("alert");
  expect(
    tabs
      .getByRole("tab", { name: "Exploring 1" })
      .getAttribute("aria-selected"),
  ).toBe("true");
});

it("says when vault writes are off, so moves stay as requests", async () => {
  const at = "2026-11-18T03:00:00.000Z";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = url.replace("/api/v1", "");
      if (path === "/instance") return json(instance);
      if (path === "/vault/info") return json({ name: "Example Vault" });
      if (path.startsWith("/suggestions?"))
        return json({ items: [], next: null });
      if (path === "/ideas") return json({ items: [idea], next: null });
      if (path === "/vault/captures") return json([]);
      if (path === "/vault/status")
        return json({
          last: {
            at,
            writeEnabled: false,
            counts: {
              project: 0,
              idea: 1,
              working_paper: 0,
              paper_note: 0,
              brief: 0,
            },
            writes: [],
            handEdited: [],
            issues: [],
          },
          queued: [],
          rejected: [],
          queuedCount: 0,
        });
      return json(null);
    }),
  );
  mount(h(App));
  const notice = await screen.findByText(/Vault writes are off/);
  expect(notice.closest("p")?.textContent).toContain(
    "Moves and captures are kept here until a sync with vault writes on applies them.",
  );
  expect(
    within(notice.closest("p")!)
      .getByRole("link", { name: "Vault sync" })
      .getAttribute("href"),
  ).toBe("/app/vault");
});

it("clears a rejected move from its card", async () => {
  let statusRequest: unknown = {
    id: "req_rejected",
    state: "rejected",
    status: "exploring",
    reason: "Note changed",
  };
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace("/api/v1", "");
    if (path === "/instance") return json(instance);
    if (path === "/vault/info") return json({ name: "Example Vault" });
    if (path.startsWith("/suggestions?"))
      return json({ items: [], next: null });
    if (path === "/ideas")
      return json({ items: [{ ...idea, statusRequest }], next: null });
    if (path === "/vault/captures") return json([]);
    expect(path).toBe("/vault/requests/req_rejected?clear=rejected");
    expect(init?.method).toBe("DELETE");
    statusRequest = null;
    return json({ cleared: true });
  });
  vi.stubGlobal("fetch", fetcher);
  mount(h(App));
  await screen.findByText(/Sync rejected the move. Note changed/);
  fireEvent.click(
    screen.getByRole("button", { name: "Clear rejected move for Stereo idea" }),
  );
  await within(screen.getByRole("region", { name: /Seed/ })).findByRole(
    "button",
    { name: "Actions for Stereo idea" },
  );
  await vi.waitFor(() =>
    expect(screen.queryByText(/Sync rejected the move/)).toBeNull(),
  );
});

it("queues capture and link from a paper and remembers each waiting state", async () => {
  const sent: unknown[] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/vault/paper-note/pap_fixture"))
      return json({
        path: null,
        pending: false,
        capturePending: sent.length >= 1,
        linkPending: sent.length === 2,
      });
    if (url.endsWith("/ideas")) return json({ items: [idea], next: null });
    expect(url).toBe("/api/v1/vault/requests");
    sent.push(JSON.parse(String(init?.body)));
    return json({ id: "req_paper", state: "queued" });
  });
  vi.stubGlobal("fetch", fetcher);
  mount(h(PaperIdeaActions, { paperId: "pap_fixture", primary: true }));
  fireEvent.click(screen.getByRole("button", { name: "Capture idea" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
    target: { value: "Follow-up" },
  });
  fireEvent.change(
    screen.getByRole("textbox", { name: "Note (Markdown, optional)" }),
    { target: { value: "Try the baseline" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Queue capture" }));
  await screen.findByText("Capture waiting for sync");
  fireEvent.click(screen.getByRole("button", { name: "Link to an idea" }));
  await screen.findByRole("option", { name: /Stereo idea/ });
  const picker = screen.getByRole("combobox", { name: "Idea" });
  fireEvent.change(picker, { target: { value: first } });
  fireEvent.click(screen.getByRole("button", { name: "Queue link" }));
  await screen.findByText("Link waiting for sync");
  expect(sent).toEqual([
    {
      kind: "capture",
      title: "Follow-up",
      body: "Try the baseline",
      paperId: "pap_fixture",
    },
    { kind: "link_paper", targetNoteId: first, paperId: "pap_fixture" },
  ]);
});

it("shows ordered ideas and a pending reading-list addition", async () => {
  let pending = false;
  const summary = {
    id: work,
    title: "Stereo draft",
    status: "drafting",
    projectTitle: "Vision",
    path: "Research/Draft.md",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/instance")) return json(instance);
      if (url.endsWith("/vault/info")) return json({ name: "Vault" });
      if (url.endsWith("/working-papers"))
        return json({ items: [summary], next: null });
      if (url.endsWith("/working-papers/" + work))
        return json({
          ...summary,
          ideas: [
            { id: work, title: "Second named idea", path: "Second.md" },
            idea,
          ],
          reading: [
            {
              id: "pap_baseline",
              title: "Existing paper",
              status: "reading",
              vaultPath: "Papers/Existing.md",
              ideaIds: [first],
              pending: false,
            },
            ...(pending
              ? [
                  {
                    id: "pap_candidate",
                    title: "Related paper",
                    status: null,
                    vaultPath: null,
                    ideaIds: [],
                    pending: true,
                  },
                ]
              : []),
          ],
          readingMore: 7,
          recent: pending
            ? []
            : [
                {
                  id: "pap_candidate",
                  title: "Related paper",
                  pending: false,
                  day,
                  source: "arxiv",
                  topics: ["Vision"],
                },
              ],
        });
      if (url.endsWith("/vault/requests")) {
        expect(JSON.parse(String(init?.body))).toEqual({
          kind: "add_reading",
          targetNoteId: work,
          paperId: "pap_candidate",
        });
        pending = true;
        return json({ id: "req_add", state: "queued" });
      }
      return json(null);
    }),
  );
  mount(h(App), "/app/working-papers");
  fireEvent.click(await screen.findByRole("link", { name: "Stereo draft" }));
  const ideas = await screen.findByRole("region", {
    name: "Its ideas, in the note’s order",
  });
  expect(
    within(ideas)
      .getAllByRole("listitem")
      .map((entry) => entry.textContent),
  ).toEqual(["Second named idea", "Stereo idea"]);
  expect(await screen.findByText("Vault note")).toBeTruthy();
  expect(screen.getByText("7 more papers")).toBeTruthy();
  expect(
    (
      await screen.findByRole("link", { name: "Write in Obsidian" })
    ).getAttribute("href"),
  ).toContain("file=Research%2FDraft.md");
  fireEvent.click(screen.getByRole("button", { name: "Add to reading list" }));
  await within(screen.getByRole("region", { name: "Reading list" })).findByText(
    "Waiting for sync",
  );
  await waitFor(() =>
    expect(
      screen.getByRole("status", { name: "Page updates" }).textContent,
    ).toBe("Reading list addition requested. Waiting for sync."),
  );
});

it("accepts one suggestion and removes a dismissed one", async () => {
  const common = {
    day,
    bodyMd: "Use the evaluation protocol.",
    ideaIds: [first],
    projectIds: [],
    paperIds: ["pap_fixture"],
    status: "new",
    resolvedAt: null,
    requestId: null,
    requestState: null,
  };
  let items = [
    {
      ...common,
      id: "sg_link",
      kind: "paper_for_idea",
      title: "Connect the paper",
    },
    {
      ...common,
      id: "sg_drop",
      kind: "new_idea",
      title: "Dismiss this suggestion",
    },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/sg_link/accept")) {
        items = items.map((item) =>
          item.id === "sg_link"
            ? {
                ...item,
                status: "accepted",
                requestId: "req_link",
                requestState: "queued",
              }
            : item,
        ) as typeof items;
        return json({ status: "accepted", requestId: "req_link" });
      }
      if (url.endsWith("/sg_drop/dismiss")) {
        items = items.filter((item) => item.id !== "sg_drop");
        return json({ status: "dismissed", requestId: null });
      }
      return json({ items, next: null });
    }),
  );
  mount(h(Suggestions, { day }));
  fireEvent.click(await screen.findByRole("button", { name: "Link in vault" }));
  await screen.findByText("Waiting for sync");
  fireEvent.click(screen.getAllByRole("button", { name: "Dismiss" })[0]!);
  await screen.findByText("Suggestion dismissed.");
  expect(screen.queryByText("Dismiss this suggestion")).toBeNull();
});
