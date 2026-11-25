import { beforeEach, expect, it } from "vitest";
import { clearMemoryCache } from "../src/http/cache";
import { route } from "../src/watch/route";
import { parseWatchList } from "../src/watch/watchlist";
import { json } from "@litscout/core/test/helpers/mock-fetch";
import { fixture, harness, host } from "./helpers/watch-harness";

beforeEach(() => clearMemoryCache());

const ECCV = {
  name: "ECCV",
  kind: "conference",
  group: "ML and CV conferences",
  match: "topics",
  top: true,
  container_title: "Computer Vision – ECCV {year}",
};
const ARGS = ["--venues", "list.json", "--kinds", "conference"];
const crossref = (calls: ReturnType<typeof harness>["calls"]) =>
  calls.filter((c) => c.url.hostname === "api.crossref.org");

it("reads ECCV's chapters by Crossref container title, one title per year of the window, and enriches them through OpenAlex", async () => {
  const h = harness(
    [ECCV],
    [
      {
        match: host("api.crossref.org"),
        respond: (url) =>
          json(
            url.searchParams
              .get("filter")!
              .startsWith("container-title:Computer Vision – ECCV 2026,")
              ? JSON.parse(fixture("crossref-eccv-2026.json"))
              : { message: { items: [] } },
          ),
      },
      {
        match: host("api.openalex.org"),
        respond: (url) => {
          expect(url.searchParams.get("filter")).toBe(
            "doi:10.1007/978-3-032-37086-0_36|10.1007/978-3-032-37086-0_4|10.1007/978-3-032-37086-0_9",
          );
          return json(JSON.parse(fixture("openalex-eccv-2026.json")));
        },
      },
    ],
    { OPENALEX_API_KEY: "k" },
  );
  expect(
    await h.run([...ARGS, "--since", "2026-10-04", "--until", "2026-10-04"]),
  ).toBe(0);
  // Only DOIs registered in the window are asked for, so a first read is bounded by the window.
  expect(
    crossref(h.calls).map((c) => c.url.searchParams.get("filter")),
  ).toEqual(
    [2025, 2026, 2027].map(
      (year) =>
        `container-title:Computer Vision – ECCV ${year},from-created-date:2026-10-04,until-created-date:2026-10-04`,
    ),
  );
  const lines = h.lines();
  expect(lines.map((l) => l.doi)).toEqual([
    "10.1007/978-3-032-37086-0_36",
    "10.1007/978-3-032-37086-0_4",
    "10.1007/978-3-032-37086-0_9",
  ]);
  expect(lines[0]).toEqual({
    source: "crossref",
    title:
      "Semantic-Geometric Dual Compression: Training-Free Visual Token Reduction for Ultra-High-Resolution Remote Sensing Understanding",
    authors: [
      "Yueying Li",
      "Fengxiang Wang",
      "Yan Li",
      "Mingshuo Chen",
      "Mengying Zhao",
      "Long Lan",
    ],
    venue: "ECCV",
    // Crossref gives the proceedings a year only, so the paper is dated by its DOI registration.
    published: "2026-10-04",
    doi: "10.1007/978-3-032-37086-0_36",
    arxiv_id: "2604.11122",
    openreview_id: null,
    abstract: null,
    oa_url: "https://arxiv.org/pdf/2604.11122",
    url: "https://doi.org/10.1007/978-3-032-37086-0_36",
  });
  expect(lines[1]).toMatchObject({ arxiv_id: null, oa_url: null });
  const stderr = h.stderr();
  expect(stderr).not.toContain("no OpenAlex source");
  expect(stderr).toMatch(/3 papers .*requests: Crossref 3, OpenAlex 1/);
});

it("drops corrections, chapters registered outside the window and other container titles", async () => {
  const recorded = JSON.parse(
    fixture("crossref-eccv-2026-corrections.json"),
  ) as { message: { items: Array<Record<string, unknown>> } };
  const chapter = (
    doi: string,
    created: string,
    container = "Computer Vision – ECCV 2026",
  ) => ({
    DOI: doi,
    title: [`Chapter ${doi}`],
    author: [{ given: "Ada", family: "Lovelace" }],
    created: { "date-time": `${created}T10:00:00Z` },
    published: { "date-parts": [[2026]] },
    type: "book-chapter",
    "container-title": ["Lecture Notes in Computer Science", container],
  });
  const h = harness(
    [ECCV],
    [
      {
        match: host("api.crossref.org"),
        respond: (url) =>
          json(
            url.searchParams.get("filter")!.includes("ECCV 2026,")
              ? {
                  message: {
                    items: [
                      ...recorded.message.items,
                      chapter("10.1007/kept", "2026-11-20"),
                      chapter("10.1007/early", "2026-09-09"),
                      chapter(
                        "10.1007/workshop",
                        "2026-11-20",
                        "Computer Vision – ECCV 2026 Workshops",
                      ),
                      {
                        ...chapter("10.1007/book", "2026-11-20"),
                        type: "book",
                      },
                    ],
                  },
                }
              : { message: { items: [] } },
          ),
      },
    ],
  );
  expect(
    await h.run([...ARGS, "--since", "2026-11-17", "--until", "2026-11-24"]),
  ).toBe(0);
  expect(h.lines().map((l) => l.doi)).toEqual(["10.1007/kept"]);
});

