import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defineConfig } from "@litscout/core";
import type { HistoryDay } from "@litscout/pipeline/daily";
import {
  ATTEMPTS_FILE,
  backoffDays,
  isDue,
  nextAttempts,
  readAttempts,
} from "../src/abstract-attempts";
import { STATE_FILE } from "../src/daily-resume";
import { sourceCrawl } from "../src/source-crawl";

const watch = vi.hoisted(() => vi.fn(async () => []));
vi.mock("@litscout/sources/watch/library", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@litscout/sources/watch/library")>()),
  watchVenues: watch,
}));
/** Abstracts found by the lookup, by paper key; every other key is a miss. */
const lookup = vi.hoisted(() => ({
  found: {} as Record<string, string>,
  unchecked: [] as string[],
  asked: [] as string[][],
}));
vi.mock("../src/abstracts/run", () => ({
  runAbstracts: async (
    _args: string[],
    deps: {
      readStdin: () => Promise<string>;
      stdout: (s: string) => void;
      onUnchecked?: (u: ReadonlyMap<string, readonly string[]>) => void;
    },
  ) => {
    const ids = (await deps.readStdin())
      .split("\n")
      .map((line) => (JSON.parse(line) as { id: string }).id);
    lookup.asked.push(ids);
    for (const id of ids)
      deps.stdout(
        JSON.stringify({
          id,
          abstract: lookup.found[id] ?? null,
          source: lookup.found[id] ? "openalex" : null,
        }) + "\n",
      );
    deps.onUnchecked?.(
      new Map(
        ids
          .filter((id) => lookup.unchecked.includes(id))
          .map((id) => [id, ["europepmc"]]),
      ),
    );
    return 0;
  },
}));

const DAY = 86_400_000;
const start = new Date("2026-11-25T03:00:00Z");

describe("the attempts ledger", () => {
  it("waits 1, 2, 4 and 8 days after each miss, then 16 days for good", () => {
    expect([1, 2, 3, 4, 5, 9].map(backoffDays)).toEqual([1, 2, 4, 8, 16, 16]);
  });
  it("counts a miss, drops a found paper and any paper no longer missing", () => {
    const previous = {
      "doi:10.1/a": { tries: 2, next: "2026-11-25T00:00:00.000Z" },
      "doi:10.1/b": { tries: 1, next: "2026-11-25T00:00:00.000Z" },
      "doi:10.1/gone": { tries: 3, next: "2026-12-01T00:00:00.000Z" },
      "doi:10.1/waiting": { tries: 1, next: "2026-11-26T00:00:00.000Z" },
    };
    const lacking = new Set(["doi:10.1/a", "doi:10.1/b", "doi:10.1/waiting"]);
    const asked = [
      { key: "doi:10.1/a", outcome: "missed" },
      { key: "doi:10.1/b", outcome: "found" },
    ] as const;
    expect(nextAttempts(previous, lacking, asked, start)).toEqual({
      "doi:10.1/a": { tries: 3, next: "2026-11-29T03:00:00.000Z" },
      "doi:10.1/waiting": previous["doi:10.1/waiting"],
    });
    expect(previous["doi:10.1/a"].tries).toBe(2);
  });
  it("asks again a day later, without counting a miss, when a source could not check a paper", () => {
    const previous = {
      "doi:10.1/a": { tries: 3, next: "2026-11-25T00:00:00.000Z" },
    };
    const lacking = new Set(["doi:10.1/a", "doi:10.1/new"]);
    const asked = [
      { key: "doi:10.1/a", outcome: "unchecked" },
      { key: "doi:10.1/new", outcome: "unchecked" },
    ] as const;
    expect(nextAttempts(previous, lacking, asked, start)).toEqual({
      "doi:10.1/a": { tries: 3, next: "2026-11-26T03:00:00.000Z" },
      "doi:10.1/new": { tries: 0, next: "2026-11-26T03:00:00.000Z" },
    });
  });
  it("treats a paper as due when it has no entry or its time has come", () => {
    const attempts = {
      "doi:10.1/a": { tries: 1, next: "2026-11-26T03:00:00.000Z" },
    };
    expect(isDue(attempts, "doi:10.1/a", start)).toBe(false);
    expect(isDue(attempts, "doi:10.1/a", new Date(start.getTime() + DAY))).toBe(
      true,
    );
    expect(isDue(attempts, "doi:10.1/new", start)).toBe(true);
  });
  it("reads a missing or damaged ledger as empty", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "attempts-"));
    expect(await readAttempts(dir)).toEqual({});
    writeFileSync(path.join(dir, ATTEMPTS_FILE), "{not json");
    expect(await readAttempts(dir)).toEqual({});
  });
});

