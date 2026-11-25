import { expect, it } from "vitest";
import { paperInput, summaryInput, digestInput } from "../src/contracts";
it("S2/S3 enforces the same bounds and URL rules at the repository boundary", () => {
  expect(paperInput.safeParse({ title: "x".repeat(1001) }).success).toBe(false);
  expect(
    paperInput.safeParse({ title: "T", abstract: "x".repeat(20001) }).success,
  ).toBe(false);
  expect(
    paperInput.safeParse({
      title: "T",
      links: [{ kind: "code", url: "javascript:alert(1)" }],
    }).success,
  ).toBe(false);
  expect(
    summaryInput.safeParse({
      paperId: "pap_p",
      content: {
        tldr: "x".repeat(5001),
        motivation: "M",
        method: "M",
        result: "R",
        conclusion: "C",
      },
    }).success,
  ).toBe(false);
  expect(
    digestInput.safeParse({ day: "2026-11-17", bodyMd: "x".repeat(200001) })
      .success,
  ).toBe(false);
});