it("names Crossref when the container lookup fails, and reads the other venues", async () => {
  const h = harness(
    [ECCV, { ...ECCV, name: "MICCAI", container_title: "MICCAI {year}" }],
    [
      {
        match: host("api.crossref.org"),
        respond: (url) =>
          url.searchParams.get("filter")!.includes("ECCV")
            ? json({ message: "down" }, 500)
            : json({ message: { items: [] } }),
      },
    ],
  );
  expect(
    await h.run([...ARGS, "--since", "2026-11-17", "--until", "2026-11-24"]),
  ).toBe(0);
  expect(h.stderr()).toContain("ECCV: Crossref failed (HTTP 500)");
  expect(h.stderr()).not.toContain("MICCAI:");
});

it("asks once for a title without {year}, and warns when Crossref's page cap cuts the listing short", async () => {
  const items = Array.from({ length: 200 }, (_, i) => ({
    DOI: `10.1007/big_${i}`,
    title: [`Chapter ${i}`],
    created: { "date-time": "2026-11-20T00:00:00Z" },
    published: { "date-parts": [[2026]] },
    type: "book-chapter",
    "container-title": ["Big Proceedings"],
  }));
  const h = harness(
    [{ name: "Big", kind: "conference", container_title: "Big Proceedings" }],
    [
      {
        match: host("api.crossref.org"),
        respond: () => json({ message: { items, "next-cursor": "more" } }),
      },
    ],
  );
  expect(
    await h.run([...ARGS, "--since", "2026-11-17", "--until", "2026-11-24"]),
  ).toBe(0);
  const filters = new Set(
    crossref(h.calls).map((c) => c.url.searchParams.get("filter")),
  );
  expect([...filters]).toEqual([
    "container-title:Big Proceedings,from-created-date:2026-11-17,until-created-date:2026-11-24",
  ]);
  expect(crossref(h.calls)).toHaveLength(50);
  expect(h.lines()).toHaveLength(200);
  expect(h.stderr()).toContain(
    'Big: Crossref listed at least 10000 works of "Big Proceedings" in the window; some may be missing',
  );
});

it("reads container_title and ignores values Crossref's filter cannot take", () => {
  const warnings: string[] = [];
  const venues = parseWatchList(
    JSON.stringify({
      venues: [
        {
          name: "A",
          kind: "conference",
          container_title: " Computer Vision – ECCV {year} ",
        },
        {
          name: "B",
          kind: "conference",
          container_title: "Proceedings, Part I",
        },
        { name: "C", kind: "conference", container_title: "" },
        { name: "D", kind: "conference", container_title: 7 },
        { name: "E", kind: "conference", container_title: "x".repeat(201) },
        { name: "F", kind: "conference", container_title: "Line\nbreak" },
      ],
    }),
    (w) => warnings.push(w),
  );
  expect(venues[0]!.containerTitle).toBe("Computer Vision – ECCV {year}");
  expect(venues.slice(1).map((v) => v.containerTitle)).toEqual([
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
  expect(warnings).toEqual(
    ["B", "C", "D", "E", "F"].map(
      (name) =>
        `${name}: container_title is not a Crossref container title; ignored`,
    ),
  );
});

it("routes container_title after doi_prefix and before OpenReview and the original paths", () => {
  const venues = parseWatchList(
    JSON.stringify({
      venues: [
        { ...ECCV, doi_prefix: "10.1234/x" },
        { ...ECCV, openreview: "X", openalex_source: "S1" },
        { ...ECCV, issn: ["1"], kind: "journal" },
      ],
    }),
    () => {},
  );
  expect(venues.map((v) => route(v, true))).toEqual([
    { kind: "doi", prefix: "10.1234/x" },
    { kind: "container", title: "Computer Vision – ECCV {year}" },
    { kind: "container", title: "Computer Vision – ECCV {year}" },
  ]);
});
