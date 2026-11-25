import {
  shiftMonth,
  trendsSourcePath,
} from "@litscout/pipeline/trends-contracts";
import worker from "../src/index";
import { writeReservation } from "@litscout/pipeline/write-reservation";
import { writeEvidence } from "@litscout/db/test/evidence";
import { afterAll, beforeAll, expect, it } from "vitest";
import { databaseHarness } from "@litscout/db/test/harness";
import { hashVaultText } from "@litscout/db/vault-index";
import {
  indexBatchSize,
  type VaultNote,
} from "@litscout/pipeline/vault-contracts";
import { app } from "../src/app";
import { countingDb } from "./helpers/counting-db";
import { workerEnv } from "./helpers/worker-env";
import {
  backupSections,
  backupPaperBatchSize,
  backupPaperChildPageSize,
} from "@litscout/pipeline/backup-contracts";
const day = "2026-11-17",
  content = {
    tldr: "T",
    motivation: "M",
    method: "M",
    result: "R",
    conclusion: "C",
  };
let close: () => Promise<void>,
  counter: ReturnType<typeof countingDb>,
  env: ReturnType<typeof workerEnv>["env"];
const papers = Array.from({ length: 40 }, (_, i) => ({
  key: `2611.${String(i).padStart(5, "0")}`,
  title: `Paper ${i}`,
  abstract: "Synthetic abstract",
  source: "arxiv",
  identifiers: Array.from({ length: 20 }, (_, j) => ({
    scheme: "url",
    value: `https://local/${i}/${j}`,
  })),
  links: Array.from({ length: 20 }, (_, j) => ({
    kind: "landing",
    url: `https://local/${i}/${j}`,
  })),
}));
const call = (path: string, method = "GET", body?: unknown, bindings = env) =>
  app.request(
    `/api/v1${path}`,
    {
      method,
      headers: { authorization: "Bearer lsk_" + "R".repeat(52) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    bindings,
  );
async function createFixture() {
  const h = await databaseHarness("d1");
  const counter = countingDb(h.db.$client as unknown as D1Database);
  const env = {
    ...workerEnv().env,
    DB: counter.db,
    LOCAL_DEV: "true",
    PUBLIC_FEED: "true",
  };
  const hash = Buffer.from(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode("lsk_" + "R".repeat(52)),
    ),
  ).toString("hex");
  await counter.db
    .prepare(
      "INSERT INTO api_tokens(id,name,hash,scopes) VALUES ('tok_test','test',?,?)",
    )
    .bind(hash, JSON.stringify(["read", "ingest", "write", "vault"]))
    .run();
  return { close: h.close, counter, env };
}
// Seeds a local D1 through the Worker; shared CI runners need more than the default 30 s.
const SLOW_LOCAL_D1_MS = 180_000;
beforeAll(async () => {
  ({ close, counter, env } = await createFixture());
  const r = await call("/ingest/papers", "POST", { day, papers });
  expect(r.status).toBe(200);
  const result = (await r.json()) as { meta: { rowsWritten: number } };
  expect(result.meta.rowsWritten).toBeLessThanOrEqual(
    writeReservation("/ingest/papers", { papers }),
  );
  // A full 100-day archive exercises the largest dayTotals parameter set.
  await counter.db
    .prepare(
      "INSERT OR IGNORE INTO feed_days(day) SELECT value FROM json_each(?)",
    )
    .bind(
      JSON.stringify(
        Array.from({ length: 100 }, (_, i) =>
          new Date(Date.parse(day) - i * 86400000).toISOString().slice(0, 10),
        ),
      ),
    )
    .run();
}, SLOW_LOCAL_D1_MS);
afterAll(async () => close());

it(
  "F3 bounds vault status reads and index uploads with 5,000 compact papers",
  async () => {
    const fixture = await createFixture();
    const { counter } = fixture;
    try {
      expect(
        (await call("/ingest/papers", "POST", { day, papers }, fixture.env))
          .status,
      ).toBe(200);
      await counter.db
        .prepare(
          `
      WITH RECURSIVE numbers(n) AS (
        VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n<5000
      )
      INSERT INTO paper_index(paper_id,day,title,title_norm)
      SELECT 'compact-'||n,'2026-11-17','Compact paper '||n,
        CASE WHEN n>50 THEN 'compact paper '||n END FROM numbers
    `,
        )
        .run();
      const notes: VaultNote[] = await Promise.all(
        Array.from({ length: 50 }, async (_, i) => {
          const path = `Notes/Reference ${i + 1}.md`;
          const id = await hashVaultText(path);
          return {
            id,
            path,
            title: `Compact paper ${i + 1}`,
            hash: id,
            bodyHash: id,
            kind: "paper_note",
            frontmatter: {},
          };
        }),
      );
      const snapshot = await hashVaultText("compact-paper budget fixture");
      const upload = { snapshot, previous: null };
      const parts = Math.ceil(notes.length / indexBatchSize);
      const measure = async (path: string, method = "GET", body?: unknown) => {
        await counter.db
          .prepare("UPDATE api_tokens SET last_used_at=NULL")
          .run();
        counter.reset();
        const response = await call(path, method, body, fixture.env);
        expect(response.status, await response.clone().text()).toBe(200);
        return { result: await response.json(), ...counter.stats() };
      };
      const head = await measure("/vault/index?titleKeys=1");
      expect(head.result).toMatchObject({ data: { titleKeysPending: true } });
      // An older CLI parses this head strictly, so the count needs its own flag.
      expect((head.result as { data: object }).data).not.toHaveProperty(
        "titleKeysPendingCount",
      );
      const counted = await measure("/vault/index?titleKeys=1&titleKeyCount=1");
      expect(counted.result).toMatchObject({
        data: {
          titleKeysPending: true,
          titleKeysPendingCount: expect.any(Number),
        },
      });
      // Same statement, so no extra D1 call.
      expect(counted.calls).toBe(head.calls);
      const backfills = [];
      for (const titleKeysPending of [true, false]) {
        const backfill = await measure("/vault/index", "PUT", {
          backfillTitleKeys: true,
        });
        expect(backfill.result).toMatchObject({ data: { titleKeysPending } });
        backfills.push(backfill);
      }
      const batches = [];
      for (let part = 0; part < parts; part++) {
        const batch = await measure("/vault/index", "PUT", {
          ...upload,
          part,
          notes: notes.slice(
            part * indexBatchSize,
            (part + 1) * indexBatchSize,
          ),
        });
        expect(batch.result).toMatchObject({ data: { accepted: true } });
        batches.push(batch);
      }
      const publish = await measure("/vault/index", "PUT", {
        ...upload,
        parts,
        count: notes.length,
        changes: notes.length,
      });
      expect(publish.result).toMatchObject({ data: { published: true } });
      const read = await measure("/vault/paper-note/compact-1");
      expect(read.result).toMatchObject({
        data: { path: notes[0]!.path, matchedBy: "title", pending: false },
      });
      const refresh = await measure("/vault/index", "PUT", {
        snapshot,
        previous: snapshot,
        parts: 1,
        count: notes.length,
        changes: 0,
      });
      expect(refresh.result).toMatchObject({
        data: { published: true },
        meta: { rowsWritten: 0 },
      });
      const preview = new URLSearchParams(
        notes
          .slice(0, 8)
          .map(({ id, title }) => ["note", JSON.stringify({ id, title })]),
      );
      const matches = await measure("/vault/matches?" + preview);
      expect(matches.result).toMatchObject({
        data: notes.slice(0, 8).map(({ id }, i) => ({
          id,
          paperId: `compact-${i + 1}`,
          matchedBy: "title",
        })),
      });
      await writeEvidence("m3d-vault-query-counts.json", {
        backfills,
        batches,
        publish,
        read,
        refresh,
        matches,
      });
      for (const stats of [
        ...backfills,
        ...batches,
        publish,
        read,
        refresh,
        matches,
      ]) {
        expect(stats.calls).toBeLessThanOrEqual(40);
        expect(stats.rowsRead).toBeGreaterThan(0);
        expect(stats.maxParams).toBeLessThanOrEqual(100);
        expect(stats.maxSqlBytes).toBeLessThanOrEqual(100 * 1024);
      }
      expect(
        batches.reduce((calls, batch) => calls + batch.calls, publish.calls),
      ).toBeLessThanOrEqual(40);
      expect(read.rowsRead).toBeLessThanOrEqual(20);
      expect(matches.rowsRead).toBeLessThanOrEqual(100);
      expect(publish.rowsRead).toBeLessThanOrEqual(1200);
      expect(refresh.rowsRead).toBeLessThanOrEqual(500);
      for (const stats of backfills)
        expect(stats.rowsRead).toBeLessThanOrEqual(200);
    } finally {
      await fixture.close();
    }
  },
  SLOW_LOCAL_D1_MS,
);
it(
  "F3 counts every API write at its cap and every public/private read, including due token accounting",
  async () => {
    const stored = await counter.db
      .prepare("SELECT id FROM papers")
      .all<{ id: string }>();
    const paperId = stored.results[0]!.id;
    const idea = "a".repeat(64);
    const workingPaper = "b".repeat(64);
    const idFor = (index: number) => index.toString(16).padStart(64, "0");
    const ideaIds = [
      idea,
      ...Array.from({ length: 99 }, (_, index) => idFor(index + 1)),
    ];
    const prepare = (sql: string, ...bindings: unknown[]) =>
      counter.db.prepare(sql).bind(...bindings);
    const paperIds = JSON.stringify(stored.results.map(({ id }) => id));
    const ideas = JSON.stringify(ideaIds);
    // Seed the same 100 ideas without hundreds of synchronous Miniflare proxy
    // calls, which can keep Node from processing an idle socket's close event.
    await counter.db.batch([
      prepare(
        `INSERT INTO vault_notes(id,path,kind,title,frontmatter,hash,body_hash,fingerprint,synced_at)
         SELECT value,value||'.md','idea','Depth','{}',value,value,value,? FROM json_each(?)`,
        day,
        ideas,
      ),
      prepare(
        `INSERT INTO idea_index(id,vault_note_id,title,status,paper_ids,updated_at)
         SELECT value,value,'Depth direction','seed',?,? FROM json_each(?)`,
        paperIds,
        day,
        ideas,
      ),
      prepare(
        "INSERT INTO vault_notes(id,path,kind,title,frontmatter,hash,body_hash,fingerprint,synced_at) VALUES (?,'Depth.md','working_paper','Depth','{}',?,?,?,?)",
        workingPaper,
        workingPaper,
        workingPaper,
        workingPaper,
        day,
      ),
      prepare(
        "INSERT INTO working_paper_index(id,vault_note_id,title,idea_ids,paper_ids,updated_at) VALUES (?,?,'Depth',?,?,?)",
        workingPaper,
        workingPaper,
        ideas,
        paperIds,
        day,
      ),
      prepare(
        "INSERT INTO vault_requests(id,kind,payload,origin,created_at) VALUES ('req_f3','capture',?,'fixture',?)",
        JSON.stringify({ title: "Draft" }),
        day,
      ),
      prepare(
        "INSERT INTO captures(id,title,body_md,created_at) VALUES ('req_f3','Draft','Original',?)",
        day,
      ),
      ...["queued", "rejected"].map((state) =>
        prepare(
          "INSERT INTO vault_requests(id,kind,target_note_id,payload,state,origin,created_at) VALUES (?,'set_status',?,?,?,'fixture',?)",
          "req_f3_" + state,
          idea,
          JSON.stringify({ title: "Move idea", status: "parked" }),
          state,
          day,
        ),
      ),
      ...["accept", "dismiss"].map((action) =>
        prepare(
          "INSERT INTO suggestions(id,day,kind,title,body_md,idea_ids,paper_ids,project_ids,created_by) VALUES (?,?,'combination','Depth proposal','Rationale',?,?,'[]','fixture')",
          "sg_f3_" + action,
          day,
          JSON.stringify(ideaIds.slice(0, 5)),
          JSON.stringify(stored.results.slice(0, 5).map(({ id }) => id)),
        ),
      ),
    ]);
    const next = async (path: string) => {
      const body = (await (await call(path)).json()) as {
        data: { nextCursor: string };
      };
      return `${path}&cursor=${encodeURIComponent(body.data.nextCursor)}`;
    };
    const continuation = await next(`/feed/days/${day}?limit=1`);
    const todoContinuation = await next(
      `/feed/days/${day}/summary-todo?lang=zh&limit=1`,
    );
    const publicContinuation = await next(`/public/days/${day}?limit=1`);
    const routes: [string, string, unknown?][] = [
      [
        "/ingest/daily-run",
        "POST",
        {
          id: "43d91359-fbdc-4047-a843-30e90031a4df",
          startedAt: new Date().toISOString(),
          targetDay: day,
        },
      ],
      ["/ingest/papers", "POST", { day, papers }],
      [
        "/ingest/summaries",
        "POST",
        {
          summaries: Array.from({ length: 50 }, (_, i) => ({
            paperId: stored.results[i % 40]!.id,
            content,
            client: "antigravity",
          })),
        },
      ],
      [
        "/ingest/radar",
        "POST",
        {
          radar: Array.from({ length: 40 }, () => ({
            day,
            paperId,
            level: "borrow",
            reason: "R",
          })),
        },
      ],
      [
        "/ingest/legacy",
        "POST",
        {
          runs: Array.from({ length: 10 }, (_, i) => ({
            id: `run_${i}`,
            day,
            kind: "crawl",
            status: "done",
            startedAt: day + "T00:00:00Z",
          })),
          cursors: Array.from({ length: 10 }, () => ({
            name: "venue-feed",
            value: JSON.stringify({ since: day }),
          })),
          missed: Array.from({ length: 10 }, (_, i) => ({
            id: `miss_${i}`,
            paperId,
            foundOn: day,
            where: "test",
          })),
          ratings: Array.from({ length: 10 }, (_, i) => ({
            id: `evt_${i}`,
            paperId,
            day,
            kind: "rate_up",
            source: "test",
            at: day + "T00:00:00Z",
          })),
        },
      ],
      [
        "/ingest/feed-day",
        "POST",
        { day, status: "crawled", counts: { arxiv: 40 } },
      ],
      [
        `/digests/${day}`,
        "PUT",
        {
          day,
          bodyMd: "Daily",
          suggestions: Array.from({ length: 10 }, (_, index) => ({
            kind: "new_idea",
            title: "Depth proposal " + index,
            bodyMd: "Rationale",
            ideaIds: [],
            projectIds: [],
            paperIds: [paperId],
          })),
          picks: Array(1000).fill(paperId),
          radar: Array.from({ length: 6000 }, () => ({
            paperId,
            level: "borrow",
            reason: "R",
          })),
        },
      ],
      [
        "/vault/requests/req_f3",
        "PATCH",
        { title: "Revised draft", body: "x".repeat(2000) },
      ],
      ["/suggestions/sg_f3_accept/accept", "POST", {}],
      ["/suggestions/sg_f3_dismiss/dismiss", "POST", {}],
      [
        "/vault/requests/req_f3/claim",
        "POST",
        { claim: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa" },
      ],
      ["/vault/requests/req_f3_queued", "DELETE"],
      ["/vault/requests/req_f3_rejected?clear=rejected", "DELETE"],
      ...[
        "/health",
        "/operations/health",
        "/backup",
        ...backupSections.map((section) => "/backup/" + section),
        "/backup/papers?" +
          new URLSearchParams({
            include: JSON.stringify(
              stored.results.slice(0, backupPaperBatchSize).map(({ id }) => ({
                id,
              })),
            ),
          }),
        "/vault/info",
        "/vault/captures",
        "/vault/paper-note/" + paperId,
        "/ideas",
        "/ideas/" + idea,
        "/working-papers",
        "/working-papers/" + workingPaper,
        "/suggestions?day=" + day + "&status=new",
        "/suggestions?after=sg_f3_accept",
        "/instance",
        "/feed/days?limit=100",
        `/feed/days/${day}?topic=T&source=arxiv&shortlisted=true`,
        continuation,
        todoContinuation,
        publicContinuation,
        `/feed/days/${day}?limit=100&unread=true`,
        `/feed/days/${day}/full?limit=50`,
        `/feed/days/${day}/full?ids=${stored.results.map((p) => p.id).join(",")}`,
        `/feed/history?from=2026-09-18&to=${day}&limit=200`,
        `/feed/days/${day}/summary-todo?lang=zh&limit=100`,
        `/papers/${paperId}?day=${day}&source=arxiv`,
        `/digests/${day}`,
        `/feed/days/${day}/digest`,
        `/operations?from=2026-01-01&to=${day}`,
        "/sync/cursors?name=venue-feed",
        "/budget",
        "/public/days?limit=100",
        `/public/days/${day}?limit=100&topic=T&source=arxiv&shortlisted=false`,
        `/public/papers/${paperId}?day=${day}&source=arxiv`,
        `/public/days/${day}`,
      ].map((path) => [path, "GET"] as [string, string]),
    ];
    const evidence: Record<string, ReturnType<typeof counter.stats>> = {};
    for (const [path, method, body] of [
      ...routes,
      ...routes
        .filter((r) => r[1] === "GET")
        .map(([path]) => [path, "HEAD"] as [string, string]),
      [`/days/${day}/reopen?dryRun=1`, "POST"],
      [`/days/${day}/reopen`, "POST"],
    ]) {
      env = { ...env, PUBLIC_FEED: path === "/instance" ? "false" : "true" };
      await counter.db.prepare("UPDATE api_tokens SET last_used_at=NULL").run();
      counter.reset();
      const response = await call(path, method, body);
      expect(
        response.status,
        `${method} ${path}: ${await response.clone().text()}`,
      ).toBe(200);
      evidence[`${method} ${path}`] = counter.stats();
      expect(counter.stats().calls, path).toBeLessThanOrEqual(40);
      if (path.startsWith("/backup/papers")) {
        // Two indexed child windows, their lookahead rows, and metadata.
        const bound =
          24 + backupPaperBatchSize * (4 + 2 * (backupPaperChildPageSize + 1));
        expect(counter.stats().rowsRead, path).toBeLessThanOrEqual(bound);
      } else if (path === "/backup" && method === "GET") {
        // The cooled-down start counts the visible data and scans the long
        // digest, idea and working-paper reference arrays in this fixture.
        expect(counter.stats().rowsRead, path).toBeLessThan(30_000);
      } else if (
        path === "/operations/health" ||
        path === "/ingest/daily-run" ||
        path.startsWith("/backup")
      ) {
        expect(counter.stats().rowsRead, path).toBeLessThan(800);
      }
      expect(counter.stats().maxParams, path).toBeLessThanOrEqual(100);
      expect(counter.stats().maxSqlBytes, path).toBeLessThanOrEqual(100 * 1024);
    }
    await writeEvidence("m1c-query-counts.json", evidence);
  },
  SLOW_LOCAL_D1_MS,
);

it(
  "F3 bounds rows read for a Library page with 2,500 mirror papers",
  async () => {
    const count = 2500;
    const folder = "10000000-0000-4000-8000-000000000001";
    await counter.db.batch([
      counter.db
        .prepare(
          `WITH RECURSIVE numbers(n) AS (
      VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n<?
    ) INSERT INTO papers(id,title,title_norm) SELECT 'pap_f3_'||n,'Mirror paper '||n,'mirror'||n FROM numbers`,
        )
        .bind(count),
      counter.db
        .prepare(
          `INSERT INTO alphaxiv_items(alphaxiv_id,paper_id,title,folders,synced_at)
      SELECT '2611.'||printf('%05d',substr(id,8)),id,title,?,? FROM papers WHERE id GLOB 'pap_f3_*'`,
        )
        .bind(
          JSON.stringify([{ id: folder, path: "F3", type: "custom" }]),
          day + "T00:00:00Z",
        ),
      counter.db.prepare(`INSERT INTO paper_links(id,paper_id,kind,url)
      SELECT p.id||':'||k.kind,p.id,k.kind,'https://local/'||p.id||'/'||k.kind
      FROM papers p CROSS JOIN (
        SELECT 'landing' AS kind UNION ALL SELECT 'pdf_arxiv' UNION ALL SELECT 'doi'
      ) k WHERE p.id GLOB 'pap_f3_*'`),
      counter.db.prepare(`INSERT INTO paper_ids(paper_id,scheme,value)
        SELECT id,'arxiv','2611.'||printf('%05d',substr(id,8))
        FROM papers WHERE id GLOB 'pap_f3_*'`),
    ]);
    const evidence = {};
    for (const query of [
      "?limit=30",
      "?limit=30&origin=alphaxiv&folder=" + folder,
    ]) {
      await counter.db.prepare("UPDATE api_tokens SET last_used_at=NULL").run();
      counter.reset();
      const response = await call("/library" + query);
      expect(response.status, await response.clone().text()).toBe(200);
      const { data } = (await response.json()) as {
        data: { items: unknown[]; nextCursor: string | null };
      };
      expect(data.items).toHaveLength(30);
      expect(data.nextCursor).toBeTruthy();
      const stats = counter.stats();
      Object.assign(evidence, { [query]: stats });
      expect(stats.rowsRead, query).toBeLessThanOrEqual(1500);
      expect(stats.calls, query).toBeLessThanOrEqual(40);
      expect(stats.maxParams, query).toBeLessThanOrEqual(100);
    }
    await writeEvidence("m2b-library-rows-read.json", evidence);

    const lookups: Record<string, ReturnType<typeof counter.stats>> = {};
    for (const id of ["2611.02500", "arxiv:2611.02500"]) {
      await counter.db.prepare("UPDATE api_tokens SET last_used_at=NULL").run();
      counter.reset();
      const response = await call("/papers/" + id);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        data: { paperId: "pap_f3_2500", links: expect.any(Array) },
      });
      const stats = counter.stats();
      expect(stats.rowsRead).toBeGreaterThan(0);
      expect(stats.rowsRead).toBeLessThan(80);
      expect(stats.calls).toBeLessThanOrEqual(40);
      lookups[id] = stats;
    }
    counter.reset();
    const due = await call("/ingest/links?limit=20");
    expect(due.status).toBe(200);
    const result = (await due.json()) as { data: { items: unknown[] } };
    expect(result.data.items).toHaveLength(20);
    const queue = counter.stats();
    expect(queue.rowsRead).toBeGreaterThan(0);
    expect(queue.rowsRead).toBeLessThan(100);
    expect(queue.calls).toBeLessThanOrEqual(40);
    await writeEvidence("m3i-identifier-link-reads.json", { lookups, queue });
  },
  SLOW_LOCAL_D1_MS,
);

