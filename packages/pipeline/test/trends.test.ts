import { expect, it } from "vitest";
import { aggregateTrends, trendTermMatcher } from "../src/trends";
import { shiftMonth } from "../src/trends-contracts";

it("counts unique papers, final picks, radar grades and monthly reading activity", () => {
  const recent = {
    paperId: "p1",
    title: "Stereo wavelets",
    abstract: "Wavelets preserve details",
    topics: ["Depth"],
    shortlisted: true,
  };
  const previousPaper = {
    paperId: "p3",
    title: "Stereo filters",
    abstract: "Filters preserve details",
    topics: ["Depth"],
    shortlisted: false,
  };
  const [row] = aggregateTrends(
    "2026-11",
    [{ name: "Depth", keywords: ["stereo reconstruction"] }],
    {
      papers: [
        recent,
        { ...recent, shortlisted: false },
        { ...recent, paperId: "p2", shortlisted: false },
      ],
      picks: ["p1", "p1", "p3"],
      radar: [
        { paperId: "p1", level: "high" },
        { paperId: "p1", level: "high" },
        { paperId: "p3", level: "borrow" },
      ],
      events: [
        { paperId: "p1", kind: "rate_down" },
        { paperId: "p1", kind: "rate_up" },
        { paperId: "p3", kind: "save" },
        { paperId: "p3", kind: "rate_down" },
        { paperId: "p3", kind: "rate_clear" },
      ],
      references: [previousPaper],
    },
    { papers: [previousPaper], picks: [] },
  );
  expect(row).toMatchObject({
    topic: "Depth",
    month: "2026-11",
    volume: 2,
    shortlisted: 1,
    radar: { high: 1, medium: 0, borrow: 1 },
    picks: ["p3", "p1"],
    activity: [
      { paperId: "p3", rating: null, saved: true },
      { paperId: "p1", rating: "up", saved: false },
    ],
  });
  expect(row!.recurring[0]).toMatchObject({ term: "details", count: 2 });
  expect(row!.rising.map(({ term }) => term)).toContain("wavelets");
  expect(row!.recurring.map(({ term }) => term)).not.toContain("stereo");
  expect(row!.rising.map(({ term }) => term)).not.toContain("filters");
});

it("uses whole normalized terms in titles and abstracts and rolls over years", () => {
  expect(trendTermMatcher("wavelets")("ＷＡＶＥＬＥＴＳ and depth")).toBe(true);
  expect(trendTermMatcher("wavelets")("waveletstuff")).toBe(false);
  expect(shiftMonth("2026-01", -1)).toBe("2025-12");
  expect(shiftMonth("2026-12", 1)).toBe("2027-01");
});

it("ranks recurring terms by how specific they are to the topic in that month", () => {
  // "camera" is in every abstract; "gaussian" only in the vision papers.
  const paper = (paperId: string, topic: string, abstract: string) => ({
    paperId,
    title: paperId,
    abstract,
    topics: [topic],
    shortlisted: true,
  });
  const papers = [
    paper("v1", "Vision", "Gaussian splatting camera demonstrate"),
    paper("v2", "Vision", "Gaussian splatting camera demonstrate"),
    paper("v3", "Vision", "Gaussian camera demonstrate"),
    paper("l1", "Language", "Token camera demonstrate"),
    paper("l2", "Language", "Token camera demonstrate"),
    paper("l3", "Language", "Token camera demonstrate"),
  ];
  const [vision] = aggregateTrends(
    "2026-11",
    [{ name: "Vision", keywords: [] }],
    { papers, picks: [], radar: [], events: [], references: [] },
    { papers: [], picks: [] },
  );
  const terms = vision!.recurring.map(({ term }) => term);
  expect(terms.slice(0, 2)).toEqual(["gaussian", "splatting"]);
  expect(terms.indexOf("camera")).toBeGreaterThan(terms.indexOf("splatting"));
  // Abstract boilerplate never counts as a topic term.
  expect(terms).not.toContain("demonstrate");
  expect(vision!.recurring.find(({ term }) => term === "gaussian")).toEqual({
    term: "gaussian",
    count: 3,
    score: 2.54,
  });
});

it("scales rising terms by rarity, skips filler words and records the comparison days", () => {
  const paper = (paperId: string, abstract: string) => ({
    paperId,
    title: paperId,
    abstract,
    topics: ["Vision"],
    shortlisted: false,
  });
  // "camera" is in every paper this month and "psnr" in two; neither was in
  // last month's papers. Filler words are in every paper too.
  const filler = "Furthermore researchers often camera";
  const papers = [
    paper("v1", `${filler} psnr`),
    paper("v2", `${filler} psnr`),
    ...["v3", "v4", "v5", "v6"].map((id) => paper(id, filler)),
  ];
  const previous = ["o1", "o2", "o3", "o4", "o5", "o6"].map((id) =>
    paper(id, "Lidar sweeps"),
  );
  const [row] = aggregateTrends(
    "2026-11",
    [{ name: "Vision", keywords: [] }],
    { papers, picks: [], radar: [], events: [], references: [] },
    {
      papers: previous,
      picks: [],
      days: ["2026-10-31", "2026-10-30", "2026-10-30"],
    },
  );
  const rising = row!.rising.map(({ term }) => term);
  // Rate ratio 3 times rarity ln(7/2) beats ratio 7 times rarity ln(7/6).
  expect(rising.slice(0, 2)).toEqual(["psnr", "camera"]);
  expect(row!.rising[0]).toEqual({ term: "psnr", count: 2, score: 3.76 });
  for (const word of ["furthermore", "researchers", "often"]) {
    expect(rising).not.toContain(word);
    expect(row!.recurring.map(({ term }) => term)).not.toContain(word);
  }
  expect(row!.comparison).toEqual({
    days: 2,
    first: "2026-10-30",
    last: "2026-10-31",
  });
  const [empty] = aggregateTrends(
    "2026-11",
    [{ name: "Vision", keywords: [] }],
    { papers, picks: [], radar: [], events: [], references: [] },
    { papers: [], picks: [], days: [] },
  );
  expect(empty!.comparison).toEqual({ days: 0, first: null, last: null });
});
