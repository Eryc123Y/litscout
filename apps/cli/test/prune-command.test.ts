import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { runCommand, type SetupDeps } from "../src/setup-commands";

const due = {
  success: true,
  data: {
    enabled: true,
    before: "2025-11-22",
    count: 3,
    oldestDay: "2025-09-01",
    sample: ["Gone 1", "Gone 2", "Gone 3"],
  },
};
const expired = (n: number, more: boolean, before = "2025-11-22") => ({
  success: true,
  data: {
    enabled: true,
    before,
    expired: n,
    rowsWritten: n * 30,
    waiting: 0,
    more,
  },
});
const emptyPrune = {
  success: true,
  data: {
    enabled: true,
    available: 100,
    next: null,
    sizeBytes: 8000,
    rows: [],
    waiting: 0,
    papersPruned: 0,
    rowsWritten: 0,
  },
};
async function withConfig(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "litscout-prune-"));
  try {
    await writeFile(
      join(dir, "litscout.config.ts"),
      'export default {instance:{publicUrl:"https://worker.example"}};',
    );
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const depsFor = (dir: string, fetch: unknown, print = vi.fn()) =>
  ({
    dir,
    cwd: dir,
    print,
    fetch,
    flow: { token: "fixture" },
  }) as unknown as SetupDeps;

it("previews counts and ten titles across pages using GET only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "litscout-prune-"));
  try {
    await writeFile(
      join(dir, "litscout.config.ts"),
      'export default {instance:{publicUrl:"https://worker.example"}};',
    );
    const print = vi.fn();
    const after = { age: "2026-04-01", id: "pap_first" };
    const fetch = vi.fn(async (url: URL, init: RequestInit) => {
      expect(init.method).toBe("GET");
      if (url.pathname === "/api/v1/ingest/expire") return Response.json(due);
      expect(url.pathname).toBe("/api/v1/ingest/prune");
      const eligible = url.searchParams.has("id");
      return Response.json({
        success: true,
        data: {
          enabled: true,
          available: 100,
          next: eligible ? null : after,
          sizeBytes: 8000,
          rows: eligible
            ? Array.from({ length: 12 }, (_, i) => ({
                eligible: true,
                title: "Old " + i,
                bound: 40,
                reasons: [],
              }))
            : [
                {
                  eligible: false,
                  title: "Kept",
                  bound: 40,
                  reasons: ["library", "reading"],
                },
              ],
          waiting: 0,
          papersPruned: 0,
          rowsWritten: 0,
        },
      });
    });
    const deps = {
      dir,
      cwd: dir,
      print,
      fetch,
      flow: { token: "fixture" },
    } as unknown as SetupDeps;
    expect(await runCommand(["prune", "--dry-run", "--json"], deps)).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(3);
    const { data } = JSON.parse(print.mock.calls[0]![0]);
    expect(data).toMatchObject({
      dryRun: true,
      kept: { library: 1, reading: 1, digest: 0, research: 0, recent: 0 },
      prunable: 12,
      waitingForBudget: 11,
      papersPruned: 0,
    });
    expect(data.sample).toHaveLength(10);
    expect(data.expiry).toEqual({
      enabled: true,
      dryRun: true,
      before: "2025-11-22",
      due: 3,
      oldestDay: "2025-09-01",
      sample: ["Gone 1", "Gone 2", "Gone 3"],
      expired: 0,
      rowsWritten: 0,
      waiting: 0,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("retries smaller batches after a transient Worker failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "litscout-prune-"));
  try {
    await writeFile(
      join(dir, "litscout.config.ts"),
      'export default {instance:{publicUrl:"https://worker.example"}};',
    );
    const sizes: number[] = [];
    const print = vi.fn();
    const fetch = vi.fn(async (url: URL, init: RequestInit) => {
      if (url.pathname === "/api/v1/ingest/expire")
        return Response.json(expired(0, false));
      const body = JSON.parse(String(init.body));
      sizes.push(body.batchSize);
      if (sizes.length === 1) return new Response(null, { status: 503 });
      return Response.json({
        success: true,
        data: {
          enabled: true,
          available: 100,
          next: null,
          sizeBytes: 8000,
          rows: [],
          waiting: 0,
          papersPruned: body.waiting === undefined ? 2 : 0,
          rowsWritten: 9,
        },
      });
    });
    const deps = {
      dir,
      cwd: dir,
      print,
      fetch,
      flow: { token: "fixture" },
    } as unknown as SetupDeps;
    expect(await runCommand(["prune", "--json"], deps)).toBe(0);
    expect(sizes).toEqual([10, 5, 10]);
    expect(JSON.parse(print.mock.calls[0]![0]).data).toMatchObject({
      papersPruned: 2,
      rowsWritten: 18,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("expires compact rows page by page after compacting, until a page is not full", async () => {
  await withConfig(async (dir) => {
    const pages = [expired(100, true), expired(40, false)];
    const bodies: unknown[] = [];
    const fetch = vi.fn(async (url: URL, init: RequestInit) => {
      if (url.pathname === "/api/v1/ingest/prune")
        return Response.json(emptyPrune);
      expect(url.pathname).toBe("/api/v1/ingest/expire");
      expect(init.method).toBe("POST");
      bodies.push(JSON.parse(String(init.body)));
      return Response.json(pages.shift());
    });
    const print = vi.fn();
    expect(
      await runCommand(["prune", "--json"], depsFor(dir, fetch, print)),
    ).toBe(0);
    expect(bodies).toEqual([{}, { notAfter: "2025-11-22" }]);
    expect(JSON.parse(print.mock.calls[0]![0]).data.expiry).toMatchObject({
      dryRun: false,
      before: "2025-11-22",
      expired: 140,
      rowsWritten: 4200,
    });
  });
});

it("over the cap removes only the oldest week in one run", async () => {
  await withConfig(async (dir) => {
    const pages = [
      expired(100, true, "2025-09-08"),
      expired(30, false, "2025-09-08"),
    ];
    const bodies: unknown[] = [];
    const fetch = vi.fn(async (url: URL, init: RequestInit) => {
      if (url.pathname === "/api/v1/ingest/prune")
        return Response.json(emptyPrune);
      bodies.push(JSON.parse(String(init.body)));
      return Response.json(pages.shift());
    });
    const print = vi.fn();
    expect(
      await runCommand(
        ["prune", "--over-cap", "--json"],
        depsFor(dir, fetch, print),
      ),
    ).toBe(0);
    expect(bodies).toEqual([
      { overCap: true },
      { overCap: true, notAfter: "2025-09-08" },
    ]);
    expect(JSON.parse(print.mock.calls[0]![0]).data.expiry).toMatchObject({
      before: "2025-09-08",
      expired: 130,
    });
  });
});

it("previews the over-cap week with GET only", async () => {
  await withConfig(async (dir) => {
    const urls: URL[] = [];
    const fetch = vi.fn(async (url: URL, init: RequestInit) => {
      expect(init.method).toBe("GET");
      urls.push(url);
      return Response.json(
        url.pathname === "/api/v1/ingest/expire" ? due : emptyPrune,
      );
    });
    expect(
      await runCommand(
        ["prune", "--dry-run", "--over-cap", "--json"],
        depsFor(dir, fetch),
      ),
    ).toBe(0);
    expect(
      urls.find((url) => url.pathname === "/api/v1/ingest/expire")?.search,
    ).toBe("?overCap=1");
  });
});
