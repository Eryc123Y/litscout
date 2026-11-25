import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { databaseHarness } from "./harness";
import { ingestPapers, preparePaperIngest } from "../src/ingest-papers";
import { readDayPage, readHistory, readPaper } from "../src/bounded-read";
import { searchPapers } from "../src/papers";
import { searchTrendPapers } from "../src/trends-source";
import { prunePage, retentionPage, retentionPageSql } from "../src/retention";

const day = "2026-09-01";
const cutoff = "2026-10-05";
const later = "2026-10-07";
const ids = [
  "library",
  "mirror",
  "event",
  "pick",
  "radar",
  "idea",
  "note",
  "suggestion",
  "working",
  "recent",
  "old",
];
const input = ids.map((id, i) => ({
  key: id,
  title: "Retention specimen " + id,
  abstract: "Full material",
  source: "arxiv",
  topics: ["vision"],
  identifiers: [{ scheme: "arxiv", value: "2609." + String(10000 + i) }],
  links: [
    {
      kind: "pdf_arxiv",
      url: "https://arxiv.org/pdf/2609." + String(10000 + i),
    },
  ],
}));
let harness: Awaited<ReturnType<typeof databaseHarness>>;
let db: D1Database;
let paper: Record<string, string>;
let insert: (sql: string, ...params: unknown[]) => Promise<unknown>;
beforeAll(async () => {
  harness = await databaseHarness("d1");
  db = harness.db.$client as D1Database;
  insert = (sql, ...params) =>
    db
      .prepare(sql)
      .bind(...params)
      .run();
});
afterAll(async () => harness?.close());
beforeEach(async () => {
  await db.batch(
    [
      "digests",
      "suggestions",
      "idea_index",
      "working_paper_index",
      "vault_notes",
      "notes",
      "idea_links",
      "ideas",
      "paper_index",
      "feed_days",
      "papers",
    ].map((t) => db.prepare("DELETE FROM " + t)),
  );
  const result = await ingestPapers(
    db,
    day,
    input,
    await preparePaperIngest(db, day, input, true),
  );
  paper = Object.fromEntries(
    result.papers.map((row) => [row.key, row.paperId]),
  );
});

it("keeps each protected reference and uses the latest feed day", async () => {
  await insert(
    "INSERT INTO library_items(paper_id,added_via) VALUES (?,'manual')",
    paper.library,
  );
  await insert(
    "INSERT INTO alphaxiv_items(paper_id,alphaxiv_id,paper_type,synced_at,title) VALUES (?,'x','public','now','X')",
    paper.mirror,
  );
  await insert(
    "INSERT INTO events(id,paper_id,kind,day,source) VALUES ('e',?,'rate_up',?,'web')",
    paper.event,
    day,
  );
  await insert(
    "INSERT INTO digests(day,body_md,picks,radar) VALUES (?,'x',?,?)",
    day,
    JSON.stringify([paper.pick]),
    JSON.stringify([{ paperId: paper.radar }]),
  );
  await insert(
    "INSERT INTO ideas(id,title,body_md,origin) VALUES ('i','Idea','Body','web')",
  );
  await insert(
    "INSERT INTO idea_links(idea_id,target_type,target_id,relation) VALUES ('i','paper',?,'cites')",
    paper.idea,
  );
  await insert(
    "INSERT INTO notes(id,target_type,target_id,body_md,origin) VALUES ('n','paper',?,'note','web')",
    paper.note,
  );
  await insert(
    "INSERT INTO suggestions(id,day,kind,title,body_md,paper_ids,created_by) VALUES ('s',?,'idea','title','body',?,'owner')",
    day,
    JSON.stringify([paper.suggestion]),
  );
  await insert(
    "INSERT INTO vault_notes(id,path,kind,title,frontmatter,hash,body_hash,fingerprint,synced_at) VALUES ('w','w.md','working_paper','W','{}','hash','body','fp','now')",
  );
  await insert(
    "INSERT INTO working_paper_index(id,vault_note_id,title,paper_ids,updated_at) VALUES ('w','w','W',?,'now')",
    JSON.stringify([paper.working]),
  );
  await ingestPapers(db, later, [input[9]!]);
  const { rows: page } = await retentionPage(db, cutoff, null, 40);
  expect(
    Object.fromEntries(page.map((row) => [row.id, row.reasons])),
  ).toMatchObject({
    [paper.library!]: ["library"],
    [paper.mirror!]: ["library"],
    [paper.event!]: ["reading"],
    [paper.pick!]: ["digest"],
    [paper.radar!]: ["digest"],
    [paper.idea!]: ["research"],
    [paper.note!]: ["research"],
    [paper.suggestion!]: ["research"],
    [paper.working!]: ["research"],
    [paper.recent!]: ["recent"],
    [paper.old!]: [],
  });
  const explained = await db
    .prepare("EXPLAIN QUERY PLAN " + retentionPageSql)
    .bind(cutoff, "", "", 40, "~")
    .all<{ detail: string }>();
  expect(explained.results.map((row) => row.detail).join("\n")).toMatch(
    /SEARCH p USING INDEX papers_retention_age/,
  );
  expect(explained.results.map((row) => row.detail).join("\n")).not.toMatch(
    /SCAN (feed_items|events|digests|suggestions|retention_refs)\b/,
  );
});

