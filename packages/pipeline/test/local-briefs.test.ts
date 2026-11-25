import { expect, it } from "vitest";
import { schemas } from "../src/contracts/index";
const context = {
  day: "2026-11-16",
  lang: "en",
  candidates: [],
  all: [],
  ratings: [],
  radar: [],
};
it("H4 gives local brief text an independent 200000-character bound", () => {
  expect(
    schemas.context.parse({
      ...context,
      briefs: [{ path: "project-brief.md", body: "x".repeat(200000) }],
    }).briefs[0]!.body,
  ).toHaveLength(200000);
  expect(
    schemas.context.safeParse({
      ...context,
      briefs: [{ path: "project-brief.md", body: "x".repeat(200001) }],
    }).success,
  ).toBe(false);
});
it("H4 retains the tighter text bound on uploaded run stats and digest notes", () => {
  expect(
    schemas.run.safeParse({
      id: "run_bound",
      day: "2026-11-16",
      kind: "crawl",
      status: "done",
      startedAt: "2026-11-16T00:00:00Z",
      stats: { body: "x".repeat(5000) },
    }).success,
  ).toBe(true);
  expect(
    schemas.digestDraft.safeParse({ day: "2026-11-16", note: "x".repeat(5000) })
      .success,
  ).toBe(true);
  expect(
    schemas.run.safeParse({
      id: "run_private",
      day: "2026-11-16",
      kind: "crawl",
      status: "done",
      startedAt: "2026-11-16T00:00:00Z",
      stats: { body: "x".repeat(20000) },
    }).success,
  ).toBe(false);
  expect(
    schemas.digestDraft.safeParse({
      day: "2026-11-16",
      note: "x".repeat(20000),
    }).success,
  ).toBe(false);
});