it(
  "F3 bounds the keyword day page and its continuation on a 2,500-paper day",
  async () => {
    const listing = "2026-07-17";
    await counter.db.batch([
      counter.db
        .prepare("INSERT INTO feed_days(day,status) VALUES (?,'crawled')")
        .bind(listing),
      counter.db.prepare(`WITH RECURSIVE numbers(n) AS (
        VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n<2500
      ) INSERT INTO papers(id,title,title_norm,abstract)
        SELECT 'pap_keywords_'||n,'Keyword '||n,'keyword'||n,'Abstract' FROM numbers`),
      counter.db
        .prepare(
          `INSERT INTO feed_items(day,paper_id,source,shortlisted,rank_in_source)
        SELECT ?,id,'arxiv',substr(id,14)+0>2480,substr(id,14)+0
        FROM papers WHERE id GLOB 'pap_keywords_*'`,
        )
        .bind(listing),
    ]);
    const previousEnv = env;
    env = { ...env, INSTANCE_CONFIG: JSON.stringify({ keywordOnly: true }) };
    try {
      const pages = [];
      for (const route of ["/feed/days", "/public/days"]) {
        let cursor: string | null = null;
        for (const start of [2481, 11]) {
          counter.reset();
          const response = await call(
            `${route}/${listing}?limit=30${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`,
          );
          expect(response.status).toBe(200);
          const { data } = (await response.json()) as {
            data: { items: { title: string }[]; nextCursor: string | null };
          };
          expect(data.items).toHaveLength(30);
          expect(data.items[0]?.title).toBe("Keyword " + start);
          const rows = counter.stats().rowsRead;
          expect(rows, route).toBeGreaterThan(0);
          expect(rows, route).toBeLessThan(250);
          expect(counter.stats().calls).toBeLessThanOrEqual(40);
          pages.push({ route, start, ...counter.stats() });
          cursor = data.nextCursor;
          expect(cursor).toBeTruthy();
        }
      }
      await writeEvidence("m3i-keyword-reads.json", pages);
    } finally {
      env = previousEnv;
    }
  },
  SLOW_LOCAL_D1_MS,
);

