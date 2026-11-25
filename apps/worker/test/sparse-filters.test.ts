import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { databaseHarness } from "@litscout/db/test/harness";
import { readDayPage } from "@litscout/db/bounded-read";
import { registerFeedTools } from "../src/mcp-feed";
import { workerEnv } from "./helpers/worker-env";

// A day like 2026-11-20: most papers match none of the reader's topics and
// rank first; the matched ones follow, and one topic sits at the very end.
const day = "2026-11-20";
const unmatched = 120,
  vision = 150,
  data = 3;
let db: D1Database, close: () => Promise<void>;
beforeAll(async () => {
  const h = await databaseHarness("d1");
  close = h.close;
  db = h.db.$client as unknown as D1Database;
  await db
    .prepare("INSERT INTO feed_days(day,status) VALUES (?,'digested')")
    .bind(day)
    .run();
  const rows: [string, string, number][] = [
    ...Array.from({ length: unmatched }, () => ["[]", "0"] as const),
    ...Array.from({ length: vision }, () => ['["Vision"]', "1"] as const),
    ...Array.from({ length: data }, () => ['["Data"]', "1"] as const),
  ].map(([topics, shortlisted], rank) => [topics, shortlisted, rank] as never);
  for (let start = 0; start < rows.length; start += 40)
    await db.batch(
      rows
        .slice(start, start + 40)
        .flatMap(([topics, shortlisted, rank]) => [
          db
            .prepare(
              "INSERT INTO papers(id,title,title_norm,abstract,authors,source) VALUES (?,?,?,?,?,'arxiv')",
            )
            .bind(
              `pap_${rank}`,
              `Paper ${rank}`,
              `paper ${rank}`,
              "An abstract.",
              '[{"name":"Ada Lovelace"}]',
            ),
          db
            .prepare(
              "INSERT INTO feed_items(day,paper_id,source,rank_in_source,topics,shortlisted) VALUES (?,?,'arxiv',?,?,?)",
            )
            .bind(day, `pap_${rank}`, rank, topics, Number(shortlisted)),
        ]),
    );
});
afterAll(async () => close?.());

it("reads papers on the reader's topics from the index, not from a filtered window", async () => {
  const page = await readDayPage(db, day, { limit: 50, shortlisted: true });
  expect(page.items).toHaveLength(50);
  expect(page.items.every((item) => item.shortlisted)).toBe(true);
  expect(page.nextCursor).not.toBeNull();
});

it("seeks matched papers on the (day, shortlisted, rank) index", async () => {
  let query = "";
  let values: unknown[] = [];
  const tracked = {
    batch: db.batch.bind(db),
    prepare(sqlText: string) {
      const stmt = db.prepare(sqlText);
      return new Proxy(stmt, {
        get(target, key) {
          if (key === "bind")
            return (...args: unknown[]) => {
              if (sqlText.includes("LIMIT ?")) {
                query = sqlText;
                values = args;
              }
              return target.bind(...args);
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
  await readDayPage(tracked as never, day, { limit: 50, shortlisted: true });
  const plan = await db
    .prepare(`EXPLAIN QUERY PLAN ${query}`)
    .bind(...values)
    .all<{ detail: string }>();
  expect(plan.results.map((r) => r.detail).join("\n")).toMatch(
    /USING (COVERING )?INDEX feed_items_keyword_read_order/,
  );
});

it("lets MCP get_day keep reading past an empty filtered window", async () => {
  const registerTool = vi.fn();
  registerFeedTools(
    { registerTool } as never,
    { ...workerEnv().env, DB: db },
    { read: true, write: false },
  );
  const handler = registerTool.mock.calls.find(
    ([name]) => name === "get_day",
  )![2] as (args: Record<string, unknown>) => Promise<{
    content: { text: string }[];
  }>;
  const reply = JSON.parse(
    (await handler({ day, topic: "Data", limit: 10 })).content[0]!.text,
  ) as { result: { papers: { items: { title: string }[] } } };
  expect(reply.result.papers.items.map((item) => item.title)).toEqual([
    `Paper ${unmatched + vision}`,
    `Paper ${unmatched + vision + 1}`,
    `Paper ${unmatched + vision + 2}`,
  ]);
});

it("finds the day's unread papers in one request when most are read", async () => {
  // Late in the day: the first 140 papers on the reader's topics are read.
  const read = Array.from({ length: 140 }, (_, i) => `pap_${unmatched + i}`);
  for (let start = 0; start < read.length; start += 50)
    await db.batch(
      read
        .slice(start, start + 50)
        .map((id) =>
          db
            .prepare(
              "INSERT INTO paper_state(paper_id,read_at) VALUES (?,'2026-11-20T09:00:00.000Z')",
            )
            .bind(id),
        ),
    );
  const page = await readDayPage(db, day, {
    limit: 50,
    shortlisted: true,
    unread: true,
  });
  // One scan covers the whole day's matches: no empty page with a cursor
  // for the reader to follow five times.
  expect(page.items.map((item) => item.title)).toEqual(
    Array.from(
      { length: vision - 140 + data },
      (_, i) => `Paper ${unmatched + 140 + i}`,
    ),
  );
  expect(page.nextCursor).toBeNull();
});