it("compacts full records with no existing index, keeps history and restores the same ID", async () => {
  const target = paper.old!;
  await insert(
    "INSERT INTO summaries(paper_id,content) VALUES (?,?)",
    target,
    JSON.stringify({ tldr: "Vanishing summary" }),
  );
  await insert(
    "UPDATE papers SET derived_arxiv_links='[{}]' WHERE id=?",
    target,
  );
  const row = (await retentionPage(db, cutoff, null, 40)).rows.find(
    (r) => r.id === target,
  )!;
  expect((await prunePage(db, cutoff, [row])).pruned).toBe(1);
  expect((await prunePage(db, cutoff, [row])).pruned).toBe(0);
  expect(
    await db.prepare("SELECT id FROM papers WHERE id=?").bind(target).first(),
  ).toBeNull();
  expect(
    await db
      .prepare("SELECT has_canonical FROM paper_index WHERE paper_id=?")
      .bind(target)
      .first(),
  ).toEqual({ has_canonical: 0 });
  expect(await readPaper(db, target)).toMatchObject({
    paperId: target,
    compact: true,
    abstract: null,
    summaries: [],
    links: [],
  });
  expect(
    (await readDayPage(db, day, { q: "specimen old" })).items,
  ).toMatchObject([{ paperId: target }]);
  expect((await readHistory(db, { from: day, to: day })).items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        paperId: target,
        identifiers: input[10]!.identifiers,
        compact: true,
      }),
    ]),
  );
  expect(
    (
      await searchTrendPapers(db, {
        month: "2026-09",
        topic: "vision",
        term: "specimen",
      })
    ).items,
  ).toEqual(
    expect.arrayContaining([expect.objectContaining({ paperId: target })]),
  );
  expect(
    (await searchPapers(harness.db, "specimen old")).map((p) => p.id),
  ).toContain(target);
  expect(
    (await searchPapers(harness.db, "Vanishing summary")).map((p) => p.id),
  ).not.toContain(target);
  const restored = await ingestPapers(
    db,
    later,
    [input[10]!],
    await preparePaperIngest(db, later, [input[10]!], true),
  );
  expect(restored.papers[0]?.paperId).toBe(target);
  expect(
    await db
      .prepare("SELECT first_seen_on FROM papers WHERE id=?")
      .bind(target)
      .first(),
  ).toEqual({ first_seen_on: day });
  expect(await readPaper(db, target)).toMatchObject({
    paperId: target,
    abstract: "Full material",
  });
});

it("rolls back an injected failure between compact write and full deletion, and rechecks new references", async () => {
  const id = paper.old!;
  const row = (await retentionPage(db, cutoff, null, 40)).rows.find(
    (r) => r.id === id,
  )!;
  await db
    .prepare(
      "CREATE TRIGGER test_stop BEFORE DELETE ON papers BEGIN SELECT RAISE(ABORT,'interrupted'); END",
    )
    .run();
  try {
    await expect(prunePage(db, cutoff, [row])).rejects.toThrow(/interrupted/);
    expect(
      await db
        .prepare("SELECT paper_id FROM paper_index WHERE paper_id=?")
        .bind(id)
        .first(),
    ).toBeNull();
    expect(await readPaper(db, id)).toMatchObject({
      abstract: "Full material",
    });
  } finally {
    await db.prepare("DROP TRIGGER test_stop").run();
  }
  await insert(
    "INSERT INTO events(id,paper_id,kind,day,source) VALUES ('late',?,'open',?,'web')",
    id,
    day,
  );
  expect((await prunePage(db, cutoff, [row])).pruned).toBe(0);
  expect(await readPaper(db, id)).toMatchObject({ abstract: "Full material" });
});

