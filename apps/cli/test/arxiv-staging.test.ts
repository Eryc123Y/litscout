import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { defineConfig } from "@litscout/core";
import { sourceCrawl } from "../src/source-crawl";
import { feedItemSchema } from "@litscout/pipeline/contracts/index";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function recorded(day: string, file = "arxiv-new.html") {
  const dir = await mkdtemp(path.join(tmpdir(), "litscout-arxiv-staging-"));
  dirs.push(dir);
  await writeFile(path.join(dir, "venues.json"), '{"venues":[]}');
  const html = await readFile(
    new URL(`./fixtures/round3/${file}`, import.meta.url),
    "utf8",
  );
  const recent = await readFile(
    new URL("./fixtures/round3/arxiv-recent.html", import.meta.url),
    "utf8",
  );
  return sourceCrawl(
    defineConfig({
      sources: {
        arxiv: { categories: ["cs.CV"] },
        huggingface: { dailyPapers: false },
      },
    }),
    {
      cwd: dir,
      dir,
      env: {},
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/new")) return new Response(html);
        if (url.pathname.endsWith("/recent")) return new Response(recent);
        if (
          url.hostname === "export.arxiv.org" &&
          url.pathname === "/api/query"
        ) {
          const entries = url.searchParams
            .get("id_list")!
            .split(",")
            .map(
              (id) =>
                `<entry><id>https://arxiv.org/abs/${id}v1</id><summary>Recovered abstract</summary></entry>`,
            );
          return new Response(`<feed>${entries.join("")}</feed>`);
        }
        throw new Error(`Unexpected fixture request ${url.pathname}`);
      },
      now: () => new Date(day + "T03:30:00Z"),
      sleep: async () => {},
      warn: () => {},
    },
  );
}
it("L1 replaces T1: Monday's real listing retains Monday's date on a Tuesday first run", async () => {
  const result = await (
    await recorded("2026-11-17")
  )("2026-11-17", [], null, []);
  expect(result.pending).toBe(true);
  expect(result.days["2026-11-16"]).toHaveLength(91);
  expect(result).toMatchObject({
    listing: { listingDate: "2026-11-16", runDay: "2026-11-17" },
  });
});
it("T1 repeated same-day listing adds no papers, while Monday showing already-ingested Friday stays pending", async () => {
  const current = await recorded("2026-11-17");
  const repeat = await current("2026-11-17", [], null, [], {
    listingDate: "2026-11-16",
    runDay: "2026-11-17",
  });
  expect(repeat.days["2026-11-17"]).toEqual([]);
  expect(repeat.pending).toBe(true);
  expect(repeat.listing).toBeUndefined();
  const stale = await (
    await recorded("2026-11-16", "arxiv-friday-excerpt.html")
  )("2026-11-16", [], null, [], {
    listingDate: "2026-11-13",
    runDay: "2026-11-13",
  });
  expect(stale.pending).toBe(true);
  expect(stale.days["2026-11-16"]).toEqual([]);
  expect(stale.message).toMatch(/already ingested|stale/i);
});
it("L1 a holiday gap retains the actual listing date", async () => {
  const result = await (
    await recorded("2026-11-17")
  )("2026-11-17", [], null, [], {
    listingDate: "2026-11-11",
    runDay: "2026-11-12",
  });
  expect(result.pending).toBe(true);
  expect(result.days["2026-11-16"]).toHaveLength(91);
  expect(result.noAnnouncement).toEqual(["2026-11-12"]);
  expect(result.days["2026-11-13"]).toHaveLength(196);
});
it.each(["arxiv", "crossref"])(
  "L1 identifies existing arXiv days from source-specific history, not a %s feed-day status",
  async (source) => {
    const crawl = await recorded("2026-11-16");
    const initial = await crawl("2026-11-16", [], null, []);
    const input = initial.days["2026-11-16"]![0]!;
    const item = feedItemSchema.parse({
      ...input,
      source,
      paperId: "pap_existing",
      authors: input.authors.map((name) => ({ name })),
      summaries: [],
    });
    const result = await crawl("2026-11-16", ["2026-11-16"], null, [
      { day: "2026-11-16", items: [item] },
    ]);
    expect(result.days["2026-11-16"]).toHaveLength(source === "arxiv" ? 0 : 91);
    expect(result.pending).toBe(false);
  },
);
