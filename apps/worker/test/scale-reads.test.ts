import { afterAll, beforeAll, expect, it } from "vitest";
import { databaseHarness } from "@litscout/db/test/harness";
import { hashVaultText } from "@litscout/db/vault-index";
import { app } from "../src/app";
import { countingDb } from "./helpers/counting-db";
import { workerEnv } from "./helpers/worker-env";

const day = new Date().toISOString().slice(0, 10);
const id = (i: number) => "pap_scale_" + String(i).padStart(4, "0");
const arxiv = (i: number) => "2611." + String(i).padStart(5, "0");
const noteHash = "c".repeat(64);
const ideas = Array.from({ length: 40 }, (_, i) =>
  i.toString(16).padStart(64, "a"),
);
const projects = Array.from({ length: 8 }, (_, i) =>
  i.toString(16).padStart(64, "b"),
);
const working = "d".repeat(64);
let d1: D1Database;
let counter: ReturnType<typeof countingDb>;
let close: () => Promise<void>;

beforeAll(async () => {
  const harness = await databaseHarness("d1");
  close = harness.close;
  d1 = harness.db.$client as unknown as D1Database;
  counter = countingDb(d1);
  const sequence = (n: number) => `WITH RECURSIVE seq(i) AS (
    VALUES(0) UNION ALL SELECT i+1 FROM seq WHERE i<${n - 1}
  )`;
  await d1.batch([
    d1
      .prepare("INSERT INTO feed_days(day,status) VALUES (?,'crawled')")
      .bind(day),
    d1
      .prepare(
        `${sequence(1000)} INSERT INTO papers(id,title,title_norm,abstract,authors,first_seen_on)
      SELECT printf('pap_scale_%04d',i),case WHEN i IN (0,90,899) THEN 'Rare-birefringence geometry' ELSE 'Ordinary geometry' END,
      'geometry','Depth from two views','[{"name":"Mira Chen"},{"name":"Ari Lee"}]',? FROM seq`,
      )
      .bind(day),
    d1.prepare(`${sequence(1000)} INSERT INTO paper_ids(paper_id,scheme,value)
      SELECT printf('pap_scale_%04d',i),'arxiv',printf('2611.%05d',i) FROM seq`),
    d1
      .prepare(
        `${sequence(1000)} INSERT INTO feed_items(day,paper_id,source,rank_in_source,topics)
      SELECT ?,printf('pap_scale_%04d',i),'arxiv',i,'["geometry"]' FROM seq`,
      )
      .bind(day),
    d1
      .prepare(
        "INSERT INTO summaries(paper_id,lang,content) SELECT id,'en','{\"tldr\":\"Test\"}' FROM papers WHERE id<>?",
      )
      .bind(id(899)),
    d1.prepare(`${sequence(5200)} INSERT INTO paper_index(paper_id,arxiv_id,day,title,title_norm)
      SELECT printf('compact-%04d',i),printf('2501.%05d',i),'2025-01-01','Compact result','compact result' FROM seq`),
    d1
      .prepare(
        `${sequence(2300)} INSERT INTO events(id,paper_id,kind,day,source)
      SELECT 'event-'||i,printf('pap_scale_%04d',i%1000),'open',?,'web' FROM seq`,
      )
      .bind(day),
    d1
      .prepare(
        "INSERT INTO events(id,paper_id,kind,day,source) VALUES ('rating',?,'rate_up',?,'mcp:local')",
      )
      .bind(id(0), day),
    d1.prepare(`${sequence(300)} INSERT INTO library_items(paper_id,added_via)
      SELECT printf('pap_scale_%04d',i),'manual' FROM seq`),
    d1.prepare(`${sequence(75)} INSERT INTO alphaxiv_items(alphaxiv_id,paper_id,title,synced_at)
      SELECT 'mirror-'||i,printf('pap_scale_%04d',i),'Mirror geometry','2026-01-01T00:00:00Z' FROM seq`),
    d1
      .prepare(
        `${sequence(500)} INSERT INTO vault_notes(id,path,kind,title,frontmatter,hash,body_hash,fingerprint,synced_at)
      SELECT printf('%064d',i),printf('Paper/%d.md',i),'paper_note','Paper note',json_object('arxiv',printf('2611.%05d',i)),
      ?1,?1,?1,?2 FROM seq`,
      )
      .bind(noteHash, day + "T00:00:00Z"),
    d1
      .prepare(
        `INSERT INTO vault_notes(id,path,kind,title,frontmatter,hash,body_hash,fingerprint,synced_at)
      SELECT value,value||'.md',?2,'Geometry','{}',?3,?3,?3,?4 FROM json_each(?1)`,
      )
      .bind(JSON.stringify(ideas), "idea", noteHash, day + "T00:00:00Z"),
    d1
      .prepare(
        `INSERT INTO vault_notes(id,path,kind,title,frontmatter,hash,body_hash,fingerprint,synced_at)
      SELECT value,value||'.md','project','Geometry','{}',?2,?2,?2,?3 FROM json_each(?1)`,
      )
      .bind(JSON.stringify(projects), noteHash, day + "T00:00:00Z"),
    d1
      .prepare(
        "INSERT INTO vault_notes(id,path,kind,title,frontmatter,hash,body_hash,fingerprint,synced_at) VALUES (?1,'Working.md','working_paper','Geometry','{}',?2,?2,?2,?3)",
      )
      .bind(working, noteHash, day + "T00:00:00Z"),
    d1
      .prepare(
        `INSERT INTO projects(id,slug,title,status,vault_note_id)
      SELECT value,value,'Geometry','active',value FROM json_each(?)`,
      )
      .bind(JSON.stringify(projects)),
    d1
      .prepare(
        `INSERT INTO idea_index(id,vault_note_id,title,project_id,paper_ids,updated_at)
      SELECT value,value,'Geometry',json_extract(?2,'$['||(key%8)||']'),json_array(printf('pap_scale_%04d',key)),?3 FROM json_each(?1)`,
      )
      .bind(
        JSON.stringify(ideas),
        JSON.stringify(projects),
        day + "T00:00:00Z",
      ),
    d1
      .prepare(
        `INSERT INTO working_paper_index(id,vault_note_id,title,project_id,paper_ids,idea_ids,updated_at)
      VALUES (?1,?1,'Geometry',?,?,?,?)`,
      )
      .bind(
        working,
        projects[0],
        JSON.stringify([id(0), id(1)]),
        JSON.stringify(ideas.slice(0, 5)),
        day + "T00:00:00Z",
      ),
    d1
      .prepare(
        `${sequence(30)} INSERT INTO suggestions(id,day,kind,title,body_md,paper_ids,created_by)
      SELECT 'sug_scale_'||i,?,'new_idea','Geometry','Follow up',json_array(printf('pap_scale_%04d',i)),'fixture' FROM seq`,
      )
      .bind(day),
    d1.prepare("UPDATE vault_sync SET note_count=549 WHERE id=1"),
  ]);
}, 60_000);
afterAll(async () => close?.());