it("merges archived occurrences into a canonical paper without dropping day history", async () => {
  const old = paper.old!;
  const kept = paper.library!;
  const row = (await retentionPage(db, cutoff, null, 40)).rows.find(
    (r) => r.id === old,
  )!;
  await prunePage(db, cutoff, [row]);
  const bridged = {
    ...input[0]!,
    identifiers: [...input[0]!.identifiers, ...input[10]!.identifiers],
  };
  const result = await ingestPapers(db, later, [bridged]);
  expect(result.papers[0]!.paperId).toBe(kept);
  expect(await readPaper(db, old)).toBeNull();
  expect(await readPaper(db, "2609.10010")).toMatchObject({ paperId: kept });
  expect(
    (await readHistory(db, { from: day, to: day })).items.filter(
      (p) => p.paperId === kept,
    ),
  ).toHaveLength(1);
});

it("keeps legacy title-only vault matches and case-variant DOI matches", async () => {
  const doi = "10.1234/archive-case";
  await insert(
    "INSERT INTO paper_ids(paper_id,scheme,value) VALUES (?,'doi',?)",
    paper.note,
    doi,
  );
  await insert(
    `INSERT INTO vault_notes(id,path,kind,title,frontmatter,hash,body_hash,fingerprint,synced_at)
     VALUES ('doi','Doi.md','paper_note','A different title',?,'hash','body','fingerprint','now')`,
    JSON.stringify({ doi: doi.toUpperCase() }),
  );
  const before = await retentionPage(db, cutoff, null, 40);
  expect(before.rows.find((row) => row.id === paper.note)?.reasons).toEqual([
    "research",
  ]);
  await insert("UPDATE papers SET vault_title_norm=NULL WHERE id=?", paper.old);
  await insert(
    `INSERT INTO vault_notes(id,path,kind,title,frontmatter,hash,body_hash,fingerprint,synced_at)
     VALUES ('legacy','Legacy.md','paper_note',?,'{}','hash','body','fingerprint','now')`,
    input[10]!.title,
  );
  const { rows } = await retentionPage(db, cutoff, null, 40);
  const protectedRows = rows.filter(
    (r) => r.id === paper.old || r.id === paper.note,
  );
  expect(protectedRows).toHaveLength(2);
  expect(protectedRows.map((r) => r.reasons)).toEqual([
    ["research"],
    ["research"],
  ]);
  expect((await prunePage(db, cutoff, protectedRows)).pruned).toBe(0);
});

it("retargets vault notes, captures and link requests when a kept paper absorbs a duplicate", async () => {
  const keep = paper.library!;
  const drop = paper.old!;
  await insert("UPDATE papers SET created_at='2026-08-01' WHERE id=?", keep);
  await insert(
    "INSERT INTO library_items(paper_id,added_via) VALUES (?,'manual')",
    keep,
  );
  await insert(
    `INSERT INTO vault_notes(id,path,kind,title,frontmatter,hash,body_hash,fingerprint,synced_at,title_paper_id,title_norm)
     VALUES ('vault-merge','Merge.md','paper_note','Old title','{}','hash','body','fingerprint','now',?,'old title')`,
    drop,
  );
  await insert(
    `INSERT INTO vault_requests(id,kind,target_note_id,payload,origin,created_at)
     VALUES ('link','link_paper','vault-merge',?,'web','now'),('capture','capture',NULL,'{}','web','now')`,
    JSON.stringify({ paperId: drop }),
  );
  for (const [id, paperId] of [
    ["make-keep", keep],
    ["make-drop", drop],
  ]) {
    await insert(
      `INSERT INTO vault_requests(id,kind,payload,origin,created_at)
       VALUES (?,'make_paper_note',?,'web','now')`,
      id,
      JSON.stringify({ paperId }),
    );
  }
  await insert(
    `INSERT INTO captures(id,title,source_paper_id,created_at) VALUES ('capture','Capture',?,'now')`,
    drop,
  );
  try {
    const bridged = {
      ...input[0]!,
      identifiers: [...input[0]!.identifiers, ...input[10]!.identifiers],
    };
    expect((await ingestPapers(db, later, [bridged])).papers[0]?.paperId).toBe(
      keep,
    );
    expect(
      await db
        .prepare(
          "SELECT title_paper_id FROM vault_notes WHERE id='vault-merge'",
        )
        .first("title_paper_id"),
    ).toBe(keep);
    expect(
      await db
        .prepare("SELECT source_paper_id FROM captures WHERE id='capture'")
        .first("source_paper_id"),
    ).toBe(keep);
    expect(
      (
        await db
          .prepare(
            "SELECT id,state,json_extract(payload,'$.paperId') AS paper FROM vault_requests WHERE kind<>'capture' ORDER BY id",
          )
          .all()
      ).results,
    ).toEqual([
      { id: "link", state: "queued", paper: keep },
      { id: "make-drop", state: "cancelled", paper: keep },
      { id: "make-keep", state: "queued", paper: keep },
    ]);
  } finally {
    await insert(
      "DELETE FROM vault_requests WHERE id IN ('link','capture','make-keep','make-drop')",
    );
  }
});

