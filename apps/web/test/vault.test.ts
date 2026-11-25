// @vitest-environment jsdom
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { VaultSync, VaultPaperPanel } from "../src/Vault";
import { Projects } from "../src/Projects";
import { Ideas } from "../src/Ideas";
import { WorkingPapers } from "../src/WorkingPapers";

afterEach(cleanup);
const at = "2026-11-18T03:00:00.000Z";
const json = (data: unknown) => Response.json({ success: true, data });
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

const conventions = {
  ideaTag: "#lab/idea",
  ideaNotes: 0,
  workingPaperTag: "lab/working",
  workingPaperNotes: 0,
  paperNotesWithoutIdentifiers: { count: 53, paths: ["Papers/No ID.md"] },
  possibleNonProjects: 4,
  excludedFolders: 2,
  excludedNotes: 6,
  privateNotes: 7,
  templates: { count: 2, paths: ["System/Templates/Paper.md"] },
};
const conventionSettings = {
  ideaTag: "deployed/idea",
  workingPaperTag: "deployed/draft",
  projects: ["Lab/Projects/*.md"],
};
// The guide link comes from the settings (vault.guideUrl), not the code.
let guideUrl: string | undefined =
  "https://docs.example/self-host.md#vault-conventions";
function stubVault(last: boolean) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      if (path === "/api/v1/vault/status")
        return json({
          last: last
            ? {
                at,
                conventions,
                excludedFolders: conventions.excludedFolders,
                excludedNotes: conventions.excludedNotes,
                writeEnabled: false,
                counts: {
                  project: 0,
                  idea: 0,
                  working_paper: 0,
                  paper_note: 0,
                  brief: 0,
                },
                writes: [],
                handEdited: [],
                issues: [],
              }
            : null,
          conventionSettings: {
            ...conventionSettings,
            ...(guideUrl ? { guideUrl } : {}),
          },
          queued: [],
          rejected: [],
          queuedCount: 0,
        });
      if (path === "/api/v1/vault/captures") return json([]);
      if (
        [
          "/api/v1/ideas",
          "/api/v1/working-papers",
          "/api/v1/projects",
        ].includes(path) ||
        path.startsWith("/api/v1/suggestions?")
      )
        return json({ items: [], next: null });
      throw new Error("Unexpected route " + path);
    }),
  );
}

it("explains the synced idea tag and opens capture from the empty board", async () => {
  stubVault(true);
  mount(createElement(Ideas, { timezone: "UTC" }));
  expect(await screen.findByText("#lab/idea")).toBeTruthy();
  expect(screen.getByText("vault.ideaTag")).toBeTruthy();
  expect(
    screen
      .getByRole("link", { name: "Vault conventions guide" })
      .getAttribute("href"),
  ).toBe("https://docs.example/self-host.md#vault-conventions");
  fireEvent.click(screen.getByRole("button", { name: "Capture idea" }));
  expect(
    await screen.findByRole("dialog", { name: "Capture idea" }),
  ).toBeTruthy();
});

it("explains the configured working-paper tag before a first sync", async () => {
  stubVault(false);
  mount(createElement(WorkingPapers));
  expect(await screen.findByText("deployed/draft")).toBeTruthy();
  expect(screen.getByText("vault.workingPaperTag")).toBeTruthy();
  expect(
    screen.getByRole("link", { name: "Vault conventions guide" }),
  ).toBeTruthy();
});

it("explains configured project globs on an empty Projects page", async () => {
  stubVault(false);
  mount(createElement(Projects));
  expect(await screen.findByText("Lab/Projects/*.md")).toBeTruthy();
  expect(screen.getByText("vault.projects")).toBeTruthy();
  expect(
    screen.getByRole("link", { name: "Vault conventions guide" }),
  ).toBeTruthy();
});