it(
  "F3 bounds private Trends and MCP get_trends with twelve months for ten topics",
  async () => {
    const fixture = await createFixture();
    const { counter, env } = fixture;
    const now = new Date();
    const month = now.toISOString().slice(0, 7);
    const names = Array.from({ length: 10 }, (_, n) => "Topic " + n);
    const bindings = {
      ...env,
      INSTANCE_CONFIG: JSON.stringify({
        timezone: "UTC",
        topics: names,
      }),
    };
    const id = (index: number) => "pap_trends_" + index;
    const ids = Array.from({ length: 24 }, (_, n) => id(n));
    const terms = Array.from({ length: 15 }, (_, n) => ({
      term: "term" + n,
      count: n + 2,
      score: n + 3,
    }));
    try {
      await counter.db
        .prepare(
          `
        INSERT INTO papers(id,title,title_norm)
        SELECT value,'Trend paper '||value,value FROM json_each(?)
      `,
        )
        .bind(JSON.stringify(ids))
        .run();
      const measure = async (operation: () => Response | Promise<Response>) => {
        await counter.db
          .prepare("UPDATE api_tokens SET last_used_at=NULL")
          .run();
        counter.reset();
        const response = await operation();
        expect(response.status, await response.clone().text()).toBe(200);
        return { response, stats: counter.stats() };
      };
      const uploads = [];
      const bodyFor = (month: string) => ({
        rows: names.map((topic) => ({
          topic,
          month,
          volume: 1040,
          shortlisted: 300,
          recurring: terms,
          rising: terms,
          radar: { high: 2, medium: 1, borrow: 3 },
          picks: ids,
          activity: ids.map((paperId) => ({
            paperId,
            saved: true,
            rating: "up",
          })),
        })),
      });
      for (let index = 0; index < 12; index++) {
        const body = bodyFor(shiftMonth(month, -index));
        const uploaded = await measure(() =>
          call("/ingest/trends", "PUT", body, bindings),
        );
        expect(await uploaded.response.json()).toMatchObject({
          meta: { rowsWritten: 10 },
        });
        expect(writeReservation("/ingest/trends", body)).toBe(10);
        expect(uploaded.stats.calls).toBeLessThanOrEqual(10);
        uploads.push(uploaded.stats);
      }
      const replay = await measure(() =>
        call("/ingest/trends", "PUT", bodyFor(month), bindings),
      );
      expect(await replay.response.json()).toMatchObject({
        meta: { rowsWritten: 0 },
      });
      const expected = {
        topic: "Topic 9",
        month,
        currentMonth: month,
        history: expect.any(Array),
        detail: {
          volume: 1040,
          pickCount: 24,
          saveCount: 24,
          nextPickOffset: 20,
        },
      };
      const requestQuery = new URLSearchParams({ topic: "Topic 9", month });
      const rest = await measure(() =>
        call("/trends?" + requestQuery, "GET", undefined, bindings),
      );
      const result = (
        (await rest.response.json()) as { data: { history: unknown[] } }
      ).data;
      expect(result).toMatchObject(expected);
      expect(result.history).toHaveLength(12);
      const next = await measure(() =>
        call(
          "/trends?" + requestQuery + "&pickOffset=20&activityOffset=20",
          "GET",
          undefined,
          bindings,
        ),
      );
      expect(await next.response.json()).toMatchObject({
        data: {
          detail: {
            picks: ids.slice(20).map((paperId) => ({ paperId })),
            activity: ids.slice(20).map((paperId) => ({ paperId })),
            nextPickOffset: null,
            nextActivityOffset: null,
          },
        },
      });
      const mcp = async () => {
        const { ctx } = workerEnv();
        const pending: Promise<unknown>[] = [];
        ctx.waitUntil = (promise) => {
          pending.push(promise);
        };
        const response = await worker.fetch(
          new Request("https://worker.example/mcp", {
            method: "POST",
            headers: {
              authorization: "Bearer lsk_" + "R".repeat(52),
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: {
                name: "get_trends",
                arguments: { topic: "Topic 9", month },
              },
            }),
          }) as Parameters<typeof worker.fetch>[0],
          bindings,
          ctx,
        );
        await Promise.all(pending);
        return response;
      };
      const tool = await measure(mcp);
      const payload = await tool.response.text();
      const rpc = JSON.parse(/^data: (.+)$/m.exec(payload)?.[1] ?? payload);
      expect(JSON.parse(rpc.result.content[0].text)).toMatchObject({
        result: expected,
      });
      for (const stats of [rest.stats, next.stats, tool.stats]) {
        expect(stats.calls).toBeLessThanOrEqual(10);
        expect(stats.rowsRead).toBeGreaterThanOrEqual(12);
        expect(stats.rowsRead).toBeLessThanOrEqual(240);
      }
      await writeEvidence("m4a-trends-query-counts.json", {
        rest: rest.stats,
        next: next.stats,
        mcp: tool.stats,
        firstUpload: uploads[0],
        subsequentUpload: uploads[1],
        unchangedUpload: replay.stats,
      });
    } finally {
      await fixture.close();
    }
  },
  SLOW_LOCAL_D1_MS,
);