async function bounded<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  counter.reset();
  const response = await app.request(
    "https://local/api/v1" + path,
    {
      method,
      ...(body === undefined
        ? {}
        : {
            body: JSON.stringify(body),
            headers: {
              "content-type": "application/json",
              origin: "https://local",
              "sec-fetch-site": "same-origin",
            },
          }),
    },
    {
      ...workerEnv().env,
      DB: counter.db,
      LOCAL_DEV: "true",
      PUBLIC_FEED: "true",
      PUBLIC_URL: "https://local",
    },
  );
  const text = await response.text();
  expect(response.status, path + " " + text.slice(0, 500)).toBe(200);
  expect(counter.stats().rowsRead, path).toBeLessThanOrEqual(1500);
  return (JSON.parse(text) as { data: T }).data;
}

it("continues private and public sparse searches and a mostly completed summary worklist", async () => {
  type Page = { items: { paperId: string }[]; nextCursor: string | null };
  for (const [url, expected] of [
    [`/feed/days/${day}?q=birefringence`, [id(0), id(90), id(899)]],
    [`/public/days/${day}?q=birefringence`, [id(0), id(90), id(899)]],
    [`/feed/days/${day}/summary-todo?lang=en`, [id(899)]],
  ] as const) {
    const found: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 11; page++) {
      const result: Page = await bounded(
        url + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
      );
      found.push(...result.items.map((item) => item.paperId));
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    expect(cursor).toBeNull();
    expect(found).toEqual(expected);
  }
});