function venuePaper(doi: string, hasAbstract: boolean) {
  return {
    paperId: `pap_${doi}`,
    key: `doi:${doi}`,
    title: `Paper ${doi}`,
    abstract: null,
    authors: [],
    source: "venue",
    venue: "IJCV",
    venueKind: "journal",
    year: 2026,
    publishedOn: "2026-11-20",
    categories: [],
    identifiers: [{ scheme: "doi", value: doi }],
    topics: [],
    shortlisted: false,
    rankInSource: null,
    hfUpvotes: null,
    day: "2026-11-20",
    hasAbstract,
  };
}
const history = (found: readonly string[] = []): HistoryDay[] =>
  [
    {
      day: "2026-11-20",
      items: ["10.1/a", "10.1/b"].map((doi) =>
        venuePaper(doi, found.includes(doi)),
      ),
    },
  ] as unknown as HistoryDay[];

async function crawl(dir: string, now: Date, past: HistoryDay[]) {
  const config = defineConfig({
    sources: {
      arxiv: { categories: [] },
      huggingface: { dailyPapers: false },
      venues: {
        watchlist: new URL("./fixtures/round3/venues.json", import.meta.url)
          .pathname,
      },
    },
  });
  return sourceCrawl(config, {
    cwd: "/",
    dir,
    env: {},
    fetch: vi.fn() as typeof fetch,
    now: () => now,
    sleep: async () => {},
    warn: () => {},
  })(now.toISOString().slice(0, 10), [], null, past);
}

describe("the daily run's abstract retry", () => {
  it("asks again for a missed abstract only once its wait is over", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "crawl-"));
    lookup.asked = [];
    lookup.found = { "doi:10.1/b": "Found later" };
    const first = await crawl(dir, start, history());
    expect(lookup.asked).toEqual([["doi:10.1/a", "doi:10.1/b"]]);
    expect(Object.values(first.days).flat()).toEqual([
      expect.objectContaining({ key: "doi:10.1/b", abstract: "Found later" }),
    ]);
    // A resumable run keeps the state under the names its snapshot accepts.
    expect(Object.keys(first.venueState ?? {})).toEqual([ATTEMPTS_FILE]);
    expect(ATTEMPTS_FILE).toMatch(STATE_FILE);
    // Venue progress waits for deferred papers; the ledger does not.
    await first.complete?.();
    expect(() => readFileSync(path.join(dir, ATTEMPTS_FILE))).toThrow();
    await first.settled?.();
    expect(
      JSON.parse(readFileSync(path.join(dir, ATTEMPTS_FILE), "utf8")),
    ).toEqual({
      "doi:10.1/a": { tries: 1, next: "2026-11-26T03:00:00.000Z" },
    });

    // The next runs the same day leave the miss alone.
    await crawl(dir, new Date(start.getTime() + DAY / 4), history(["10.1/b"]));
    expect(lookup.asked).toHaveLength(1);

    // A day later it is asked again, and now waits two days.
    const later = await crawl(
      dir,
      new Date(start.getTime() + DAY),
      history(["10.1/b"]),
    );
    expect(lookup.asked.at(-1)).toEqual(["doi:10.1/a"]);
    await later.settled?.();
    expect(
      JSON.parse(readFileSync(path.join(dir, ATTEMPTS_FILE), "utf8"))[
        "doi:10.1/a"
      ],
    ).toEqual({ tries: 2, next: "2026-11-28T03:00:00.000Z" });
  });
  it("asks once for a paper listed on two days, and only a day later after an outage", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "crawl-"));
    lookup.asked = [];
    lookup.found = {};
    lookup.unchecked = ["doi:10.1/a", "doi:10.1/b"];
    const twice = [
      ...history(),
      { ...history()[0]!, day: "2026-11-21" },
    ] as HistoryDay[];
    const first = await crawl(dir, start, twice);
    expect(lookup.asked).toEqual([["doi:10.1/a", "doi:10.1/b"]]);
    await first.settled?.();
    expect(
      JSON.parse(readFileSync(path.join(dir, ATTEMPTS_FILE), "utf8")),
    ).toEqual({
      "doi:10.1/a": { tries: 0, next: "2026-11-26T03:00:00.000Z" },
      "doi:10.1/b": { tries: 0, next: "2026-11-26T03:00:00.000Z" },
    });
    lookup.unchecked = [];
  });
  it("records nothing when the run's ingest does not complete", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "crawl-"));
    lookup.asked = [];
    lookup.found = {};
    await crawl(dir, start, history());
    await crawl(dir, new Date(start.getTime() + DAY / 4), history());
    expect(lookup.asked).toHaveLength(2);
  });
});
