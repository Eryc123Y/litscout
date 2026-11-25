import { ingestDigest, ingestFeedDay } from "@litscout/db/ingest";
import { ingestPapers } from "@litscout/db/ingest-papers";
import { ingestSummaryRecords } from "@litscout/db/ingest-records";

// One invented day for `pnpm web:demo` and the README's pictures. Every
// paper, author and result here is made up: nothing describes a real work.
export const demoDay = "2026-11-12";

type Demo = {
  title: string;
  topic: "Vision" | "Language" | "Robotics" | "Evaluation";
  authors: string[];
  abstract: string;
  tldr: string;
  method: string;
  result: string;
  code?: boolean;
  upvotes?: number;
};
const papers: Demo[] = [
  {
    title: "Sparse-View Depth from Handheld Video Without Calibration",
    topic: "Vision",
    authors: ["Mira Okafor", "Jonas Lindqvist", "Tae-yang Seo"],
    abstract:
      "Depth estimation from casual video usually assumes known camera intrinsics. We estimate depth and intrinsics together from eight frames of handheld footage and study where the joint estimate fails.",
    tldr: "Joint depth and intrinsics from eight handheld frames comes within 4% of calibrated baselines indoors, and fails on scenes with little parallax.",
    method:
      "A shared transformer predicts per-frame depth and one set of intrinsics, trained with a reprojection loss on 2,100 phone videos.",
    result:
      "Relative depth error rises from 5.1% (calibrated) to 5.3% indoors; on low-parallax clips it doubles.",
    code: true,
  },
  {
    title: "Temporal Consistency Losses for Stereo Video Generation",
    topic: "Vision",
    authors: ["Elena Marchetti", "Kofi Asante"],
    abstract:
      "Generated right-eye views flicker when each frame is produced independently. We compare three temporal losses for stereo video generation on the same backbone and budget.",
    tldr: "A disparity-smoothness loss over a five-frame window removes most flicker at no cost in per-frame quality; optical-flow warping helps less.",
    method:
      "Three losses are added one at a time to the same diffusion backbone and compared on 300 held-out clips.",
    result:
      "Temporal disparity jitter drops by 61% with the window loss, against 34% for flow warping.",
  },
  {
    title: "What Do Depth Foundation Models Miss on Transparent Objects?",
    topic: "Vision",
    authors: ["Hana Yoshikawa", "Peter Nwosu", "Sofia Brandt"],
    abstract:
      "Glass and clear plastic remain hard for monocular depth models. We collect 1,200 tabletop scenes with measured ground truth and test six recent models.",
    tldr: "Six depth models place transparent objects on the surface behind them in 43% to 71% of cases; fine-tuning on 300 scenes halves the error.",
    method:
      "Ground truth comes from a second capture of each scene with the objects sprayed matte.",
    result:
      "The best model's error on transparent regions is 3.8 times its error elsewhere.",
    code: true,
  },
  {
    title:
      "A Lightweight Benchmark for Novel-View Synthesis Under Camera Shake",
    topic: "Vision",
    authors: ["Arjun Mehta", "Clara Fontaine"],
    abstract:
      "View-synthesis benchmarks use steady captures. We add controlled shake to 40 scenes and report how reconstruction quality degrades for five methods.",
    tldr: "Moderate camera shake costs five view-synthesis methods 1.9 to 4.6 dB; pose refinement recovers about half of it.",
    method:
      "Each scene is captured on a rig that replays recorded hand tremor at three strengths.",
    result:
      "Methods that refine poses lose 1.9 dB at the middle strength; the others lose 3.7 dB or more.",
  },
  {
    title: "Long-Document Question Answering with Citation-Grounded Retrieval",
    topic: "Language",
    authors: ["Nadia Rahman", "Lukas Weber", "Imani Clarke"],
    abstract:
      "Answers over long documents are hard to check. We require every answer sentence to cite a retrieved span and measure what this does to accuracy and to verification time.",
    tldr: "Forcing each answer sentence to cite a span costs 1.2 points of accuracy and cuts the time annotators need to verify an answer by 40%.",
    method:
      "A retriever proposes spans, and the generator may only write sentences that copy a citation marker.",
    result:
      "On 2,400 questions over reports of 80 pages or more, accuracy moves from 71.4% to 70.2%.",
    code: true,
    upvotes: 31,
  },
  {
    title:
      "Do Tokenizers Matter for Low-Resource Morphology? A Controlled Study",
    topic: "Language",
    authors: ["Tomasz Zielinski", "Amara Diallo"],
    abstract:
      "Subword tokenizers split morphologically rich words in ways that ignore their structure. We train matched models with four tokenizers on nine low-resource languages.",
    tldr: "A morphology-aware tokenizer helps inflection tasks by 6 points on average in nine low-resource languages and makes no difference for translation.",
    method:
      "Models share data, size and training steps; only the tokenizer changes.",
    result:
      "Inflection accuracy improves in eight of nine languages; translation scores stay within noise.",
  },
  {
    title:
      "Measuring How Often Chat Models Change Their Answer When Asked Twice",
    topic: "Language",
    authors: ["Grace Mwangi", "Daniel Park", "Ines Carvalho"],
    abstract:
      "Asking a model the same question again can flip its answer. We measure this for eight models on 5,000 factual questions and relate it to accuracy.",
    tldr: "Eight chat models change a factual answer on a second asking 3% to 19% of the time, and the flipped answers are wrong twice as often as the stable ones.",
    method:
      "Each question is asked five times at the provider's default settings, with and without a polite challenge.",
    result:
      "Answer stability predicts correctness better than the models' stated confidence.",
  },
  {
    title:
      "Curriculum Effects in Small Language Models Trained on Child-Directed Speech",
    topic: "Language",
    authors: ["Oskar Nilsen", "Priya Raman"],
    abstract:
      "Children hear simpler speech first. We test whether ordering 10 million words of child-directed speech by complexity helps a small language model.",
    tldr: "Ordering child-directed speech from simple to complex speeds early learning but leaves the final scores of a 10M-word model unchanged.",
    method:
      "Three orderings of the same corpus are compared across five seeds.",
    result:
      "The curriculum reaches the midpoint score 22% sooner; final grammar scores differ by less than one seed's spread.",
  },
  {
    title: "Learning Grasp Recovery from Failed Attempts",
    topic: "Robotics",
    authors: ["Yuki Tanabe", "Marcus Ellison", "Leila Haddad"],
    abstract:
      "Most grasping systems retry a failed grasp from scratch. We learn a recovery policy from 18,000 logged failures and test it on unseen objects.",
    tldr: "A recovery policy trained on logged failures lifts second-attempt grasp success on unseen objects from 54% to 78%.",
    method:
      "The policy sees the failed grasp's tactile trace and proposes a correction to the grasp pose.",
    result:
      "Most of the gain comes from slips; grasps that missed the object entirely improve little.",
    code: true,
  },
  {
    title:
      "Sim-to-Real Transfer for Deformable Object Folding with Tactile Feedback",
    topic: "Robotics",
    authors: ["Chen Bao", "Astrid Holm"],
    abstract:
      "Cloth folding policies trained in simulation break on real fabric. We add tactile feedback at the fingertips and measure transfer on five fabric types.",
    tldr: "Adding fingertip tactile feedback raises real-world folding success from 41% to 69% for policies trained only in simulation.",
    method:
      "Tactile signals are simulated with a simple contact model and randomised stiffness.",
    result:
      "The gain holds for four of five fabrics; thin silk still fails most trials.",
  },
  {
    title: "Open-Vocabulary Navigation with Memory Maps",
    topic: "Robotics",
    authors: ["Rafael Monteiro", "Sana Qureshi"],
    abstract:
      "Robots asked to find an object by name re-explore rooms they have seen. We keep a map of language features and test navigation over several days.",
    tldr: "A persistent map of language features cuts the distance travelled to find a named object by 37% on the second day in the same building.",
    method:
      "Image features are projected into a floor map that later queries search first.",
    result:
      "First-day performance is unchanged; the benefit appears once the map covers the building.",
    code: true,
  },
  {
    title: "Benchmark Leakage in Code Generation: An Audit of 14 Test Sets",
    topic: "Evaluation",
    authors: ["Fatima Idris", "Noah Bergstrom", "Li Wen"],
    abstract:
      "Public test sets end up in training data. We search for near-duplicates of 14 code generation benchmarks in three open training corpora.",
    tldr: "Between 2% and 38% of the problems in 14 code benchmarks have near-duplicates in open training corpora; scores on the clean subsets are 4 to 11 points lower.",
    method:
      "Problems are matched by normalised solution text and checked by hand on a sample.",
    result:
      "Model rankings change on five of the fourteen benchmarks once leaked problems are removed.",
    code: true,
  },
  {
    title: "Calibrated Confidence Intervals for Small Evaluation Sets",
    topic: "Evaluation",
    authors: ["Hugo Lefevre", "Zanele Khumalo"],
    abstract:
      "Many evaluations report a single number from a few hundred examples. We compare interval methods on simulated and real evaluation sets of 50 to 500 items.",
    tldr: "On evaluation sets under 200 items, the usual normal-approximation interval covers the true score only 86% of the time; a Wilson interval restores 95%.",
    method:
      "Coverage is measured by resampling from large evaluation sets with known scores.",
    result:
      "The gap closes above 400 items; below 100 items even bootstrap intervals are too narrow.",
  },
  {
    title: "When Leaderboards Disagree: Rank Stability Across Metrics",
    topic: "Evaluation",
    authors: ["Sven Akerman", "Maya Goldberg"],
    abstract:
      "The same systems can rank differently under different metrics. We measure rank agreement across metrics for 22 leaderboards in vision and language.",
    tldr: "On 22 leaderboards, the top three systems keep their order under a second metric only 58% of the time.",
    method:
      "Rank correlation is computed between every pair of metrics a leaderboard reports.",
    result:
      "Disagreement is largest where the top systems are within one point of each other.",
  },
];
const radar = [
  {
    paper: 0,
    project: "Stereo video",
    level: "medium" as const,
    reason:
      "Joint depth and intrinsics from eight handheld frames, within 4% of calibrated baselines indoors.",
    relevance:
      "The project's capture set has no calibration data; this is the setting it reports on.",
    angles: [
      "Run it on the uncalibrated clips before buying a calibration target.",
      "Check the low-parallax failure against the tripod shots.",
    ],
    action: "Try the released code on ten clips from the capture set.",
  },
  {
    paper: 1,
    project: "Stereo video",
    level: "borrow" as const,
    reason:
      "A five-frame disparity-smoothness loss removes 61% of temporal jitter.",
    relevance:
      "Flicker is the main complaint in the project's viewer study, and the loss needs no new data.",
    angles: ["Add the window loss to the current training run."],
    action: "Read the loss definition and the ablation table.",
  },
  {
    paper: 6,
    project: "Evaluation methods",
    level: "borrow" as const,
    reason:
      "Answer stability on a second asking predicts correctness better than stated confidence.",
    relevance:
      "The planned evaluation asks each question once; this suggests a cheap second signal.",
    angles: ["Ask each evaluation question twice and report the flip rate."],
    action: "Note the protocol for the evaluation plan.",
  },
];
// The brief's picks: two per topic, none of them a radar paper.
const picked = [2, 3, 4, 5, 8, 9, 11, 12];