it("bounds Library hydration and preserves matches after empty search windows", async () => {
  type Page = { items: { paperId: string }[]; nextCursor: string | null };
  expect((await bounded<Page>("/library")).items).toHaveLength(30);
  const names: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 12; page++) {
    const result: Page = await bounded(
      "/library?q=birefringence" +
        (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
    );
    names.push(...result.items.map((item) => item.paperId));
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  // Paper 0's mirror title takes precedence over the original title.
  expect(names).toEqual([id(90)]);
  expect(cursor).toBeNull();
});

it("bounds projects, suggestions, vault lookup and working paper hydration", async () => {
  type Projects = {
    items: { id: string; papers: { id: string }[] }[];
    next: string | null;
  };
  const first = await bounded<Projects>("/projects");
  expect(first.items).toHaveLength(5);
  expect(first.items[0]?.papers.map((paper) => paper.id)).toContain(id(0));
  expect(await bounded("/projects/" + projects[0])).toMatchObject({
    id: projects[0],
  });
  expect(
    (await bounded<Projects>("/projects?after=" + first.next)).items,
  ).toHaveLength(3);
  expect(await bounded("/suggestions")).toMatchObject({
    items: expect.arrayContaining([
      expect.objectContaining({
        references: expect.objectContaining({
          papers: expect.arrayContaining([
            expect.objectContaining({ id: id(0) }),
          ]),
        }),
      }),
    ]),
  });
  expect(await bounded("/working-papers/" + working)).toMatchObject({
    reading: expect.arrayContaining([
      expect.objectContaining({ id: id(0), vaultPath: "Paper/0.md" }),
    ]),
    recent: expect.arrayContaining([expect.objectContaining({ id: id(5) })]),
  });
  // The week's related reading is two statements, not one per day.
  expect(counter.stats().calls).toBeLessThanOrEqual(6);
  const params = new URLSearchParams({
    note: JSON.stringify({ id: noteHash, arxiv: arxiv(1) }),
  });
  expect(await bounded("/vault/matches?" + params)).toEqual([
    { id: noteHash, paperId: id(1) },
  ]);
  expect(await bounded("/vault/paper-note/" + id(1))).toMatchObject({
    path: "Paper/1.md",
  });
});

it("reads only rating events and seeks retention references by exact identifier", async () => {
  const operations = await bounded<{
    ratings: { id: string; source: string }[];
  }>(`/operations?from=${day}&to=${day}`);
  expect(operations.ratings).toMatchObject([
    { id: "rating", source: "mcp:local (unverified)" },
  ]);
  const prune = await bounded<{ rows: { reasons: string[] }[] }>(
    "/ingest/prune",
  );
  expect(prune.rows).toHaveLength(10);
  expect(prune.rows[0]?.reasons).toContain("research");
});

it("publishes a paper-note delta without rebuilding unrelated research rows", async () => {
  const path = "Paper/new.md";
  const id = await hashVaultText(path);
  const snapshot = "e".repeat(64);
  expect(
    await bounded("/vault/index", "PUT", {
      snapshot,
      previous: null,
      part: 0,
      notes: [
        {
          id,
          path,
          kind: "paper_note",
          title: "New paper",
          frontmatter: { arxiv: arxiv(900) },
          hash: noteHash,
          bodyHash: noteHash,
        },
      ],
    }),
  ).toEqual({ accepted: true });
  expect(
    await bounded("/vault/index", "PUT", {
      snapshot,
      previous: null,
      parts: 1,
      count: 550,
      changes: 1,
    }),
  ).toEqual({ published: true });
  const edge = await d1
    .prepare("SELECT project_id FROM idea_index WHERE id=?")
    .bind(ideas[0])
    .first("project_id");
  expect(edge).toBe(projects[0]);
});

it("updates an existing digest with overlapping retention references", async () => {
  const digest = { day, bodyMd: "First report", picks: [id(0), id(1)] };
  await bounded("/digests/" + day, "PUT", digest);
  await bounded("/digests/" + day, "PUT", {
    ...digest,
    bodyMd: "Second report",
    picks: [id(0), id(2)],
  });
  const { results } = await d1
    .prepare(
      "SELECT paper_id FROM retention_refs WHERE source='digests' ORDER BY paper_id",
    )
    .all();
  expect(results).toEqual([{ paper_id: id(0) }, { paper_id: id(2) }]);
});

it("claims note edits without a second capture lookup", async () => {
  await d1
    .prepare(
      `INSERT INTO vault_requests(id,kind,target_note_id,payload,origin,created_at)
    VALUES ('req_scale_link','link_paper',?,'{}','web',?)`,
    )
    .bind(ideas[0], new Date().toISOString())
    .run();
  const claim = "6e292b2b-95d5-492d-9601-af0eca1fddd0";
  expect(
    await bounded("/vault/requests/req_scale_link/claim", "POST", { claim }),
  ).toEqual({ claimed: true });
  // Lease reservation and settlement plus the claim and the budget path.
  expect(counter.stats().calls).toBeLessThanOrEqual(4);
});

it("bounds the default full-feed page used by the daily digest", async () => {
  const page = await bounded<{ items: unknown[]; nextCursor: string | null }>(
    `/feed/days/${day}/full`,
  );
  expect(page.items).toHaveLength(30);
  expect(page.nextCursor).toBeTruthy();
});

// Seeds thousands of rows: about 7 s alone, so allow for a busy machine.
it(
  "bounds a mixed Library search when thousands of mirror rows precede older matches",
  { timeout: 60_000 },
  async () => {
    await d1.batch([
      d1.prepare(`WITH RECURSIVE seq(i) AS (VALUES(300) UNION ALL SELECT i+1 FROM seq WHERE i<998)
      INSERT INTO alphaxiv_items(alphaxiv_id,paper_id,title,saved_at,synced_at)
      SELECT 'bulk-'||i,printf('pap_scale_%04d',i),'Mirror ordinary geometry','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z' FROM seq`),
      d1.prepare(`WITH RECURSIVE seq(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM seq WHERE i<1800)
      INSERT INTO alphaxiv_items(alphaxiv_id,paper_type,title,saved_at,synced_at)
      SELECT printf('bulk-private-%04d',i),'private','Private ordinary geometry','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z' FROM seq`),
      d1.prepare(`INSERT INTO alphaxiv_items(alphaxiv_id,paper_id,title,saved_at,synced_at)
      VALUES ('bulk-old','pap_scale_0999','Mirror birefringence','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'),
        ('bulk-new','pap_scale_0999','Mirror birefringence','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z')`),
    ]);
    try {
      type Page = { items: { paperId: string }[]; nextCursor: string | null };
      const found: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 90; page++) {
        const result: Page = await bounded(
          "/library?q=birefringence&limit=1" +
            (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
        );
        found.push(...result.items.map((item) => item.paperId));
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      expect(cursor).toBeNull();
      expect(found).toEqual([id(90), id(999)]);
    } finally {
      await d1
        .prepare("DELETE FROM alphaxiv_items WHERE alphaxiv_id LIKE 'bulk-%'")
        .run();
    }
  },
);
