import { expect, it } from "vitest";
import { repairRadarProjects } from "../src/digest-put";

// 2026-11-19: a radar entry labelled "Sparse Reward Study · RL reuse"
// was saved under ViewSynth's project ID. The label is what the writer
// reasoned with; the 64-character ID is the part copied wrongly.
const projects = [
  { id: "a".repeat(64), title: "Sparse Reward Study" },
  { id: "b".repeat(64), title: "ViewSynth" },
  { id: "c".repeat(64), title: "Proof Repair Agent" },
];
const entry = {
  day: "2026-11-19",
  paperId: "pap_eca",
  level: "borrow" as const,
  fullTextRead: false,
  reason: "Outcome-only rewards",
  action: "",
  lookBack: false,
};

it("takes the project from the label when the ID names another project", () => {
  const { radar, repairs } = repairRadarProjects(
    [
      {
        ...entry,
        projectId: "b".repeat(64),
        project: "Sparse Reward Study · RL reuse",
      },
    ],
    projects,
  );
  expect(radar[0]).toMatchObject({ projectId: "a".repeat(64) });
  expect(repairs).toEqual([
    "Corrected 1 radar project ID to match its project label",
  ]);
});

it("drops an ID that names no project in the digest context, keeping the label", () => {
  const { radar, repairs } = repairRadarProjects(
    [
      { ...entry, projectId: "f".repeat(64), project: "Some old project" },
      { ...entry, paperId: "pap_2", projectId: "f".repeat(64) },
    ],
    projects,
  );
  expect(radar.map((r) => r.projectId)).toEqual([null, null]);
  expect((radar[0] as { project?: string }).project).toBe("Some old project");
  expect(repairs).toEqual([
    "Dropped 2 radar project IDs outside the digest context",
  ]);
});

it("leaves matching and unlabelled entries alone", () => {
  const input = [
    { ...entry, projectId: "c".repeat(64), project: "Proof Repair Agent" },
    { ...entry, paperId: "pap_2", projectId: "a".repeat(64) },
    { ...entry, paperId: "pap_3", projectId: null },
  ];
  const { radar, repairs } = repairRadarProjects(input, projects);
  expect(radar).toEqual(input);
  expect(repairs).toEqual([]);
});
