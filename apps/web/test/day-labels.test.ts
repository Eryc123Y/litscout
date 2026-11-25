import { expect, it } from "vitest";
import { dayLabels } from "../src/model";

const days = [
  {
    day: "2026-11-18",
    status: "crawled",
    counts: { total: 643, sources: { arxiv: 565 } },
  },
  {
    day: "2026-11-17",
    status: "crawled",
    counts: { total: 1254, sources: { arxiv: 1104 } },
  },
  {
    day: "2026-11-16",
    status: "final",
    counts: { total: 372, sources: { arxiv: 372 } },
  },
] as const;

it("labels a day the runs skipped instead of calling it in progress", () => {
  const labels = dayLabels(days, false, true);
  expect(labels.get("2026-11-17")).toBe("Skipped: no digest");
  expect(labels.get("2026-11-18")).toBe("Summaries in progress");
  expect(labels.get("2026-11-16")).toBe("Final digest");
  // On an older page the target is not in view, so nothing is called skipped.
  expect(dayLabels(days, false, false).get("2026-11-17")).toBe(
    "Summaries in progress",
  );
});