it(
  "F3 bounds a legacy quote, import and historical reads at the paper cap",
  async () => {
    const fixture = await createFixture();
    const { counter, env } = fixture;
    try {
      const historical = "2026-10-30";
      const legacy = papers.map((p, i) => ({
        ...p,
        key: "2610." + String(i).padStart(5, "0"),
        identifiers: [
          { scheme: "arxiv", value: "2610." + String(i).padStart(5, "0") },
        ],
        links: [
          {
            kind: "pdf_arxiv",
            url: "https://arxiv.org/pdf/2610." + String(i).padStart(5, "0"),
          },
        ],
        topics: ["Depth"],
      }));
      const check = async (path: string, method = "GET", body?: unknown) => {
        counter.reset();
        const response = await call(path, method, body, env);
        expect(response.status).toBe(200);
        const result = (await response.json()) as {
          data: unknown;
          meta?: { rowsWritten?: number };
        };
        const metrics = counter.stats();
        expect(metrics.calls).toBeLessThanOrEqual(40);
        expect(metrics.maxParams).toBeLessThanOrEqual(100);
        expect(metrics.rowsRead).toBeLessThan(1500);
        return result;
      };
      const { data: initial } = await check("/ingest/papers", "POST", {
        day: historical,
        papers: legacy,
        legacy: "plan",
      });
      const maxRows = (initial as { rows: number }).rows;
      const rejected = await call(
        "/ingest/papers",
        "POST",
        {
          day: historical,
          papers: legacy,
          legacy: "import",
          maxRows: maxRows - 1,
        },
        env,
      );
      expect(rejected.status).toBe(409);
      const { data: applied, meta } = await check("/ingest/papers", "POST", {
        day: historical,
        papers: legacy,
        legacy: "import",
        maxRows,
      });
      expect(meta?.rowsWritten).toBeLessThanOrEqual(maxRows);
      const { data: repeat } = await check("/ingest/papers", "POST", {
        day: historical,
        papers: legacy,
        legacy: "plan",
      });
      expect((repeat as { rows: number }).rows).toBeLessThanOrEqual(3);
      const ids = (applied as { papers: { paperId: string }[] }).papers.map(
        (p) => p.paperId,
      );
      const { data: references } = await check(
        trendsSourcePath +
          "/references?ids=" +
          encodeURIComponent(JSON.stringify(ids.slice(0, 20))),
      );
      expect(references).toEqual(
        expect.arrayContaining(
          ids
            .slice(0, 20)
            .map((paperId) =>
              expect.objectContaining({ paperId, topics: ["Depth"] }),
            ),
        ),
      );
      await check("/feed/days/" + historical);
      await check("/feed/history?from=" + historical + "&to=" + historical);
      const { data: paper } = await check(
        "/papers/" + ids[0] + "?day=" + historical + "&source=arxiv",
      );
      expect(paper).toMatchObject({
        links: expect.arrayContaining([
          {
            kind: "pdf_arxiv",
            url: "https://arxiv.org/pdf/2610.00000",
            licence: null,
            oaStatus: "unknown",
          },
        ]),
      });
    } finally {
      await fixture.close();
    }
  },
  SLOW_LOCAL_D1_MS,
);
