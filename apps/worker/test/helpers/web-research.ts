import { drizzle } from "drizzle-orm/d1";
import {
  hashVaultText,
  publishVaultIndex,
  stageVaultIndex,
} from "@litscout/db/vault-index";
import {
  createVaultRequest,
  recordVaultSync,
  resolveVaultRequest,
} from "@litscout/db/vault-requests";
import { ingestDigest, ingestFeedDay } from "@litscout/db/ingest";
import { shiftDay } from "@litscout/pipeline/daily";
import type { VaultNote } from "@litscout/pipeline/vault-contracts";
import type { ingestPapers } from "@litscout/db/ingest-papers";

const fixtureDay = "2026-11-17";
const at = fixtureDay + "T04:00:00.000Z";

async function note(path: string, title: string) {
  const id = await hashVaultText(path);
  return { id, path, title, hash: id, bodyHash: id };
}

export async function seedResearch(
  client: D1Database,
  papers: Awaited<ReturnType<typeof ingestPapers>>["papers"],
  review = false,
) {
  const db = drizzle(client);
  const [libraryPaper, primary, recent] = papers.map(({ paperId }) => paperId);
  const idea = await note("PRIVATE_Vault/Idea.md", "PRIVATE_Depth idea");
  const draft = await note("PRIVATE_Vault/Draft.md", "PRIVATE_Depth draft");
  const project = await note(
    "PRIVATE_Vault/Project.md",
    "PRIVATE_Vision project",
  );
  const paper = await note(
    "PRIVATE_Vault/Black Patch.md",
    "Beyond the Black Patch — A Composable, Gaze-Contingent Framework for Simulating Central Vision Loss in XR",
  );
  const notes: VaultNote[] = [
    {
      ...project,
      kind: "project",
      body: [
        "# PRIVATE_Vision plan",
        "- Read the depth papers first.",
        "| Step | Owner |\n| --- | --- |\n| Baseline | Lab |",
        "- [x] Pick datasets",
        "See [[Ideas/Depth idea|the depth idea]] and ~5% gains.",
      ].join("\n\n"),
      frontmatter: { status: "active" },
    },
    {
      ...idea,
      kind: "idea",
      body: "PRIVATE_Compare **stereo** and monocular depth.",
      frontmatter: {
        status: "seed",
        description: "Compare vision methods.",
        project: project.title,
        papers: [papers[0]!.key],
      },
    },
    {
      ...draft,
      kind: "working_paper",
      frontmatter: {
        status: "draft",
        ideas: [idea.title],
        project: project.title,
      },
    },
    { ...paper, kind: "paper_note", frontmatter: {} },
  ];
  const snapshot = await hashVaultText("fixture research index");
  const start = { snapshot, previous: null };
  await stageVaultIndex(db, { ...start, part: 0, notes });
  await publishVaultIndex(
    db,
    { ...start, parts: 1, count: notes.length, changes: notes.length },
    at,
  );

  await client
    .prepare(
      "INSERT INTO library_items(user_id,paper_id,status,added_via) VALUES ('u_owner',?,'reading','web')",
    )
    .bind(libraryPaper!)
    .run();

  // The Worker computes "this week" using its own clock. Keep the reading
  // fixture in that window without moving the recorded day used by the UI.
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  if (today < fixtureDay || today >= shiftDay(fixtureDay, 6)) {
    const day = shiftDay(today, -1);
    await ingestFeedDay(client, { day, status: "crawled", counts: {} });
    await client
      .prepare(
        `INSERT INTO feed_items(day,paper_id,source,topics,shortlisted)
        SELECT ?,paper_id,source,topics,shortlisted FROM feed_items
        WHERE day=? AND paper_id=?`,
      )
      .bind(day, fixtureDay, recent!)
      .run();
  }

  const digest = await client
    .prepare(
      "SELECT body_md,picks,radar FROM digests WHERE day=? AND lang='en' AND kind='daily'",
    )
    .bind(fixtureDay)
    .first<{ body_md: string; picks: string; radar: string }>();
  await ingestDigest(
    client,
    {
      day: fixtureDay,
      lang: "en",
      bodyMd: digest!.body_md,
      picks: JSON.parse(digest!.picks),
      radar: review
        ? [{ ...JSON.parse(digest!.radar)[0], project: project.title }]
        : JSON.parse(digest!.radar),
      final: true,
      // The projects share the fixture server. Give each its own suggestion pair.
      suggestions: ["desktop", "phone"].flatMap((project) =>
        ["Try a new baseline", "Compare viewing tasks"].map((title) => ({
          kind: "new_idea",
          title: "PRIVATE_" + title + " (" + project + ")",
          bodyMd: "A fixture suggestion for the private morning brief.",
          ideaIds: [],
          paperIds: [primary!],
          projectIds: [],
        })),
      ),
    },
    true,
  );

  for (const title of ["PRIVATE_Queued capture", "PRIVATE_Queued follow-up"])
    await createVaultRequest(db, { kind: "capture", title }, at, "web");
  const rejected = await createVaultRequest(
    db,
    {
      kind: "link_paper",
      targetNoteId: idea.id,
      paperId: primary!,
    },
    at,
    "web",
  );
  await resolveVaultRequest(
    db,
    rejected.id,
    {
      state: "rejected",
      reason: "The idea note changed since it was indexed.",
    },
    at,
  );
  await recordVaultSync(
    db,
    {
      writeEnabled: false,
      counts: {
        project: 1,
        idea: 1,
        working_paper: 1,
        paper_note: 1,
        brief: 0,
      },
      ...(review && {
        conventions: {
          ideaTag: "type/idea",
          workingPaperTag: "type/working-paper",
          ideaNotes: 1,
          workingPaperNotes: 1,
          paperNotesWithoutIdentifiers: { count: 1, paths: [paper.path] },
          possibleNonProjects: 0,
          excludedFolders: 1,
          excludedNotes: 0,
          privateNotes: 0,
        },
      }),
      writes: [],
      handEdited: [],
      issues: [],
    },
    at,
  );
}
