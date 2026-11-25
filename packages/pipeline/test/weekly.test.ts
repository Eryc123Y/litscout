import { expect, it } from "vitest";
import { findMisses, weekHealth, weeklyCounts } from "../src/weekly";
import { radarSchema } from "../src/contracts/index";
it("records a look-back only if the paper was listed before discovery and not already missed", () => {
  const row = radarSchema.parse({
    day: "2026-11-22",
    paperId: "pap_a",
    level: "borrow",
    reason: "reuse",
    lookBack: true,
  });
  expect(
    findMisses([row], new Map([["pap_a", "2026-11-17"]]), []),
  ).toHaveLength(1);
  expect(
    findMisses(
      [row, { ...row, paperId: "pap_other" }],
      new Map([["pap_a", "2026-11-22"]]),
      [],
    ),
  ).toEqual([]);
  expect(
    findMisses([row], new Map([["pap_a", "2026-11-17"]]), ["pap_a"]),
  ).toEqual([]);
});
it("counts on-time reports only when weekday data landed by 10:00 in the instance timezone", () => {
  const run = (day: string, kind: string, at: string, status = "done") => ({
    id: "run_" + at,
    day,
    kind,
    startedAt: at,
    finishedAt: at,
    status,
  });
  const rows = [
    run("2026-11-17", "crawl", "2026-11-17T01:00:00Z"),
    run("2026-11-17", "digest", "2026-11-17T03:00:00Z"),
    run("2026-11-17", "summaries", "2026-11-17T02:00:00Z", "paused"),
    run("2026-11-18", "crawl", "2026-11-18T04:00:00Z"),
  ];
  const health = weekHealth(
    rows,
    ["2026-11-17", "2026-11-18"],
    "Asia/Shanghai",
    "en",
  );
  expect(health).toContain("1/1");
  expect(health).toContain(
    "17 Nov 2026, 09:00 GMT+8 → — → 17 Nov 2026, 11:00 GMT+8",
  );
  expect(weekHealth([], ["2026-11-22"], "UTC", "zh")).toContain("准时");
});
it("counts journal picks under their topics", () => {
  const p = {
    paperId: "p",
    title: "T",
    authors: [],
    abstract: null,
    source: "crossref",
    venue: "Journal",
    topics: ["Vision"],
    shortlisted: true,
    summaries: [],
    links: [],
    identifiers: [],
  };
  const text = weeklyCounts(
    "2026-11-22",
    [{ day: "2026-11-17", picks: ["p"] }],
    [p],
    [{ name: "Vision" }],
    "en",
  );
  expect(text).toContain("Vision: 1");
  expect(text).toContain("Journal 1");
});