it("names the vault conventions guide without a link when no guideUrl is set", async () => {
  guideUrl = undefined;
  try {
    stubVault(false);
    mount(createElement(Projects));
    expect(await screen.findByText("Lab/Projects/*.md")).toBeTruthy();
    expect(
      screen.queryByRole("link", { name: "Vault conventions guide" }),
    ).toBeNull();
    expect(
      screen.getByText(/Vault conventions in docs\/self-host\.md/),
    ).toBeTruthy();
  } finally {
    guideUrl = "https://docs.example/self-host.md#vault-conventions";
  }
});

it("points to the terminal report before the first sync", async () => {
  stubVault(false);
  mount(createElement(VaultSync, { timezone: "UTC" }));
  expect(await screen.findByText("litscout sync --dry-run")).toBeTruthy();
  expect(screen.getByText(/results in your terminal/i)).toBeTruthy();
  expect(screen.getByText("deployed/idea")).toBeTruthy();
  expect(screen.getByText("deployed/draft")).toBeTruthy();
});

it("shows synced convention counts and sampled paper paths on Vault sync", async () => {
  stubVault(true);
  mount(createElement(VaultSync, { timezone: "UTC" }));
  for (const value of ["#lab/idea", "lab/working", "Papers/No ID.md"])
    expect(await screen.findByText(value)).toBeTruthy();
  expect(screen.getByText(/showing 1 of 53/i)).toBeTruthy();
  expect(screen.getByText("4 possible non-projects")).toBeTruthy();
  expect(screen.getByText("2 excluded folders")).toBeTruthy();
  expect(screen.getByText("6 excluded notes")).toBeTruthy();
  expect(screen.getByText("7 private notes")).toBeTruthy();
  expect(screen.getByText(/2 template notes skipped/)).toBeTruthy();
  expect(screen.getByText("System/Templates/Paper.md")).toBeTruthy();
});

it.each([0, 1, 2])(
  "explains an unmatched paper with %i identifier-free notes",
  async (count) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({ path: null, pending: false, notesWithoutIdentifiers: count }),
      ),
    );
    mount(createElement(VaultPaperPanel, { paperId: "pap_fixture" }));
    expect(await screen.findByText("No matching vault note.")).toBeTruthy();
    expect(
      screen.getByText(new RegExp(count + " paper notes? without")),
    ).toBeTruthy();
    expect(screen.getByText("arxiv")).toBeTruthy();
    expect(screen.getByText("doi")).toBeTruthy();
  },
);

it("shows disabled writes, the last sync and conflicts, and cancels a pending request", async () => {
  let queued = [
    {
      id: "req_one",
      kind: "link_paper",
      title: "A study",
      path: "Ideas/One.md",
      createdAt: at,
      applying: false,
    },
  ];
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    if (
      path === "/api/v1/vault/requests/req_one" &&
      init?.method === "DELETE"
    ) {
      queued = [];
      return json({ cancelled: true });
    }
    return json({
      queued,
      queuedCount: queued.length,
      rejected: [
        {
          id: "req_two",
          kind: "set_status",
          title: "Old idea",
          reason: "Vault status was kept",
          resolvedAt: at,
        },
      ],
      last: {
        at,
        writeEnabled: false,
        counts: {
          project: 1,
          idea: 2,
          working_paper: 0,
          paper_note: 1,
          brief: 0,
        },
        excludedFolders: 3,
        excludedNotes: 1,
        writes: [],
        handEdited: ["Papers/Edited.md"],
        issues: [
          { path: "Bad: path.md", reason: "Expected a path inside the vault." },
        ],
      },
    });
  });
  vi.stubGlobal("fetch", fetcher);
  mount(createElement(VaultSync, { timezone: "America/Los_Angeles" }));
  expect(await screen.findByText("Vault writes are off")).toBeTruthy();
  expect(
    screen.getByText("17 Nov 2026, 19:00 GMT-8").getAttribute("datetime"),
  ).toBe(at);
  expect(screen.getByText("3 excluded folders")).toBeTruthy();
  expect(screen.getByText("1 excluded note")).toBeTruthy();
  expect(screen.getByText("2 ideas")).toBeTruthy();
  expect(screen.getByText("Papers/Edited.md")).toBeTruthy();
  expect(screen.getByText("Bad: path.md")).toBeTruthy();
  expect(screen.getByText("Expected a path inside the vault.")).toBeTruthy();
  expect(screen.getByText("Vault status was kept")).toBeTruthy();
  // The request type is a neutral badge, not text in the link colour.
  const type = screen.getByText("Link a paper");
  expect(type.dataset.slot).toBe("badge");
  expect(type.dataset.variant).toBe("outline");
  expect(type.className).not.toContain("text-primary");
  fireEvent.click(screen.getByRole("button", { name: "Cancel A study" }));
  await screen.findByText("No requests waiting.");
  expect(fetcher).toHaveBeenCalledWith(
    "/api/v1/vault/requests/req_one",
    expect.objectContaining({ method: "DELETE" }),
  );
});

