import { describe, expect, it } from "vitest";
import { legacyRoute, filterPapers, dayLabel, monthDays } from "../src/model";
import { readTheme, resolveTheme, topicColour } from "../src/theme";
import { apiGet } from "../src/api";
import { webDaysSchema } from "@litscout/pipeline/web-contracts";
const paper = {
  paperId: "pap_a",
  title: "Stereo",
  abstract: "Depth",
  authors: [{ name: "Ada" }],
  source: "arxiv",
  topics: ["Vision"],
  shortlisted: true,
  summaries: [],
  identifiers: [],
  links: [],
  venue: null,
  venueKind: "preprint",
  year: 2026,
  publishedOn: null,
  categories: ["cs.CV"],
  hfUpvotes: 12,
};
describe("reader model", () => {
  it("redirects legacy ids and topics safely", () => {
    expect(
      legacyRoute("#day=2026-11-17&topic=Vision&paper=2611.00001", true),
    ).toBe("/public/days/2026-11-17?topic=Vision&paper=2611.00001");
    expect(legacyRoute("#day=oops&paper=pap_a", false)).toBe(
      "/app/today?paper=pap_a",
    );
    expect(legacyRoute("#section", true)).toBeNull();
  });
  it("combines search, topic, source, venue and shortlist filters", () => {
    expect(
      filterPapers([paper], {
        q: "ADA",
        topic: "Vision",
        source: "arxiv",
        shortlisted: true,
        venue: "",
      }),
    ).toHaveLength(1);
    for (const f of [
      { q: "missing" },
      { topic: "NLP" },
      { source: "journal" },
      { venue: "Nature" },
    ])
      expect(filterPapers([paper], f)).toHaveLength(0);
    expect(
      filterPapers([{ ...paper, shortlisted: false }], { shortlisted: true }),
    ).toHaveLength(0);
    expect(dayLabel("pending")).toContain("Pending");
    expect(dayLabel("empty")).toContain("No announcement");
    expect(monthDays("2026-02")).toHaveLength(28);
  });
});
it("preserves OKLCH topic colours and resilient appearance choices", () => {
  expect(topicColour(2)).toBe("oklch(var(--topic-l-a) 0.1 275)");
  // One choice: follow the system (default), light (Journal) or dark (Graphite).
  expect(readTheme({ getItem: () => null })).toEqual({ mode: "system" });
  expect(
    readTheme({
      getItem: () => {
        throw Error();
      },
    }).mode,
  ).toBe("system");
  expect(resolveTheme({ mode: "system" }, true)).toBe("graphite");
  expect(resolveTheme({ mode: "system" }, false)).toBe("journal");
  // Palette choices saved by older versions are ignored; the mode survives.
  const saved: Record<string, string> = {
    "litscout-mode": "dark",
    "litscout-light": "graphite",
    "litscout-dark": "anaglyph",
  };
  expect(readTheme({ getItem: (k) => saved[k] ?? null })).toEqual({
    mode: "dark",
  });
});
it("uses same-origin Access cookies and validates both envelopes and payloads", async () => {
  const fetcher = async (
    _path: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    expect(init?.credentials).toBe("same-origin");
    return Response.json({ success: true, data: [] });
  };
  expect(await apiGet("/feed/days", webDaysSchema, undefined, fetcher)).toEqual(
    [],
  );
  await expect(
    apiGet("/feed/days", webDaysSchema, undefined, async () =>
      Response.json(
        { success: false, error: { message: "Sign in" } },
        { status: 401 },
      ),
    ),
  ).rejects.toThrow("Sign in");
  await expect(
    apiGet("/feed/days", webDaysSchema, undefined, async () =>
      Response.json({ success: true, data: "bad" }),
    ),
  ).rejects.toThrow();
});
it("handles missing legacy dates, empty filters, malformed links and month input", async () => {
  expect(legacyRoute("#topic=Vision", false)).toBe("/app/today?topic=Vision");
  expect(legacyRoute("#day=2026-11-17", false)).toBe("/app/days/2026-11-17");
  expect(filterPapers([paper], {})).toHaveLength(1);
  expect(filterPapers([paper], { q: " " })).toHaveLength(1);
  expect(monthDays("bad")).toEqual([]);
  expect(dayLabel("unknown")).toBe("unknown");
  const { safeUrl, matchesPaper, today } = await import("../src/model");
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,hi",
    "/relative",
    "bad",
    undefined,
  ])
    expect(safeUrl(url)).toBeUndefined();
  expect(safeUrl("https://example.org")).toBe("https://example.org/");
  expect(
    matchesPaper(
      { ...paper, identifiers: [{ scheme: "arxiv", value: "2611.1" }] },
      "arxiv:2611.1",
    ),
  ).toBe(true);
  expect(matchesPaper(paper, "pap_a")).toBe(true);
  expect(matchesPaper(paper, "absent")).toBe(false);
  expect(today("UTC")).toMatch(/^\d{4}-\d\d-\d\d$/);
  expect(resolveTheme({ mode: "light" }, true)).toBe("journal");
  expect(resolveTheme({ mode: "dark" }, false)).toBe("graphite");
  expect(readTheme({ getItem: () => "invalid" }).mode).toBe("system");
});
it("rejects non-JSON, unsuccessful envelopes, malformed envelopes and unauthorised responses", async () => {
  for (const [response, message] of [
    [new Response("<html>"), "did not return feed data"],
    [Response.json({ success: false }), "could not be loaded"],
    [Response.json({ success: true, data: [] }, { status: 403 }), "Sign in"],
  ] as const)
    await expect(
      apiGet("/feed/days", webDaysSchema, undefined, async () => response),
    ).rejects.toThrow(message);
  await expect(
    apiGet("/feed/days", webDaysSchema, undefined, async () =>
      Response.json({}),
    ),
  ).rejects.toThrow();
});
it("aligns calendar dates with Monday-first weekday headings", async () => {
  const { calendarOffset } = await import("../src/model");
  expect(calendarOffset("2026-11")).toBe(6);
  expect(calendarOffset("2026-06")).toBe(0);
});

