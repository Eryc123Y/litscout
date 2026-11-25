import { expect, it } from "vitest";
import {
  canonicalId,
  oldDigestFacts,
  pickOverlap,
} from "../src/shadow-compare";

// Lines in the shape of the old pipeline's 2026-11-18 digest.
const oldDigest = [
  "# LitScout 日报 · 2026-11-18（周三）",
  "",
  "**1106 篇新论文 · 期刊 22 篇**（arXiv 2026-11-17 批次）（摘要 1127/1128）· [打开当天](https://litscout.example/#day=2026-11-17)",
  "",
  "**HF 热门**（11-16 那批）：[Hot paper](https://litscout.example/#day=2026-11-16&topic=all&paper=2611.99999)",
  "",
  "**雷达**：",
  "- [Radar one](https://litscout.example/#day=2026-11-17&topic=RL&paper=2611.20001) — reason",
  "",
  "**2D-to-3D and stereo**（匹配 12 · [全部](https://litscout.example/#day=2026-11-17&topic=2D-to-3D%20and%20stereo)）",
  "- [Stereo pick](https://litscout.example/#day=2026-11-17&topic=2D-to-3D%20and%20stereo&paper=2611.20629v2) — gist",
  "- [Journal pick](https://litscout.example/#day=2026-11-17&topic=Journals&paper=doi%3A10.1000%2FABC.1) — gist",
  "- [Repeat](https://litscout.example/#day=2026-11-17&topic=RL&paper=2611.20001) — gist",
].join("\n");

it("reads the old digest's reading day and picks, skipping the HF list and repeats", () => {
  expect(oldDigestFacts(oldDigest)).toEqual({
    readingDay: "2026-11-17",
    ids: ["2611.20001", "2611.20629", "10.1000/abc.1"],
  });
  expect(oldDigestFacts("No links here.")).toEqual({
    readingDay: null,
    ids: [],
  });
});

it("counts a new pick as shared when any of its identifiers is an old pick", () => {
  const old = ["2611.20001", "2611.20629", "doi:10.1000/abc.1"];
  const picks = [
    // DOI and arXiv both known: matched through the arXiv ID.
    { identifiers: ["doi:10.5555/x.1", "2611.20629"] },
    { identifiers: ["doi:10.1000/ABC.1"] },
    { identifiers: ["2611.30000"] },
  ];
  expect(pickOverlap(old, picks)).toEqual({ intersection: 2, union: 4 });
  expect(pickOverlap([], [])).toEqual({ intersection: 0, union: 0 });
});

it("matches DOIs with or without a prefix, old-style arXiv versions, and repeated new picks once", () => {
  expect(canonicalId("doi:10.1000/ABC.1")).toBe("10.1000/abc.1");
  expect(canonicalId("https://doi.org/10.1000/ABC.1")).toBe("10.1000/abc.1");
  expect(canonicalId("hep-th/9901001v2")).toBe("hep-th/9901001");
  expect(
    pickOverlap(
      ["10.1000/abc.1"],
      [
        { identifiers: ["doi:10.1000/ABC.1"] },
        { identifiers: ["doi:10.1000/ABC.1"] },
      ],
    ),
  ).toEqual({ intersection: 1, union: 1 });
});

it("takes the reading day from the digest header, not from paper text further down", () => {
  const md = [
    "# LitScout 日报 · 2026-11-18（周三）",
    "**1106 篇新论文**（arXiv 2026-11-17 批次）",
    "",
    "- [A](https://x/#day=2026-11-17&paper=2611.20001) — mentions arXiv 2025-01-01 批次 in a gist",
  ].join("\n");
  expect(oldDigestFacts(md).readingDay).toBe("2026-11-17");
  expect(
    oldDigestFacts(
      [
        "# Title",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "late (arXiv 2025-01-01 批次)",
      ].join("\n"),
    ).readingDay,
  ).toBeNull();
});
