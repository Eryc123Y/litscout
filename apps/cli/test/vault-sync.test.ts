import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { validateConfig } from "@litscout/core";
import { syncVault } from "../src/vault-sync";

const snapshot = "a".repeat(64);
let dir: string;
let root: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "litscout-cli-vault-"));
  root = path.join(dir, "vault");
  await mkdir(root);
});
afterEach(() => rm(dir, { recursive: true, force: true }));
const day = "2026-11-18";
const secret = "private-fixture-" + "reader" + "@" + "invalid.example";
const paper = {
  id: "pap_fixture",
  title: "Paper",
  arxiv: "2406.09414",
  topics: [],
  links: [],
  notes: [],
};
function api() {
  return {
    get: vi.fn(async (route: string): Promise<unknown> => {
      if (route === "/vault/index?titleKeys=1")
        return { snapshot: null, count: 0 };
      if (route === "/vault/requests?state=queued")
        return [
          { kind: "capture", id: "req_fixture", title: "An idea", paper },
        ];
      if (route === "/vault/digests/" + day)
        return { day, markdown: "Published digest" };
      throw new Error("Unexpected GET " + route);
    }),
    write: vi.fn(
      async (
        _route: string,
        _body: unknown,
      ): Promise<Record<string, unknown>> => ({
        accepted: true,
        published: true,
        recorded: true,
        claimed: true,
        resolved: true,
        snapshot,
      }),
    ),
  };
}
it("estimates the title-key backfill in a dry run, and still previews when it cannot read it", async () => {
  const config = validateConfig({ vault: { root } }).vault;
  await writeFile(
    path.join(root, "Paper.md"),
    "---\ntags: type/paper\narxiv: 2406.09414\n---\n",
  );
  const preview = api();
  preview.get.mockImplementation(async (route: string) => {
    if (route === "/vault/index?titleKeys=1&titleKeyCount=1")
      return {
        snapshot: null,
        count: 0,
        titleKeysPending: true,
        titleKeysPendingCount: 6072,
      };
    throw new Error("Unexpected GET " + route);
  });
  const dryRun = await syncVault(config, dir, preview, {
    day,
    only: "index",
    dryRun: true,
  });
  // Papers and their compact rows are counted separately, about 2 rows each.
  expect(dryRun.titleKeys).toEqual({
    pending: 6072,
    estimatedRows: 12144,
    capped: false,
  });
  expect(dryRun.summary).toContain(
    "6072 title keys to fill first (about 12144 rows)",
  );
  expect(preview.write).not.toHaveBeenCalled();

  const unreadable = api();
  unreadable.get.mockImplementation(async () => {
    throw new Error("Token lacks the vault scope");
  });
  const blind = await syncVault(config, dir, unreadable, {
    day,
    only: "index",
    dryRun: true,
  });
  expect(blind.titleKeys).toBeNull();
  expect(blind.counts.paper_note).toBe(1);
});