it("P1 minimal landing payload defaults to private without inventing configured fields", async () => {
  const { instanceSchema } = await import("@litscout/pipeline/web-contracts");
  const info = await apiGet("/instance", instanceSchema, undefined, async () =>
    Response.json({ success: true, data: { name: "LitScout" } }),
  );
  expect(info).toEqual({
    name: "LitScout",
    publicFeed: false,
    language: "en",
    timezone: "UTC",
    topics: [],
  });
});

describe("every link of the old LitScout Daily site has a target (H0)", () => {
  const topics = ["2D-to-3D and stereo", "Continual learning"];
  it.each([
    // A day, its topic and an opened paper (arXiv ID, DOI, OpenReview, URL).
    ["#day=2026-11-17", "/public/days/2026-11-17"],
    [
      "#day=2026-11-17&topic=2D-to-3D+and+stereo&paper=2611.00001",
      "/public/days/2026-11-17?topic=2D-to-3D+and+stereo&paper=2611.00001",
    ],
    [
      "#day=2026-11-17&paper=doi%3A10.1109%2Ftvcg.2026.3747406",
      "/public/days/2026-11-17?paper=doi%3A10.1109%2Ftvcg.2026.3747406",
    ],
    [
      "#day=2026-11-17&paper=openreview%3AabcXYZ",
      "/public/days/2026-11-17?paper=openreview%3AabcXYZ",
    ],
    // A topic the instance no longer has is left out, not shown as empty.
    ["#day=2026-11-17&topic=Vision", "/public/days/2026-11-17"],
    // A day range opens its last day; the new reader shows one day at a time.
    ["#day=2026-11-17&from=2026-11-10", "/public/days/2026-11-17"],
    // Venue filters: the label, and the type mapped to kind and top venues.
    [
      "#day=2026-11-17&venue=IEEE+TCSVT",
      "/public/days/2026-11-17?venue=IEEE+TCSVT",
    ],
    ["#day=2026-11-17&type=arxiv", "/public/days/2026-11-17?kind=preprint"],
    [
      "#day=2026-11-17&type=conference",
      "/public/days/2026-11-17?kind=conference&top=true",
    ],
    [
      "#day=2026-11-17&type=journal",
      "/public/days/2026-11-17?kind=journal&top=true",
    ],
    // Filters the new reader does not have are dropped.
    [
      "#day=2026-11-17&type=other&area=ML+and+vision&code=1&free=1",
      "/public/days/2026-11-17",
    ],
    ["#day=2026-11-17&type=weird", "/public/days/2026-11-17"],
    // The venue stream of one week: the day list, from the end of that week.
    ["#stream=venues&week=2026-11-09", "/public/days?before=2026-11-16"],
    ["#stream=venues&week=bad", "/public/days"],
    // Without a day: the newest day.
    ["#code=1", "/public/today"],
  ])("%s → %s", (hash, target) => {
    expect(legacyRoute(hash, true, topics)).toBe(target);
  });
  it("keeps the private prefix and ignores hashes that are not old links", () => {
    expect(legacyRoute("#day=2026-11-17&type=arxiv", false, topics)).toBe(
      "/app/days/2026-11-17?kind=preprint",
    );
    expect(legacyRoute("#stream=venues&week=2026-11-09", false)).toBe(
      "/app/days?before=2026-11-16",
    );
    expect(legacyRoute("#day=2026-11-17&topic=Vision", true, [])).toBe(
      "/public/days/2026-11-17?topic=Vision",
    );
    expect(legacyRoute("#digest", true, topics)).toBeNull();
    expect(legacyRoute("", true, topics)).toBeNull();
  });
});
