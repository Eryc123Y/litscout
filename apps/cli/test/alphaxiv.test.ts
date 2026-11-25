import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { defineConfig } from "@litscout/core";
import { clearMemoryCache } from "@litscout/sources/http/cache";
import { runCommand } from "../src/setup-commands";
import type { SetupDeps } from "../src/command-types";

const day = "2026-11-18";
const takenAt = day + "T10:00:00.000Z";
const folderId = "10000000-0000-4000-8000-000000000001";
const paperIds = Array.from(
  { length: 52 },
  (_, index) => "2611." + String(index + 100).padStart(5, "0"),
);
const uploadId = "confidential_upload";
const directories: string[] = [];

afterEach(async () => {
  clearMemoryCache();
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

async function harness() {
  await mkdir(".artifacts", { recursive: true });
  const dir = await mkdtemp(path.resolve(".artifacts/alpha-cli-"));
  directories.push(dir);
  const output: string[] = [];
  const batches: unknown[][] = [];
  const lookup: string[][] = [];
  const requests: string[] = [];
  const response = (data: unknown, rowsWritten?: number) =>
    Response.json({
      success: true,
      data,
      ...(rowsWritten === undefined ? {} : { meta: { rowsWritten } }),
    });
  let active: unknown = null;
  let previousItems: unknown[] = [];
  let pendingMetadata: string[] = [];
  let recovered = false;
  const starts: { digest: string }[] = [];
  let accepted = true;
  const fetch = vi.fn(async (input: URL, init: RequestInit) => {
    const url = new URL(input);
    if (url.host === "export.arxiv.org") {
      expect(new Headers(init.headers).has("authorization")).toBe(false);
      const ids = url.searchParams.get("id_list")!.split(",");
      lookup.push(ids);
      if (ids.length <= 2 && !recovered)
        return new Response("unavailable", { status: 503 });
      return new Response(
        `<feed><entry><id>https://arxiv.org/abs/${ids[0]}v1</id><title>Title from arXiv</title><published>${takenAt}</published><summary>Recovered abstract</summary><author><name>Test Author</name></author></entry></feed>`,
      );
    }
    expect(url.host).toBe("litscout.example");
    const route = url.pathname.replace("/api/v1", "");
    requests.push(init.method + " " + route);
    const body = init.body ? JSON.parse(String(init.body)) : null;
    if (route === "/budget")
      return response({
        day,
        used: 0,
        reserved: 0,
        staleLeasesReleased: 0,
        limit: 80000,
        resetAt: "2026-11-19T00:00:00.000Z",
      });
    if (route === "/ingest/alphaxiv/known")
      return response(
        url.searchParams.getAll("id").filter((id) => id === paperIds[0]),
      );
    if (route.endsWith("/start")) {
      starts.push(body);
      active = body;
      return response({ applied: true, completed: false }, 1);
    }
    if (route.endsWith("/finish"))
      return response(
        {
          applied: true,
          completed: true,
          missingMetadata: pendingMetadata.length,
        },
        1,
      );
    if (route === "/ingest/alphaxiv" && init.method === "GET")
      return response({
        active,
        completed: null,
        items: previousItems,
        pendingMetadata,
        nextCursor: null,
      });
    if (route === "/ingest/alphaxiv") {
      batches.push(body.items);
      if (accepted) {
        const pending = new Set(pendingMetadata);
        for (const item of body.items) {
          if (item.paperType !== "public" || item.paperId === paperIds[0])
            continue;
          if (!item.folders.length || item.metadata?.abstract)
            pending.delete(item.paperId);
          else pending.add(item.paperId);
        }
        pendingMetadata = [...pending];
      }
      return response({ accepted: accepted ? body.items.length : 0 }, 5);
    }
    throw new Error("Unexpected fixture request");
  });
  const deps = {
    cwd: dir,
    dir,
    print: (message: string) => output.push(message),
    fetch,
    flow: {
      token: "synthetic",
      sleep: async () => {},
      now: () => new Date(takenAt),
    },
    loadConfig: async () =>
      defineConfig({
        instance: {
          publicUrl: "https://litscout.example",
          limits: { ingest: { papers: 10 } },
        },
      }),
  } as unknown as SetupDeps;
  const memberships = [
    ...paperIds.map((paperId) => ({
      folderId,
      paperId,
      paperType: "public",
      title: "Snapshot title " + paperId,
      publicationDate: day,
    })),
    {
      folderId,
      paperId: uploadId,
      paperType: "private",
      title: "My new draft",
      publicationDate: day,
    },
  ];
  const snapshot = {
    takenAt,
    folders: [
      {
        id: folderId,
        name: "Reading",
        parentId: null,
        type: "default-reading",
        paperCount: memberships.length,
        complete: true,
      },
    ],
    memberships,
    annotations: [
      {
        paperId: paperIds[0]!,
        highlightCount: 0,
        hasNotes: false,
        lastAnnotatedAt: takenAt,
      },
    ],
  };
  const run = async (...opts: string[]) => {
    await writeFile(path.join(dir, "snapshot.json"), JSON.stringify(snapshot), {
      mode: 0o600,
    });
    const status = await runCommand(
      ["alphaxiv", "import", "snapshot.json", "--json", ...opts],
      deps,
    );
    return { status, output: JSON.parse(output.at(-1)!) };
  };
  return {
    run,
    snapshot,
    batches,
    lookup,
    requests,
    starts,
    retryFixture: (recover: boolean) => {
      recovered = recover;
      const paperId = paperIds[51]!;
      snapshot.takenAt = "2026-11-18T12:00:00.000Z";
      snapshot.memberships = snapshot.memberships.filter(
        (entry) => entry.paperId === paperId,
      );
      snapshot.folders[0]!.paperCount = 1;
      previousItems = [
        {
          paperId,
          paperType: "public",
          title: "Snapshot title " + paperId,
          folders: [{ id: folderId, path: "Reading", type: "default-reading" }],
          status: "reading",
          publicationDate: day,
          annotation: null,
        },
      ];
      pendingMetadata = [paperId];
    },
    rejectBatch: () => {
      accepted = false;
    },
  };
}

it("prints a dry-run diff without any upload, arXiv calls, or budget sync", async () => {
  const h = await harness();
  const { status, output } = await h.run("--dry-run");
  expect(status).toBe(0);
  expect(output.data).toMatchObject({
    dryRun: true,
    counts: { add: 53 },
    changes: expect.arrayContaining([
      {
        kind: "add",
        title: "My new draft",
        url: "https://www.alphaxiv.org/private/" + uploadId,
      },
    ]),
  });
  expect(h.lookup).toEqual([]);
  expect(h.requests).toEqual(["GET /ingest/alphaxiv"]);
});

it("batches unknown arXiv IDs and uploads, with snapshot fallback for failed lookups", async () => {
  const h = await harness();
  const { status, output } = await h.run();
  expect(status).toBe(0);
  expect(output.data).toMatchObject({
    status: "synced",
    counts: { add: 53 },
    snapshotFallbacks: 50,
    missingMetadata: 50,
  });
  expect(h.lookup.map((ids) => ids.length)).toEqual([50, 1, 1]);
  expect(h.lookup.flat()).not.toContain(paperIds[0]);
  expect(h.lookup.flat()).not.toContain(uploadId);
  expect(h.batches.map((items) => items.length)).toEqual([
    10, 10, 10, 10, 10, 3,
  ]);
  expect(h.batches.flat()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        paperId: paperIds[1],
        metadata: {
          title: "Title from arXiv",
          authors: [{ name: "Test Author" }],
          publicationDate: day,
          abstract: "Recovered abstract",
        },
      }),
      expect.objectContaining({
        paperId: paperIds[51],
        publicationDate: day,
        title: "Snapshot title " + paperIds[51],
      }),
      {
        paperId: uploadId,
        paperType: "private",
        title: "My new draft",
        folders: [{ id: folderId, path: "Reading", type: "default-reading" }],
        status: "reading",
      },
    ]),
  );
  expect(h.requests).toContain("GET /budget");
  expect(h.requests.at(-1)).toBe("POST /ingest/alphaxiv/finish");
});