it("previews and records conventions without including diagnostic paths in the index", async () => {
  const config = validateConfig({
    vault: { root, ideaTag: "lab/idea", exclude: ["Excluded.md"] },
  }).vault;
  for (const [file, header] of [
    ["Idea.md", "tags: lab/idea"],
    ["Missing Identifier.md", "tags: type/paper"],
    ["Private.md", "tags: type/paper\nlitscout: private"],
    ["Excluded.md", "tags: type/paper"],
  ]) {
    await writeFile(path.join(root, file!), "---\n" + header + "\n---\n");
  }
  const preview = api();
  const dryRun = await syncVault(config, dir, preview, {
    day,
    only: "index",
    dryRun: true,
  });
  expect(dryRun.summary).toContain("Conventions");
  expect(dryRun.summary).toContain("lab/idea");
  expect(dryRun.summary).toContain("1 excluded");
  expect(dryRun.conventions).toMatchObject({
    ideaTag: "lab/idea",
    ideaNotes: 1,
    paperNotesWithoutIdentifiers: {
      count: 1,
      paths: ["Missing Identifier.md"],
    },
    excludedNotes: 1,
    privateNotes: 1,
  });
  expect(preview.write).not.toHaveBeenCalled();

  const digestPreview = await syncVault(config, dir, preview, {
    day,
    only: "digests",
    dryRun: true,
  });
  expect(digestPreview).toMatchObject({
    index: "skipped",
    counts: { idea: 0 },
    conventions: dryRun.conventions,
  });

  const client = api();
  const live = await syncVault(config, dir, client, { day, only: "index" });
  expect(live.conventions).toEqual(dryRun.conventions);
  expect(
    client.write.mock.calls.find(([route]) => route === "/vault/report")?.[1],
  ).toMatchObject({ conventions: dryRun.conventions });
  const uploads = client.write.mock.calls.filter(
    ([route]) => route === "/vault/index",
  );
  // Identifier-free paper notes are indexed for title matching (M3d); the
  // conventions diagnostics add no paths beyond the index itself.
  expect(
    uploads.flatMap(([, body]) =>
      ((body as { notes?: { path: string; kind: string }[] }).notes ?? []).map(
        ({ path, kind }) => `${kind}:${path}`,
      ),
    ),
  ).toContain("paper_note:Missing Identifier.md");
  expect(JSON.stringify([live, client.write.mock.calls])).not.toMatch(
    /Private\.md|Excluded\.md/,
  );
});
it("previews each configured tag's matches before publishing and keeps the counts local", async () => {
  const config = validateConfig({
    vault: {
      root,
      ideaTag: ["type/idea", "type/synthesis"],
      workingPaperTag: "type/working-paper",
    },
  }).vault;
  for (const [file, header] of [
    ["One.md", "tags: [type/synthesis]"],
    ["Two.md", "tags: [type/synthesis]"],
    ["Draft.md", "tags: [type/working-paper]"],
  ])
    await writeFile(path.join(root, file!), "---\n" + header + "\n---\n");
  const preview = await syncVault(config, dir, api(), {
    day,
    only: "index",
    dryRun: true,
  });
  expect(preview.tagCounts).toEqual({
    idea: { "type/idea": 0, "type/synthesis": 2 },
    workingPaper: { "type/working-paper": 1 },
  });
  expect(preview.summary).toContain("ideas: 2 (type/idea 0, type/synthesis 2)");
  expect(preview.summary).toContain("type/working-paper: 1");
  const client = api();
  await syncVault(config, dir, client, { day, only: "index" });
  const report = client.write.mock.calls.find(
    ([route]) => route === "/vault/report",
  )?.[1] as Record<string, unknown>;
  expect(report).not.toHaveProperty("tagCounts");
  expect(report.conventions).toMatchObject({
    ideaTag: "type/idea, type/synthesis",
    ideaNotes: 2,
  });
});
it("uploads only the index and the report with vault writes off, without sending any note body", async () => {
  const client = api(),
    config = validateConfig({ vault: { root, digestsDir: "Digests" } }).vault;
  await writeFile(
    path.join(root, "Idea.md"),
    "---\ntags: [type/idea]\nsecret: " +
      ("lsk_" + "A".repeat(52)) +
      "\n---\n" +
      secret,
  );
  await mkdir(path.join(root, ".obsidian", "plugins"), { recursive: true });
  await writeFile(path.join(root, ".obsidian", "plugins", "Hidden.md"), secret);
  await writeFile(path.join(root, "Private NDA.md"), secret);
  const result = await syncVault(config, dir, client, { day });
  expect(result.writes).toEqual([
    { kind: "capture", path: "Inbox.md", mode: "planned" },
    { kind: "digest", path: "Digests/" + day + ".md", mode: "planned" },
  ]);
  expect(result.counts.idea).toBe(1);
  expect(result).toMatchObject({ excludedFolders: 1, excludedNotes: 1 });
  expect(result.summary).toContain("1 excluded folder · 1 excluded note");
  expect(
    client.write.mock.calls.find(([route]) => route === "/vault/report")?.[1],
  ).toMatchObject({
    excludedFolders: 1,
    excludedNotes: 1,
    conventions: { excludedFolders: 1, excludedNotes: 1 },
  });
  expect(client.write.mock.calls.map(([route]) => route)).toEqual([
    "/vault/index",
    "/vault/index",
    "/vault/report",
  ]);
  const sent = JSON.stringify(client.write.mock.calls);
  expect(sent).not.toContain(secret);
  expect(sent).not.toMatch(/\.obsidian|Hidden\.md|Private NDA\.md/);
  expect(sent).not.toContain("lsk_" + "A".repeat(52));
  await expect(readFile(path.join(root, "Inbox.md"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(
    readFile(path.join(root, "Digests", day + ".md")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});
it("makes no mutation in dry-run even with writes enabled, and applies only the selected operation", async () => {
  const config = validateConfig({
    vault: { root, write: true, digestsDir: "Digests" },
  }).vault;
  const preview = api();
  expect(
    await syncVault(config, dir, preview, { day, dryRun: true }),
  ).toMatchObject({ writes: [{ mode: "planned" }, { mode: "planned" }] });
  expect(preview.write).not.toHaveBeenCalled();
  await expect(readFile(path.join(root, "Inbox.md"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  const client = api();
  expect(
    await syncVault(config, dir, client, { day, only: "requests" }),
  ).toMatchObject({ writes: [{ kind: "capture", mode: "applied" }] });
  expect(client.get.mock.calls).toEqual([["/vault/requests?state=queued"]]);
  expect(client.write.mock.calls.map(([route]) => route)).toEqual([
    "/vault/requests/req_fixture/claim",
    "/vault/requests/req_fixture/resolve",
    "/vault/report",
  ]);
  expect(await readFile(path.join(root, "Inbox.md"), "utf8")).toContain(
    "An idea",
  );
});

it("finishes a status request after the file write succeeded and the previous acknowledgement was lost", async () => {
  const { createHash } = await import("node:crypto");
  const h = (value: string) => createHash("sha256").update(value).digest("hex");
  const previous = "---\ntags: [type/idea]\nstatus: seed\n---\nResearch text";
  const current = previous.replace("seed", "parked");
  const config = validateConfig({ vault: { root, write: true } }).vault;
  await writeFile(path.join(root, "Idea.md"), current);
  const client = api();
  client.get.mockResolvedValueOnce([
    {
      id: "req_status",
      kind: "set_status",
      status: "parked",
      target: { id: h("Idea.md"), path: "Idea.md" },
      baseHash: h(previous),
      resultHash: h(current),
    },
  ]);
  const result = await syncVault(config, dir, client, {
    day,
    only: "requests",
  });
  expect(result).toMatchObject({
    writes: [],
    rejected: [],
    applied: ["req_status"],
  });
  expect(await readFile(path.join(root, "Idea.md"), "utf8")).toBe(current);
});

it("uploads only changed notes and removes missing paths without sending unchanged metadata", async () => {
  const { createHash } = await import("node:crypto");
  const { openVault, localVaultSource } =
    await import("@litscout/sync/vault-source");
  const h = (value: string) => createHash("sha256").update(value).digest("hex");
  const config = validateConfig({ vault: { root } }).vault;
  const keep = "Same.md",
    remove = "Old.md",
    fresh = "New.md";
  for (const file of [keep, fresh])
    await writeFile(
      path.join(root, file),
      "---\ntags: [type/idea]\n---\nResearch text",
    );
  const { notes } = await localVaultSource(
    await openVault(config),
    config,
  ).index();
  const existing = notes.find((note) => note.path === keep)!;
  const client = api();
  client.get
    .mockResolvedValueOnce({ snapshot, count: 2 })
    .mockResolvedValueOnce({
      snapshot,
      next: null,
      items: [
        { id: existing.id, fingerprint: h(JSON.stringify(existing)) },
        { id: h(remove), fingerprint: h("old") },
      ],
    });
  await syncVault(config, dir, client, { day, only: "index" });
  const [first] = client.write.mock.calls;
  expect(first?.[1]).toMatchObject({
    notes: [{ path: fresh }],
    removed: [h(remove)],
  });
  expect(JSON.stringify(first?.[1])).not.toContain(keep);
});

it("refreshes matching for an unchanged index after filling legacy title keys", async () => {
  const { createHash } = await import("node:crypto");
  const current = createHash("sha256").update("[]").digest("hex");
  const config = validateConfig({ vault: { root } }).vault;
  const client = api();
  client.get.mockResolvedValueOnce({
    snapshot: current,
    count: 0,
    titleKeysPending: true,
  });
  client.write
    .mockResolvedValueOnce({ titleKeysPending: true })
    .mockResolvedValueOnce({ titleKeysPending: false });

  const result = await syncVault(config, dir, client, { day, only: "index" });

  expect(result.index).toBe("unchanged");
  expect(client.write.mock.calls.map(([route, body]) => [route, body])).toEqual(
    [
      ["/vault/index", { backfillTitleKeys: true }],
      ["/vault/index", { backfillTitleKeys: true }],
      [
        "/vault/index",
        {
          snapshot: current,
          previous: current,
          parts: 1,
          count: 0,
          changes: 0,
        },
      ],
      ["/vault/report", expect.anything()],
    ],
  );
});

// Runs about a dozen full CLI commands: about 10 s alone, so allow for a busy machine.
it(
  "routes idea, working paper and suggestion commands through the selected config",
  { timeout: 60_000 },
  async () => {
    const { runCommand } = await import("../src/setup-commands");
    const configFile = path.join(dir, "litscout.config.ts");
    await writeFile(
      configFile,
      'export default { instance: { publicUrl: "https://fixture.invalid" }, vault: { root: "./vault" } };',
    );
    const id = "a".repeat(64);
    const idea = {
      id,
      title: "An idea",
      path: "Ideas/Fixture.md",
      status: "seed",
      description: null,
      projectId: null,
      paperIds: [],
    };
    const out: string[] = [];
    const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
      const route = url.pathname;
      if (route === "/api/v1/ideas")
        return Response.json({
          success: true,
          data: { items: [idea], next: null },
        });
      if (route === "/api/v1/ideas/" + id)
        return Response.json({ success: true, data: idea });
      const wp = {
        id,
        title: "Working draft",
        path: "Research/Draft.md",
        status: "drafting",
        projectTitle: null,
      };
      if (route === "/api/v1/working-papers")
        return Response.json({
          success: true,
          data: { items: [wp], next: null },
        });
      if (route === "/api/v1/working-papers/" + id)
        return Response.json({
          success: true,
          data: {
            ...wp,
            ideas: [],
            recent: [],
            reading: [
              {
                id: "pap_fixture",
                title: "Reading entry",
                status: "reading",
                vaultPath: null,
                ideaIds: [],
                pending: false,
              },
            ],
          },
        });
      if (route === "/api/v1/suggestions") {
        expect(url.searchParams.get("status")).toBe("new");
        return Response.json({
          success: true,
          data: {
            items: [
              {
                id: "sg_fixture",
                day,
                title: "New direction",
                bodyMd: "Rationale",
                kind: "new_idea",
                ideaIds: [],
                paperIds: ["pap_fixture"],
                projectIds: [],
                status: "new",
                resolvedAt: null,
                requestId: null,
                requestState: null,
              },
            ],
            next: null,
          },
        });
      }
      if (route.startsWith("/api/v1/suggestions/sg_fixture/")) {
        expect(init.method).toBe("POST");
        const accept = route.endsWith("/accept");
        return Response.json({
          success: true,
          data: {
            status: accept ? "accepted" : "dismissed",
            requestId: accept ? "req_suggestion" : null,
          },
          meta: { rowsWritten: accept ? 2 : 1 },
        });
      }
      if (route === "/api/v1/vault/requests" && init.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({
          kind: "capture",
          title: "New idea",
          body: "One line",
        });
        return Response.json({
          success: true,
          data: { id: "req_fixture", state: "queued" },
          meta: { rowsWritten: 2 },
        });
      }
      throw new Error("Unexpected route " + route);
    });
    const deps = {
      cwd: dir,
      dir: path.join(dir, "state"),
      env: {},
      isTTY: false,
      templateDir: dir,
      bundlePath: "unused",
      flow: { token: "fixture-token" },
      fetch: fetcher as unknown as typeof fetch,
      run: vi.fn(),
      fetchVenues: vi.fn(),
      prompt: vi.fn(),
      print: (line: string) => out.push(line),
    };
    const run = (...args: string[]) =>
      runCommand([...args, "--config", configFile], deps);
    expect(await run("ideas", "list")).toBe(0);
    expect(out.at(-1)).toContain(idea.title);
    expect(await run("ideas", "show", id)).toBe(0);
    expect(out.at(-1)).toContain(idea.path);
    expect(
      await run("ideas", "capture", "New idea", "--body", "One line"),
    ).toBe(0);
    expect(out.at(-1)).toContain("req_fixture");
    expect(await run("wp", "list")).toBe(0);
    expect(out.at(-1)).toContain("Working draft");
    expect(await run("wp", "show", id)).toBe(0);
    expect(out.at(-1)).toContain("Reading entry");
    expect(await run("suggestions", "list", "--status", "new")).toBe(0);
    expect(out.at(-1)).toContain("sg_fixture");
    const accepted = await run("suggestions", "accept", "sg_fixture");
    expect(accepted, out.at(-1)).toBe(0);
    expect(out.at(-1)).toContain("req_suggestion");
    expect(await run("suggestions", "dismiss", "sg_fixture")).toBe(0);
    expect(out.at(-1)).toContain("Dismissed");
    await writeFile(
      path.join(root, "Paper without ID.md"),
      "---\ntags: type/paper\n---\n",
    );
    await writeFile(
      path.join(root, "Paper template.md"),
      "---\ntags: type/paper\ndate: {{date}}\n---\n",
    );
    expect(await run("sync", "--only", "index", "--dry-run")).toBe(0);
    expect(out.at(-1)).toContain(
      "Paper note without arxiv or doi · Paper without ID.md",
    );
    expect(out.at(-1)).toContain("Template skipped · Paper template.md");
    expect(out.at(-1)).toContain("1 templates skipped");
    expect(await run("sync", "--only", "index", "--dry-run", "--json")).toBe(0);
    expect(JSON.parse(out.at(-1)!)).toMatchObject({
      success: true,
      data: {
        conventions: {
          paperNotesWithoutIdentifiers: {
            count: 1,
            paths: ["Paper without ID.md"],
          },
        },
      },
    });
  },
);

it("keeps local state off disk when the CLI indexes a read-only vault", async () => {
  const { vaultCommand } = await import("../src/vault-command");
  const { readdir } = await import("node:fs/promises");
  const config = validateConfig({
    instance: { publicUrl: "https://fixture.invalid" },
    vault: { root },
  });
  const state = path.join(root, "state");
  const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
    if (url.pathname === "/api/v1/vault/index" && init.method === "GET")
      return Response.json({
        success: true,
        data: { snapshot: null, count: 0 },
      });
    if (init.method === "PUT" && url.pathname.startsWith("/api/v1/vault/"))
      return Response.json({
        success: true,
        data: { accepted: true, published: true, recorded: true },
        meta: { rowsWritten: 1 },
      });
    throw new Error("Unexpected route " + url.pathname);
  });
  await vaultCommand(
    ["sync", "--only", "index"],
    {
      cwd: dir,
      dir: state,
      env: {},
      isTTY: false,
      templateDir: dir,
      bundlePath: "unused",
      flow: { token: "fixture-token" },
      fetch: fetcher as unknown as typeof fetch,
      run: vi.fn(),
      fetchVenues: vi.fn(),
      prompt: vi.fn(),
      print: vi.fn(),
    },
    config,
  );
  expect(await readdir(root)).toEqual([]);
});

it("uploads good notes and reports bad file names without disclosing their contents", async () => {
  const client = api();
  const config = validateConfig({ vault: { root } }).vault;
  await writeFile(
    path.join(root, "Good.md"),
    "---\ntags: [type/idea]\n---\n" + secret,
  );
  await writeFile(
    path.join(root, "Bad: path.md"),
    "---\ntags: [type/idea]\n---\n" + secret,
  );
  const result = await syncVault(config, dir, client, { day, only: "index" });
  expect(result.counts.idea).toBe(1);
  expect(result.issues).toMatchObject([{ path: "Bad: path.md" }]);
  expect(
    client.write.mock.calls.find(([route]) => route === "/vault/report")?.[1],
  ).toMatchObject({ issues: result.issues });
  expect(JSON.stringify(client.write.mock.calls)).not.toContain(secret);
});

it("does not read the queued status path until it matches an indexed idea", async () => {
  const vaultSource = await import("@litscout/sync/vault-source");
  const { hash } = await import("@litscout/sync/vault-note");
  const config = validateConfig({ vault: { root, write: true } }).vault;
  const actual = await vaultSource.openVault(config);
  const read = vi.fn(actual.read);
  const open = vi
    .spyOn(vaultSource, "openVault")
    .mockResolvedValue({ ...actual, read });
  try {
    const note = "---\ntags: [type/paper]\narxiv: '2406.09414'\n---\n";
    await writeFile(path.join(root, "Paper.md"), note);
    const client = api();
    client.get.mockResolvedValueOnce([
      {
        id: "req_wrong_kind",
        kind: "set_status",
        status: "parked",
        target: { id: hash("Paper.md"), path: "Paper.md" },
        baseHash: hash(note),
      },
    ]);
    const result = await syncVault(config, dir, client, {
      day,
      only: "requests",
    });
    expect(read.mock.calls).toEqual([["Paper.md"]]);
    expect(client.write.mock.calls).toContainEqual([
      "/vault/requests/req_wrong_kind/resolve",
      expect.objectContaining({ state: "rejected" }),
      12,
    ]);
    expect(result.rejected).toMatchObject([{ id: "req_wrong_kind" }]);
  } finally {
    open.mockRestore();
  }
});

it("writes a healthy fixture vault and uses the capture draft returned by the claim", async () => {
  const { parseNote, managedBlock, hash } =
    await import("@litscout/sync/vault-note");
  const config = validateConfig({
    vault: {
      root,
      write: true,
      digestsDir: "Digests",
      paperNotes: { dirs: { Vision: "Papers" } },
    },
  }).vault;
  const idea =
    "---\ntype: idea\ntags: [type/idea, topic/vision]\ndescription: A testable direction\nai-first: true\nstatus: seed\n---\n\nHuman idea prose.\n";
  const inbox =
    "---\ntype: inbox\ntags: [type/inbox]\ndescription: Incoming research\nai-first: false\n---\n\nHuman inbox entry.\n";
  await writeFile(path.join(root, "Idea [A].md"), idea);
  await writeFile(path.join(root, "Inbox.md"), inbox);
  const existing = "Existing.md";
  const before =
    "---\ntype: paper\ntags: [type/paper, topic/vision]\ndescription: Existing metadata\nai-first: false\narxiv: '2406.09415'\n---\n\nHuman paper notes.\n";
  await writeFile(path.join(root, existing), before);
  const client = api();
  const original = client.get.getMockImplementation()!;
  client.get.mockImplementation(async (route) => {
    if (route === "/vault/requests?state=queued")
      return [
        {
          kind: "capture",
          id: "req_capture",
          title: "Stale draft",
          paper,
          references: [
            { kind: "note", title: "Idea [A]", path: "Idea [A].md" },
          ],
        },
        {
          kind: "set_status",
          id: "req_status",
          status: "exploring",
          target: { id: hash("Idea [A].md"), path: "Idea [A].md" },
          baseHash: hash(idea),
        },
        {
          kind: "make_paper_note",
          id: "req_paper",
          paper: { ...paper, topics: ["Vision"] },
        },
      ];
    if (route.startsWith("/vault/papers"))
      return [{ ...paper, id: "pap_existing", notes: ["A quick note"] }];
    if (route.startsWith("/vault/matches"))
      return [{ id: hash(existing), paperId: "pap_existing" }];
    return original(route);
  });
  const write = client.write.getMockImplementation()!;
  client.write.mockImplementation(async (route, body) => ({
    ...(await write(route, body)),
    ...(route === "/vault/requests/req_capture/claim"
      ? { capture: { title: "Edited draft", body: "Latest text" } }
      : {}),
  }));
  const result = await syncVault(config, dir, client, { day });
  expect(result.issues).toEqual([]);
  expect(result.rejected).toEqual([]);
  expect(result.applied).toHaveLength(3);

  // The fixture template requires a type, its matching type tag, a
  // description, and an explicit ai-first boolean for generated notes.
  const validate = (text: string, type: string, aiFirst: boolean) => {
    const note = parseNote(text);
    expect(note.delimited).toBe(true);
    expect(note.doc.get("type")).toBe(type);
    expect(
      (note.doc.toJS().tags as string[]).filter((tag) =>
        tag.startsWith("type/"),
      ),
    ).toEqual(["type/" + type]);
    expect(note.doc.get("description")).toMatch(/\S/);
    expect(note.doc.get("ai-first")).toBe(aiFirst);
    return note;
  };
  const writtenInbox = validate(
    await readFile(path.join(root, "Inbox.md"), "utf8"),
    "inbox",
    false,
  );
  expect(writtenInbox.body).toContain("Human inbox entry.");
  expect(managedBlock(writtenInbox.body)?.content).toContain(
    "Edited draft — Latest text",
  );
  expect(managedBlock(writtenInbox.body)?.content).toContain(
    "Idea%20%5BA%5D.md",
  );
  expect(writtenInbox.body).not.toContain("Stale draft");
  const changedIdea = validate(
    await readFile(path.join(root, "Idea [A].md"), "utf8"),
    "idea",
    true,
  );
  expect(changedIdea.doc.get("status")).toBe("exploring");
  expect(changedIdea.body).toBe(parseNote(idea).body);
  const updatedPaper = validate(
    await readFile(path.join(root, existing), "utf8"),
    "paper",
    false,
  );
  expect(updatedPaper.body).toContain("Human paper notes.");
  expect(managedBlock(updatedPaper.body)?.content).toContain("A quick note");
  const writtenPaper = validate(
    await readFile(path.join(root, "Papers/Paper.md"), "utf8"),
    "paper",
    true,
  );
  expect(managedBlock(writtenPaper.body)?.content).toContain(
    "litscout:paper=req_paper",
  );
  const writtenDigest = validate(
    await readFile(path.join(root, "Digests", day + ".md"), "utf8"),
    "digest",
    true,
  );
  expect(managedBlock(writtenDigest.body)?.content).toContain(
    "Published digest",
  );
});

it("previews and rejects a duplicate paper note with its existing vault path", async () => {
  const config = validateConfig({
    vault: { root, write: true, paperNotes: { dirs: { Vision: "Papers" } } },
  }).vault;
  const folder = ["Research", "Collected notes ".repeat(8).trim()].join("/");
  const existing = folder + "/" + "Existing paper ".repeat(14).trim() + ".md";
  const text =
    "---\ntags: [type/paper]\ntitle: Café — Depth\n---\n\nPaper notes.\n";
  await mkdir(path.join(root, folder), { recursive: true });
  await writeFile(path.join(root, existing), text);
  const client = api();
  const original = client.get.getMockImplementation()!;
  client.get.mockImplementation((route) => {
    if (route === "/vault/requests?state=queued")
      return Promise.resolve([
        {
          kind: "make_paper_note",
          id: "req_duplicate",
          paper: { ...paper, title: "CAFE depth", topics: ["Vision"] },
        },
      ]);
    return original(route);
  });
  expect(
    await syncVault(config, dir, client, {
      day,
      only: "requests",
      dryRun: true,
    }),
  ).toMatchObject({
    writes: [],
    rejected: [
      {
        id: "req_duplicate",
        reason: expect.stringContaining(existing),
        mode: "planned",
      },
    ],
  });
  expect(client.write).not.toHaveBeenCalled();

  const result = await syncVault(config, dir, client, {
    day,
    only: "requests",
  });
  expect(result).toMatchObject({
    writes: [],
    applied: [],
    rejected: [
      {
        id: "req_duplicate",
        reason: expect.stringContaining(existing),
        mode: "rejected",
      },
    ],
  });
  expect(client.write).toHaveBeenCalledWith(
    "/vault/requests/req_duplicate/resolve",
    {
      state: "rejected",
      reason: expect.stringContaining(existing),
      claim: expect.any(String),
    },
    12,
  );
  expect(await readFile(path.join(root, existing), "utf8")).toBe(text);
  await expect(
    readFile(path.join(root, "Papers", "CAFE depth.md")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("sends title-only notes for matching in queries that fit the Worker URL limit", async () => {
  const config = validateConfig({ vault: { root } }).vault;
  const titles = ["視".repeat(512), "深".repeat(512), "読".repeat(512)];
  for (const [index, title] of titles.entries()) {
    await writeFile(
      path.join(root, "Paper " + index + ".md"),
      "---\ntags: [type/paper]\ntitle: " + title + "\n---\n",
    );
  }
  const client = api();
  client.get.mockResolvedValue([]);
  await syncVault(config, dir, client, { day, only: "blocks", dryRun: true });
  const seen: string[] = [];
  expect(client.get).toHaveBeenCalledTimes(2);
  for (const [route] of client.get.mock.calls) {
    expect(route.length).toBeLessThan(12_000);
    const query = new URLSearchParams(route.split("?")[1]);
    for (const payload of query.getAll("note")) {
      const candidate = JSON.parse(payload);
      expect(candidate).toEqual({
        id: expect.any(String),
        title: expect.any(String),
      });
      seen.push(candidate.title);
    }
  }
  expect(seen).toEqual(titles);
});

it("writes digests of the previous six days whose file is missing, and leaves existing files alone", async () => {
  const config = validateConfig({
    vault: { root, write: true, digestsDir: "Digests" },
  }).vault;
  await mkdir(path.join(root, "Digests"));
  // 11-16 already has a file from another pipeline: not fetched, not touched.
  await writeFile(path.join(root, "Digests", "2026-11-16.md"), "old digest\n");
  const digests: Record<string, unknown> = {
    [day]: { day, markdown: "Published digest" },
    "2026-11-17": { day: "2026-11-17", markdown: "Late digest" },
    "2026-11-15": null,
  };
  const client = api();
  client.get.mockImplementation(async (route: string) => {
    const match = /^\/vault\/digests\/(.+)$/.exec(route);
    if (!match) throw new Error("Unexpected GET " + route);
    if (match[1] === "2026-11-14") throw new Error("temporary failure");
    return digests[match[1]!] ?? null;
  });
  const result = await syncVault(config, dir, client, {
    day,
    only: "digests",
    adopt: true,
  });
  expect(result.writes).toEqual([
    { kind: "digest", path: "Digests/" + day + ".md", mode: "applied" },
    { kind: "digest", path: "Digests/2026-11-17.md", mode: "applied" },
  ]);
  expect(result.issues).toEqual([]);
  expect(
    await readFile(path.join(root, "Digests", "2026-11-17.md"), "utf8"),
  ).toContain("Late digest");
  expect(
    await readFile(path.join(root, "Digests", "2026-11-16.md"), "utf8"),
  ).toBe("old digest\n");
  const asked = client.get.mock.calls.map(([route]) => route);
  expect(asked).not.toContain("/vault/digests/2026-11-16");
  expect(asked).toContain("/vault/digests/2026-11-12");
  expect(asked).not.toContain("/vault/digests/2026-11-11");
});
