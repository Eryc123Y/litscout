import { expect, it } from "vitest";
import { radarProjectTitle } from "../src/radar-project";

// A radar entry names its project by title, by vault ID, or (older briefs)
// by a slug. The reader shows a title in every case.
it("takes the title from the vault's project index when it has one", () => {
  const index = new Map([
    ["a".repeat(64), "Sparse Reward Study"],
    ["sparse-reward-study", "Sparse rewards, revisited"],
  ]);
  expect(
    radarProjectTitle(
      { projectId: "a".repeat(64), project: "anything" },
      index,
    ),
  ).toBe("Sparse Reward Study");
  expect(radarProjectTitle({ project: "sparse-reward-study" }, index)).toBe(
    "Sparse rewards, revisited",
  );
});

it("reads a slug with no index entry as a title", () => {
  expect(radarProjectTitle({ project: "sparse-reward-study" })).toBe(
    "Sparse Reward Study",
  );
  expect(radarProjectTitle({ project: "view-synthesis-2" })).toBe(
    "View Synthesis 2",
  );
});

it("leaves a label that is not a slug as it is", () => {
  for (const label of [
    "Sparse Reward Study",
    "ViewSynth",
    "sparse",
    "RL-reuse",
  ])
    expect(radarProjectTitle({ project: label })).toBe(label);
  expect(radarProjectTitle({ project: null })).toBeNull();
  expect(radarProjectTitle({})).toBeUndefined();
});