it("queues a note from the paper panel and shows the matched path when present", async () => {
  let pending = false;
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/v1/vault/requests" && init?.method === "POST") {
      pending = true;
      return json({ id: "req_paper", state: "queued" });
    }
    return json({
      path: path.endsWith("pap_existing") ? "Papers/Existing.md" : null,
      matchedBy: path.endsWith("pap_existing") ? "title" : undefined,
      pending,
    });
  });
  vi.stubGlobal("fetch", fetcher);
  const view = mount(
    createElement(VaultPaperPanel, { paperId: "pap_fixture" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Make a vault note" }),
  );
  await screen.findByText("Vault note requested.");
  expect(fetcher).toHaveBeenCalledWith(
    "/api/v1/vault/requests",
    expect.objectContaining({
      body: JSON.stringify({ kind: "make_paper_note", paperId: "pap_fixture" }),
    }),
  );
  view.unmount();
  mount(createElement(VaultPaperPanel, { paperId: "pap_existing" }));
  expect(await screen.findByText("Papers/Existing.md")).toBeTruthy();
  expect(screen.getByText("Matched by title")).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Make a vault note" }),
  ).toBeNull();
});

it("opens a project on its radar hits", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({
        next: null,
        items: [
          {
            id: "a".repeat(64),
            title: "Stereo project",
            status: "active",
            summary: "Depth memo",
            path: "Projects/Stereo.md",
            ideas: [],
            papers: [{ id: "pap_fixture", title: "Read this" }],
            radar: [
              {
                id: "rad_one",
                paperId: "pap_radar",
                title: "Radar paper",
                day: "2026-11-18",
                level: "high",
                reason: "Related baseline",
              },
            ],
          },
        ],
      }),
    ),
  );
  mount(createElement(Projects));
  expect(await screen.findByRole("link", { name: "Radar paper" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Papers 1" })).toBeTruthy();
  await waitFor(() =>
    expect(screen.getByText("Related baseline")).toBeTruthy(),
  );
});

it("opens a project on its first section that has anything in it", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({
        next: null,
        items: [
          {
            id: "a".repeat(64),
            title: "Stereo project",
            status: "active",
            summary: "Depth memo",
            path: "Projects/Stereo.md",
            ideas: [],
            papers: [{ id: "pap_fixture", title: "Read this" }],
            radar: [],
          },
        ],
      }),
    ),
  );
  mount(createElement(Projects));
  const papers = await screen.findByRole("link", { name: "Papers 1" });
  expect(papers.getAttribute("aria-current")).toBe("page");
  expect(
    screen.getByRole("link", { name: "Radar 0" }).getAttribute("aria-current"),
  ).toBeNull();
  expect(await screen.findByRole("link", { name: "Read this" })).toBeTruthy();
  // The default section keeps the address short; another one names itself.
  expect(papers.getAttribute("href")).not.toContain("tab=");
  expect(
    screen.getByRole("link", { name: "Radar 0" }).getAttribute("href"),
  ).toContain("tab=radar");
});
