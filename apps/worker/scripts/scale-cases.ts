import { shiftDay } from "@litscout/pipeline/daily";
import { fixture, textGenerator } from "@litscout/db/scripts/size-model";
import { arxivId, hash, paperId, vaultNote, vaultSize } from "./scale-seed";

export type ScaleCase = {
  name: string;
  path: string;
  method?: string;
  body?: unknown;
  prepare?: (db: D1Database) => Promise<unknown>;
};

export function scaleCases(day: string): ScaleCase[] {
  const month = day.slice(0, 7);
  const old = shiftDay(day, -40);
  const next = shiftDay(day, 1);
  const full = paperId(0);
  const compact = paperId(45_000);
  const project = vaultNote(0, day).id;
  const idea = vaultNote(40, day).id;
  const working = vaultNote(240, day).id;
  const ids = Array.from({ length: 8 }, (_, i) => paperId(i * 11));
  const refs = new URLSearchParams({ ids: JSON.stringify(ids) });
  const get = (name: string, path: string) => ({
    name,
    path: "/api/v1" + path,
  });
  const write = (
    name: string,
    path: string,
    body: unknown,
    method = "POST",
    prepare?: ScaleCase["prepare"],
  ): ScaleCase => ({ ...get(name, path), method, body, prepare });
  const tool = (
    name: string,
    args: object,
    prepare?: ScaleCase["prepare"],
  ): ScaleCase => ({
    name: "MCP " + name,
    path: "/mcp",
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    },
    prepare,
  });
  const feed = "/feed/days/" + day;
  const publicDay = "/public/days/" + day;
  const source = "/ingest/trends/source";
  const suggestions = "sug_scale_" + day;
  const now = next + "T00:00:00.000Z";
  const report = {
    id: "6e292b2b-95d5-492d-9601-af0eca1fddd0",
    startedAt: now,
    targetDay: day,
  };
  const text = textGenerator();
  const ingest = (n: number) => ({
    day: next,
    papers: Array.from({ length: n }, (_, i) => {
      const sample = fixture(i, text);
      const key = arxivId(90_000 + i, next);
      return {
        key,
        title: "Rehearsal new " + sample.title,
        abstract: sample.abstract,
        source: "arxiv",
        identifiers: [{ scheme: "arxiv", value: key }],
        topics: ["stereo", "vision"],
        authors: ["Lea Chen"],
        categories: ["cs.CV"],
        publishedOn: next,
      };
    }),
  });
  const cleanupIngest = (db: D1Database) =>
    db.batch([
      db
        .prepare(
          "DELETE FROM papers WHERE id IN (SELECT paper_id FROM feed_items WHERE day=?)",
        )
        .bind(next),
      db.prepare("DELETE FROM paper_index WHERE day=?").bind(next),
      db.prepare("DELETE FROM daily_write_usage"),
    ]);
  const summary = {
    tldr: "Stereo depth improves on this sequence.",
    motivation: "Estimate depth.",
    method: "Use two views.",
    result: "Lower error.",
    conclusion: "Compare other setups.",
  };
  const previous = hash("scale-initial"),
    snapshot = hash("scale-changed");
  const notes = Array.from({ length: 12 }, (_, i) => vaultNote(260 + i, day));
  const part = { snapshot, previous, part: 0, notes };
  const resetVault = (db: D1Database) =>
    db.batch([
      db.prepare("UPDATE vault_sync SET snapshot=? WHERE id=1").bind(previous),
      db.prepare("DELETE FROM daily_write_usage"),
    ]);
  const prepareCommit = async (db: D1Database) => {
    await resetVault(db);
    await db.batch([
      db
        .prepare(
          "UPDATE vault_notes SET fingerprint='before-edit' WHERE id IN (SELECT value FROM json_each(?))",
        )
        .bind(JSON.stringify(notes.map(({ id }) => id))),
      db
        .prepare("INSERT OR REPLACE INTO vault_index_parts VALUES(0,?,?,'[]')")
        .bind(
          snapshot,
          JSON.stringify(
            notes.map((note) => ({
              ...note,
              fingerprint: hash(note.title),
              titleNorm: "",
            })),
          ),
        ),
    ]);
  };
  return [
    get("Settings / instance", "/instance"),
    get("Today / feed", feed + "?limit=30"),
    get("Today / counts", feed + "/counts"),
    get("Morning brief", feed + "/digest"),
    get(
      "Brief paper references",
      feed +
        "/references?" +
        new URLSearchParams({
          ids: JSON.stringify(
            ids.map((paperId) => ({ paperId, day, source: "arxiv" })),
          ),
        }),
    ),
    get("Days list", "/feed/days?view=page"),
    get(
      "Days list, older page",
      "/feed/days?view=page&before=" + shiftDay(day, -30),
    ),
    get("Days list, CLI", "/feed/days?limit=100"),
    get("Newest day", feed),
    get("Day 40 days old", "/feed/days/" + old),
    get("Compact archive day", "/feed/days/" + shiftDay(day, -45)),
    get("Full paper", "/papers/" + full),
    get("Compact paper", "/papers/" + compact),
    get("Compact paper details", "/papers/" + compact + "/details"),
    get("Reading state", "/state?paperId=" + full),
    get("Quick notes", "/notes?target=" + full),
    get("Day search, common", feed + "?q=stereo"),
    get("Day search, rare", feed + "?q=birefringence"),
    get("Day search, absent", feed + "?q=quokka"),
    get("Day filter, topic", feed + "?topic=stereo"),
    get("Trends", "/trends?topic=stereo&month=" + month),
    get(
      "Trends search, common",
      "/trends/search?topic=stereo&term=stereo&month=" + month,
    ),
    get(
      "Trends search, rare",
      "/trends/search?topic=stereo&term=birefringence&month=" + month,
    ),
    ...["papers", "digests", "radar", "events"].map((kind) =>
      get(
        "Trends source " + kind,
        source + "?kind=" + kind + "&month=" + month,
      ),
    ),
    get("Trends source references", source + "/references?" + refs),
    get("Trends source window", source + "/window"),
    get("Library", "/library"),
    get("Library search, common", "/library?q=stereo"),
    get("Library search, rare", "/library?q=birefringence"),
    get("Projects", "/projects"),
    get("Project detail", "/projects/" + project),
    get("Ideas", "/ideas"),
    get("Idea detail", "/ideas/" + idea),
    get("Suggestions", "/suggestions"),
    get("Working papers", "/working-papers"),
    get("Working paper detail", "/working-papers/" + working),
    get("Vault info", "/vault/info"),
    get("Vault status", "/vault/status"),
    get("Vault captures", "/vault/captures"),
    get("Vault paper note", "/vault/paper-note/" + paperId(0)),
    get("Vault sync preview / requests", "/vault/requests?state=queued"),
    get(
      "Vault sync preview / matches",
      "/vault/matches?" +
        new URLSearchParams(
          notes
            .slice(0, 8)
            .map(({ id, title, frontmatter }) => [
              "note",
              JSON.stringify({ id, title, ...frontmatter }),
            ]),
        ),
    ),
    get(
      "Vault sync preview / papers",
      "/vault/papers?" + new URLSearchParams(ids.map((id) => ["id", id])),
    ),
    get("Vault sync preview / digest", "/vault/digests/" + day),
    get("Vault index head", "/vault/index?titleKeys=1"),
    get("Vault index IDs", "/vault/index/ids"),
    get("Vault budget", "/vault/budget"),
    get("Health", "/operations/health"),
    get("Private health", "/health"),
    { name: "Public health", path: "/health" },
    { name: "Public page shell", path: "/public/today" },
    get("Public days", "/public/days?view=page"),
    get("Public day", publicDay),
    get("Public day counts", publicDay + "/counts"),
    get("Public paper", "/public/papers/" + full),
    get("Public day search, rare", publicDay + "?q=birefringence"),
    get("Daily budget", "/budget"),
    get(
      "Daily history, full window",
      "/feed/history?from=" + old + "&to=" + day,
    ),
    get(
      "Daily history",
      "/feed/history?from=" + shiftDay(day, -60) + "&to=" + day,
    ),
    get(
      "Daily operations",
      "/operations?from=" + shiftDay(day, -60) + "&to=" + day,
    ),
    get("Daily summary worklist, en", feed + "/summary-todo?lang=en"),
    get("Daily summary worklist, zh", feed + "/summary-todo?lang=zh"),
    get("Daily full feed", feed + "/full"),
    get("Daily digest", "/digests/" + day),
    get("Daily cursor", "/sync/cursors?name=arxiv-listing"),
    get("Daily link candidates", "/ingest/links"),
    get("Prune dry run", "/ingest/prune"),
    {
      name: "Cron housekeeping",
      path: "/__scale/cron?at=" + Date.parse(now),
      prepare: (db) =>
        db
          .prepare(
            "INSERT OR REPLACE INTO daily_runs(id,run_day,started_at,target_day) VALUES('scale-expired','2025-01-01','2025-01-01T00:00:00.000Z','2025-01-01')",
          )
          .run(),
    },
    tool("get_trends", { topic: "stereo", month }),
    tool("search_library", { q: "stereo" }),
    tool("get_paper", { ids: full }),
    tool("research_context", {}),
    tool("list_ideas", {}),
    tool("get_idea", { id: idea }),
    tool("list_suggestions", {}),
    tool("list_working_papers", {}),
    tool("get_working_paper", { id: working }),
    tool("lookup_paper", { ids: "doi:10.1234/test" }),
    tool("search", { query: "shared" }),
    tool("paper_links", { id: "CorpusId:1", direction: "citations" }),
    tool("get_author", { name_or_id: "Alex Example" }),
    tool("coauthorship", { authors: ["Alex Example", "Sam Example"] }),
    tool("reviews", { query: "MCP" }),
    tool("venue", { query: "CVPR" }),
    tool("save_paper", { query: "arxiv:" + arxivId(0, day), dry_run: true }),
    tool("add_note", { target: full, bodyMd: "Scale rehearsal note" }, (db) =>
      db.prepare("DELETE FROM notes WHERE target_id=?").bind(full).run(),
    ),
    tool("mark_paper", { paperId: full, action: "star" }),
    tool("capture_idea", { title: "Scale rehearsal capture", paperId: full }),
    tool("request_link", { targetNoteId: idea, paperId: full }, (db) =>
      db
        .prepare(
          "DELETE FROM vault_requests WHERE kind='link_paper' AND target_note_id=?",
        )
        .bind(idea)
        .run(),
    ),
    tool("resolve_suggestion", { id: suggestions, action: "dismiss" }, (db) =>
      db
        .prepare("UPDATE suggestions SET status='new' WHERE id=?")
        .bind(suggestions)
        .run(),
    ),
    write(
      "Daily ingest, 10",
      "/ingest/papers",
      ingest(10),
      "POST",
      cleanupIngest,
    ),
    write(
      "Daily quote, 20",
      "/ingest/papers",
      {
        ...ingest(20),
        legacy: "plan",
      },
      "POST",
      cleanupIngest,
    ),
    write(
      "Daily ingest, 20",
      "/ingest/papers",
      ingest(20),
      "POST",
      cleanupIngest,
    ),
    write(
      "Daily ingest, 5",
      "/ingest/papers",
      ingest(5),
      "POST",
      cleanupIngest,
    ),
    write(
      "Daily summary ingest, 20",
      "/ingest/summaries",
      {
        day,
        summaries: Array.from({ length: 20 }, (_, i) => ({
          paperId: paperId(i * 10 + 9),
          lang: "en",
          content: summary,
        })),
      },
      "POST",
      (db) =>
        db
          .prepare(
            "DELETE FROM summaries WHERE paper_id IN (SELECT value FROM json_each(?))",
          )
          .bind(
            JSON.stringify(
              Array.from({ length: 20 }, (_, i) => paperId(i * 10 + 9)),
            ),
          )
          .run(),
    ),
    write("Daily feed status", "/ingest/feed-day", {
      day: next,
      status: "crawled",
      counts: { arxiv: 20 },
    }),
    write(
      "Daily digest insert",
      "/digests/" + next,
      {
        day: next,
        lang: "en",
        kind: "daily",
        bodyMd: "A fresh daily digest.",
        picks: ids,
        final: true,
      },
      "PUT",
      (db) => db.prepare("DELETE FROM digests WHERE day=?").bind(next).run(),
    ),
    write(
      "Daily digest upload",
      "/digests/" + day,
      {
        day,
        lang: "en",
        kind: "daily",
        bodyMd: "Scale rehearsal digest.",
        picks: ids,
      },
      "PUT",
      (db) =>
        db
          .prepare(
            "UPDATE digests SET picks=?,radar=?,final=1 WHERE day=? AND lang='en' AND kind='daily'",
          )
          .bind(
            JSON.stringify(ids.slice(0, 3)),
            JSON.stringify([{ paperId: ids[3], level: "high" }]),
            day,
          )
          .run(),
    ),
    write("Daily run start", "/ingest/daily-run", report, "POST", (db) =>
      db.prepare("DELETE FROM daily_runs WHERE id=?").bind(report.id).run(),
    ),
    write(
      "Daily run finish",
      "/ingest/daily-run",
      {
        ...report,
        finishedAt: now,
        rowsWritten: 0,
        steps: Object.fromEntries(
          ["fetch", "summaries", "digest", "sync", "legacy"].map((step) => [
            step,
            { status: "done" },
          ]),
        ),
      },
      "POST",
      (db) =>
        db
          .prepare("UPDATE daily_runs SET finished_at=NULL WHERE id=?")
          .bind(report.id)
          .run(),
    ),
    write("Daily radar upload", "/ingest/radar", {
      radar: [
        {
          day,
          paperId: full,
          projectId: project,
          level: "borrow",
          reason: "Rehearsal",
        },
      ],
    }),
    write("Daily legacy step", "/ingest/legacy", {
      runs: [
        {
          id: "run_scale_step",
          kind: "summaries",
          day,
          status: "done",
          startedAt: now,
          finishedAt: now,
          stats: {},
        },
      ],
    }),
    write("Reading event", "/events", {
      paperId: full,
      kind: "open",
      source: "web",
    }),
    write(
      "Vault sync claim",
      "/vault/requests/req_scale_queued/claim",
      { claim: report.id },
      "POST",
      (db) =>
        db
          .prepare(
            "UPDATE vault_requests SET state='queued',claim=NULL,claim_until=NULL WHERE id='req_scale_queued'",
          )
          .run(),
    ),
    write(
      "Vault sync resolve",
      "/vault/requests/req_scale_queued/resolve",
      { claim: report.id, state: "applied" },
      "POST",
      (db) =>
        db
          .prepare(
            "UPDATE vault_requests SET state='queued',claim=?,claim_until=? WHERE id='req_scale_queued'",
          )
          .bind(report.id, next + "T23:59:59.000Z")
          .run(),
    ),
    write(
      "Vault sync report",
      "/vault/report",
      {
        writeEnabled: false,
        counts: {
          project: 40,
          idea: 200,
          working_paper: 20,
          paper_note: 500,
          brief: 0,
        },
        writes: [],
        handEdited: [],
        issues: [],
      },
      "PUT",
    ),
    write(
      "Vault title-key backfill check",
      "/vault/index",
      { backfillTitleKeys: true },
      "PUT",
    ),
    write("Vault index stage, 12", "/vault/index", part, "PUT", async (db) => {
      await resetVault(db);
      await db.prepare("DELETE FROM vault_index_parts").run();
    }),
    write(
      "Vault index publish, 12",
      "/vault/index",
      { snapshot, previous, parts: 1, count: vaultSize, changes: 12 },
      "PUT",
      prepareCommit,
    ),
  ];
}