it("keeps an occurrence exactly on the cutoff and rechecks a late library save", async () => {
  await ingestPapers(db, cutoff, [input[9]!]);
  const candidates = (await retentionPage(db, cutoff, null, 40)).rows;
  const recent = candidates.find((r) => r.id === paper.recent)!;
  const old = candidates.find((r) => r.id === paper.old)!;
  expect(recent.reasons).toContain("recent");
  await insert(
    "INSERT INTO library_items(paper_id,added_via) VALUES (?,'manual')",
    old.id,
  );
  expect((await prunePage(db, cutoff, [recent, old])).pruned).toBe(0);
});

it("continues Trends past a full window of soft-deleted occurrences", async () => {
  const firstDay = "2026-08-01";
  await db.batch([
    db.prepare("INSERT INTO feed_days(day) VALUES (?)").bind(firstDay),
    db.prepare(`WITH RECURSIVE seq(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM seq WHERE i<50)
      INSERT INTO papers(id,title,title_norm)
      SELECT printf('pap_trend_%03d',i),'Needle title','needle title' FROM seq`),
    db
      .prepare(
        `INSERT INTO feed_items(day,paper_id,source,topics)
      SELECT ?,id,'arxiv','["vision"]' FROM papers WHERE id LIKE 'pap_trend_%'`,
      )
      .bind(firstDay),
    db.prepare(
      "UPDATE papers SET deleted_at='2026-08-02' WHERE id LIKE 'pap_trend_%' AND id<>'pap_trend_050'",
    ),
  ]);
  const query = { month: "2026-08", topic: "vision", term: "needle" };
  const firstPage = await searchTrendPapers(db, query);
  expect(firstPage.items).toHaveLength(0);
  expect(firstPage.nextCursor).toBeTruthy();
  expect(
    (await searchTrendPapers(db, { ...query, cursor: firstPage.nextCursor! }))
      .items,
  ).toEqual([{ paperId: "pap_trend_050", title: "Needle title" }]);
});

it("keeps topics and feed signals when an archived occurrence overlaps its survivor", async () => {
  const old = paper.old!;
  const kept = paper.library!;
  await insert(
    "UPDATE feed_items SET topics='[\"archived-topic\"]',rank_in_source=2,hf_upvotes=9,shortlisted=1 WHERE paper_id=?",
    old,
  );
  await insert(
    "UPDATE feed_items SET topics='[\"surviving-topic\"]',rank_in_source=8,hf_upvotes=3 WHERE paper_id=?",
    kept,
  );
  const row = (await retentionPage(db, cutoff, null, 40)).rows.find(
    (r) => r.id === old,
  )!;
  expect((await prunePage(db, cutoff, [row])).pruned).toBe(1);
  const bridged = {
    ...input[0]!,
    identifiers: [...input[0]!.identifiers, ...input[10]!.identifiers],
  };
  expect((await ingestPapers(db, later, [bridged])).papers[0]?.paperId).toBe(
    kept,
  );
  expect(
    await db
      .prepare(
        "SELECT topics,rank_in_source,hf_upvotes,shortlisted FROM feed_items WHERE paper_id=? AND day=?",
      )
      .bind(kept, day)
      .first(),
  ).toEqual({
    topics: '["archived-topic","surviving-topic"]',
    rank_in_source: 2,
    hf_upvotes: 9,
    shortlisted: 1,
  });
});