export async function seedDemo(db: D1Database) {
  const ingested = await ingestPapers(
    db,
    demoDay,
    papers.map((paper, index) => {
      const id = `2611.${String(95001 + index)}`;
      return {
        key: id,
        title: paper.title,
        abstract: paper.abstract,
        authors: paper.authors,
        source: "arxiv",
        venueKind: "preprint",
        categories: ["cs.CV"],
        identifiers: [{ scheme: "arxiv", value: id }],
        links: [
          { kind: "landing", url: `https://example.org/papers/${id}` },
          ...(paper.code
            ? [{ kind: "code", url: `https://example.org/code/${id}` }]
            : []),
        ],
        rankInSource: index + 1,
        topics: [paper.topic],
        shortlisted: true,
        hfUpvotes: paper.upvotes ?? null,
      };
    }),
  );
  if (ingested.invalid.length)
    throw new Error(JSON.stringify(ingested.invalid));
  const ids = ingested.papers.map(({ paperId }) => paperId);
  await ingestSummaryRecords(db, {
    summaries: papers.map((paper, index) => ({
      paperId: ids[index]!,
      lang: "en",
      content: {
        tldr: paper.tldr,
        motivation: paper.abstract.split(". ")[0] + ".",
        method: paper.method,
        result: paper.result,
        conclusion: "Invented for the demo: no real paper is described.",
      },
      client: "demo",
      model: "demo",
    })),
  });
  await ingestFeedDay(db, {
    day: demoDay,
    status: "final",
    counts: { total: papers.length, arxiv: papers.length },
  });
  const suggestions = [
    {
      kind: "new_idea",
      title: "Use answer stability as a second evaluation signal",
      bodyMd:
        "Two of today's papers measure something an evaluation usually ignores: whether the answer survives a second asking, and how wide the interval around a small test set really is. Ask each question twice and report the flip rate beside accuracy.",
      ideaIds: [],
      paperIds: [ids[6]!, ids[12]!],
      projectIds: [],
    },
    {
      kind: "new_idea",
      title: "Test the depth pipeline on transparent objects first",
      bodyMd:
        "The capture set has many glass surfaces, and today's audit shows where depth models place them. A small held-out set of such scenes would show early whether the pipeline inherits the problem.",
      ideaIds: [],
      paperIds: [ids[2]!],
      projectIds: [],
    },
  ];
  const entries = radar.map(({ paper, ...entry }) => ({
    ...entry,
    paperId: ids[paper]!,
    fullTextRead: false,
  }));
  await ingestDigest(db, {
    day: demoDay,
    lang: "en",
    final: true,
    picks: picked.map((index) => ids[index]!),
    radar: entries,
    suggestions,
    bodyMd: [
      "## Radar",
      ...radar.map(
        ({ paper, reason, action }) =>
          `### ${papers[paper]!.title}\n\n${reason} ${action}`,
      ),
      "## Picks per topic",
      picked
        .map(
          (index) => `- **${papers[index]!.topic}** · ${papers[index]!.title}`,
        )
        .join("\n"),
      "## Idea suggestions",
      ...suggestions.map(({ title, bodyMd }) => `### ${title}\n\n${bodyMd}`),
    ].join("\n\n"),
  });
}