it("leaves the run unfinished after a rejected batch and rejects invalid files before fetching", async () => {
  const h = await harness();
  h.rejectBatch();
  expect((await h.run()).status).toBe(1);
  expect(h.requests).not.toContain("POST /ingest/alphaxiv/finish");
  h.requests.length = 0;
  h.snapshot.folders[0]!.paperCount++;
  expect((await h.run()).status).toBe(1);
  expect(h.requests).toEqual([]);
});

it.each([true, false])(
  "retries an unchanged fallback and reports the remaining count when recovery is %s",
  async (recover) => {
    const h = await harness();
    h.retryFixture(recover);
    const { status, output } = await h.run();
    expect(status).toBe(0);
    expect(h.lookup).toEqual(
      recover ? [[paperIds[51]]] : [[paperIds[51]], [paperIds[51]]],
    );
    expect(output.data).toMatchObject({
      status: "synced",
      counts: { add: 0, update: 0, remove: 0, restore: 0 },
      snapshotFallbacks: 0,
      missingMetadata: recover ? 0 : 1,
    });
    if (recover)
      expect(h.batches.flat()).toMatchObject([
        {
          paperId: paperIds[51],
          metadata: {
            abstract: "Recovered abstract",
            authors: [{ name: "Test Author" }],
          },
        },
      ]);
    else expect(h.batches).toEqual([]);
  },
);

it("uses the same digest when folders, memberships and annotations are reordered", async () => {
  const h = await harness();
  h.snapshot.folders.push({
    ...h.snapshot.folders[0]!,
    id: "10000000-0000-4000-8000-000000000002",
    paperCount: 0,
  });
  h.snapshot.annotations.push({
    ...h.snapshot.annotations[0]!,
    paperId: paperIds[1]!,
  });
  expect((await h.run()).status).toBe(0);
  h.snapshot.folders.reverse();
  h.snapshot.memberships.reverse();
  h.snapshot.annotations.reverse();
  expect((await h.run()).status).toBe(0);
  expect(h.starts[0]!.digest).toBe(h.starts[1]!.digest);
});
