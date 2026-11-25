import { expect, it } from "vitest";
import type SQLite from "better-sqlite3";
import { atomic } from "../src/database";
import { mergeQueries } from "../src/papers";
import { databaseHarness } from "./harness";

type FeedKey = { day: string; paper_id: string; source: string };
type SummaryKey = { paper_id: string; lang: string };
type Paper = { id: string; deleted_at: string | null };

function recompute(db: SQLite.Database) {
  const counts = new Map<string, number>();
  const live = db
    .prepare(
      `
    SELECT f.day,f.source,f.topics,f.shortlisted,p.abstract,p.venue,
           EXISTS(SELECT 1 FROM summaries s WHERE s.paper_id=p.id) AS summarised
    FROM feed_items f JOIN papers p ON p.id=f.paper_id WHERE p.deleted_at IS NULL
  `,
    )
    .all() as (Pick<FeedKey, "day" | "source"> & {
    topics: string;
    shortlisted: number;
    abstract: string | null;
    venue: string | null;
    summarised: number;
  })[];
  for (const row of live) {
    const add = (kind: string, key = "") => {
      const index = JSON.stringify([row.day, kind, key]);
      counts.set(index, (counts.get(index) ?? 0) + 1);
    };
    add("total");
    add("sources", row.source);
    if (row.venue !== null) add("venueCounts", row.venue);
    if (row.shortlisted) add("shortlisted");
    if (row.summarised) add("summarised");
    if (!row.abstract?.trim()) add("noAbstract");
    for (const topic of JSON.parse(row.topics) as string[])
      add("topics", topic);
  }
  return counts;
}

it("matches a full recompute after each of 400 seeded feed mutations", async () => {
  const { db, close } = await databaseHarness("sqlite");
  const sqlite = db.$client as SQLite.Database;
  const days = ["2026-11-16", "2026-11-17", "2026-11-18"];
  const sources = ["arxiv", "huggingface", "crossref"];
  let seed = 0x54ba11e;
  function pick<Value>(values: readonly Value[]) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return values[Math.floor((seed / 2 ** 32) * values.length)];
  }
  const run = (statement: string, ...args: (string | number | null)[]) =>
    sqlite.prepare(statement).run(...args).changes;
  const topicList = () =>
    JSON.stringify(
      pick([[], ["Vision"], ["Vision", "Agents"], ["Agents"], ["Stereo"]]),
    );
  const upsert = (day: string, paperId: string, source: string) =>
    run(
      `INSERT INTO feed_items(day,paper_id,source,topics,shortlisted) VALUES (?,?,?,?,?)
     ON CONFLICT(day,paper_id,source) DO UPDATE SET topics=excluded.topics,shortlisted=excluded.shortlisted
     WHERE feed_items.topics IS NOT excluded.topics OR feed_items.shortlisted IS NOT excluded.shortlisted`,
      day,
      paperId,
      source,
      topicList(),
      pick([0, 1])!,
    );
  const counters = sqlite.prepare(
    "SELECT day,kind,key,n FROM feed_read_counts WHERE n<>0",
  );
  const compare = (label: string) => {
    const stored = counters.all() as {
      day: string;
      kind: string;
      key: string;
      n: number;
    }[];
    expect(
      new Map(
        stored.map(({ day, kind, key, n }) => [
          JSON.stringify([day, kind, key]),
          n,
        ]),
      ),
      label,
    ).toEqual(recompute(sqlite));
  };

  let nextId = 0;
  function ingest() {
    const id = `pap_${nextId++}`;
    run(
      "INSERT INTO papers(id,title,title_norm,abstract,venue) VALUES (?,?,?,?,?)",
      id,
      id,
      id,
      pick([null, "\u00a0\uFEFF", "Abstract"])!,
      pick([null, "Venue A", "Venue B"])!,
    );
    return upsert(pick(days)!, id, pick(sources)!);
  }
  try {
    for (const day of days) run("INSERT INTO feed_days(day) VALUES (?)", day);
    for (let index = 0; index < 12; index++) {
      ingest();
      compare(`seed paper ${index}`);
    }
    const executed = new Map<string, number>();
    let completed = 0;
    for (let attempt = 0; attempt < 1200 && completed < 400; attempt++) {
      const papers = sqlite
        .prepare("SELECT id,deleted_at FROM papers ORDER BY id")
        .all() as Paper[];
      const feed = pick(
        sqlite
          .prepare(
            "SELECT day,paper_id,source,topics FROM feed_items ORDER BY day,paper_id,source",
          )
          .all() as (FeedKey & { topics: string })[],
      );
      const summary = pick(
        sqlite
          .prepare("SELECT paper_id,lang FROM summaries ORDER BY paper_id,lang")
          .all() as SummaryKey[],
      );
      const paper = pick(papers);
      const mutateFeed = (assignment: string, ...args: string[]) =>
        feed
          ? run(
              `UPDATE OR IGNORE feed_items SET ${assignment} WHERE day=? AND paper_id=? AND source=?`,
              ...args,
              feed.day,
              feed.paper_id,
              feed.source,
            )
          : 0;
      const operations = {
        ingest,
        reingest: () =>
          feed ? upsert(feed.day, feed.paper_id, feed.source) : 0,
        changeSource: () =>
          feed
            ? mutateFeed(
                "source=?",
                pick(sources.filter((source) => source !== feed.source))!,
              )
            : 0,
        changeTopics: () => {
          const topics = topicList();
          return feed?.topics === topics ? 0 : mutateFeed("topics=?", topics);
        },
        toggleShortlist: () => mutateFeed("shortlisted=1-shortlisted"),
        insertSummary: () =>
          paper
            ? run(
                "INSERT OR IGNORE INTO summaries(paper_id,lang,content) VALUES (?,?,'{}')",
                paper.id,
                pick(["en", "zh"])!,
              )
            : 0,
        moveSummary: () =>
          paper && summary && summary.paper_id !== paper.id
            ? run(
                "UPDATE OR IGNORE summaries SET paper_id=? WHERE paper_id=? AND lang=?",
                paper.id,
                summary.paper_id,
                summary.lang,
              )
            : 0,
        deleteSummary: () =>
          summary
            ? run(
                "DELETE FROM summaries WHERE paper_id=? AND lang=?",
                summary.paper_id,
                summary.lang,
              )
            : 0,
        softDelete: () =>
          paper
            ? run(
                "UPDATE papers SET deleted_at=? WHERE id=? AND deleted_at IS NULL",
                days[0]!,
                paper.id,
              )
            : 0,
        restore: () => {
          const deleted = pick(
            papers.filter((item) => item.deleted_at !== null),
          );
          return deleted
            ? run("UPDATE papers SET deleted_at=NULL WHERE id=?", deleted.id)
            : 0;
        },
        merge: async () => {
          if (!paper || papers.length < 2) return 0;
          const drop = pick(papers.filter((item) => item.id !== paper.id))!;
          const [first, ...rest] = mergeQueries(paper.id, drop.id);
          await atomic(db, [first!, ...rest]);
          return 1;
        },
      };
      const [operation, mutate] = pick(Object.entries(operations))!;
      const changed = await mutate();
      compare(`attempt ${attempt}, mutation ${completed}, ${operation}`);
      if (!changed) continue;
      executed.set(operation, (executed.get(operation) ?? 0) + 1);
      completed++;
    }
    expect(completed).toBe(400);
    expect(executed.size).toBe(11);
  } finally {
    await close();
  }
});
