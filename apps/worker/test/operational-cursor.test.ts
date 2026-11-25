import { expect, it } from "vitest";
import { schemas } from "@litscout/pipeline/contracts/index";
import { isOperationalCursor } from "../src/operational-cursor";
it("H1 keeps the operational-state allowlist equivalent to the input contract", () => {
  const values: [string, unknown][] = [
    ["venue-feed", { since: "2026-11-16" }],
    ["venue-feed", { since: "2026-02-30" }],
    ["venue-feed", { since: "2026-11-16", privateBody: "PRIVATE" }],
    [
      "arxiv-listing",
      {
        listingDate: "2026-11-16",
        runDay: "2026-11-17",
        noAnnouncement: ["2026-11-15"],
      },
    ],
    [
      "arxiv-listing",
      {
        listingDate: "2026-11-16",
        runDay: "2026-11-17",
        noAnnouncement: Array(61).fill("2026-11-15"),
      },
    ],
    ["fulltext:2026-11-16", ["pap_one", "pap_two"]],
    ["fulltext:2026-11-16", ["PRIVATE"]],
    ["legacy:" + "a".repeat(32), { offset: 1000000, runId: "run_one" }],
    ["legacy:" + "a".repeat(32), { offset: 2, version: 2, runId: "run_one" }],
    ["legacy:" + "a".repeat(32), { offset: 2, version: 1 }],
    ["legacy:" + "a".repeat(32), { offset: -1 }],
    ["legacy:" + "a".repeat(32), { offset: 0.5 }],
  ];
  for (const [name, raw] of values) {
    const value = JSON.stringify(raw);
    expect(isOperationalCursor(name, value), value).toBe(
      schemas.cursor.safeParse({ name, value }).success,
    );
  }
  expect(isOperationalCursor("venue-feed", "bad JSON")).toBe(false);
  expect(isOperationalCursor("venue-feed", "x".repeat(2049))).toBe(false);
});
