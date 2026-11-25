import { ingestDigest, ingestFeedDay } from "@litscout/db/ingest";
import { ingestPapers } from "@litscout/db/ingest-papers";

// A fixed past day, so these papers never fall inside another fixture's
// "this week" window as the calendar moves on. Tests pin the browser clock to it.
export const longBriefDay = "2026-11-10";
const day = longBriefDay;
const radarTitles = [
  "Depth Completion for Moving Stereo Cameras",
  "Measuring Visual Discomfort in Head-Mounted Displays",
  "Stable Disparity for Long Video Sequences",
  "A Benchmark for Reflective Surfaces in Indoor Scenes",
  "View Synthesis with Sparse Camera Trajectories",
];
const topicPicks = [
  ["Vision", "Learning Depth from Indoor Video"],
  ["Language", "Tracing References Across Long Documents"],
  ["Robotics", "Reliable Grasping in Cluttered Workspaces"],
  ["Graphics", "Fast Rendering of Dynamic Indoor Scenes"],
  ["Audio", "Separating Overlapping Speakers in Noisy Rooms"],
  ["Systems", "Scheduling Interactive Inference on Shared GPUs"],
  ["HCI", "Comparing Reading Layouts on Small Screens"],
  ["Math", "Error Bounds for Iterative Solvers"],
  ["Learning", "Calibrating Predictions from Small Datasets"],
  ["Data", "Auditing Dataset Overlap in Evaluation"],
] as const;
const suggestionTitles = [
  "Compare depth models on the same camera motion",
  "Build a reflective surfaces reading list",
  "Track indoor video datasets by capture conditions",
];

export async function seedLongBrief(db: D1Database) {
  const titles = [...radarTitles, ...topicPicks.map(([, title]) => title)];
  const { papers, invalid } = await ingestPapers(
    db,
    day,
    titles.map((title, index) => ({
      key: `2611.${String(90000 + index)}`,
      title,
      authors: ["A. Patel", "J. Chen"],
      source: "arxiv",
      venueKind: "preprint",
      identifiers: [
        { scheme: "arxiv", value: `2611.${String(90000 + index)}` },
      ],
      rankInSource: index + 1,
      topics: [topicPicks[index - radarTitles.length]?.[0] ?? "Vision"],
      shortlisted: true,
    })),
  );
  if (invalid.length) throw new Error(JSON.stringify(invalid));
  await ingestFeedDay(db, {
    day,
    status: "final",
    counts: { total: papers.length, arxiv: papers.length },
  });
  const radar = radarTitles.map((_, index) => ({
    paperId: papers[index]!.paperId,
    level: "borrow",
    fullTextRead: false,
    project: "Stereo video",
    reason: "The reported setup overlaps with the current stereo video work.",
    action: "Read the methods section before deciding how to compare results.",
  }));
  const suggestions = suggestionTitles.map((title) => ({
    kind: "new_idea",
    title,
    bodyMd:
      "Start by recording the camera motion and depth ranges in the reported experiments. Compare capture conditions, available ground truth and evaluation measures before choosing a baseline. "
        .repeat(4)
        .trim(),
    ideaIds: [],
    paperIds: [papers[0]!.paperId],
    projectIds: [],
  }));
  await ingestDigest(db, {
    day,
    lang: "en",
    final: true,
    picks: papers.slice(radar.length).map(({ paperId }) => paperId),
    radar,
    suggestions,
    bodyMd: [
      "## Radar",
      ...radar.map(
        ({ reason, action }, index) =>
          `### ${radarTitles[index]}\n\n${reason} ${action}`,
      ),
      "## Picks per topic",
      topicPicks
        .map(([topic, title]) => `- **${topic}** · ${title}`)
        .join("\n"),
      "## Idea suggestions",
      ...suggestions.map(({ title, bodyMd }) => `### ${title}\n\n${bodyMd}`),
    ].join("\n\n"),
  });
}
