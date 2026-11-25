import { performance } from "node:perf_hooks";
import { app } from "../src/app";
import { decodeRow } from "@litscout/db/database";
import { schemas } from "@litscout/pipeline/contracts/index";

export const benchDay = "2026-11-16";
/** Prebuilt SQL results: no SQL, network, agent or Cloudflare work is timed. */
export function readFixture(count = 372) {
  return Array.from({ length: count }, (_, i) => ({
    id: `pap_${String(i).padStart(5, "0")}`,
    paper_id: `pap_${String(i).padStart(5, "0")}`,
    title: `Synthetic depth paper ${i}`,
    abstract: "A synthetic abstract about video depth. ".repeat(50),
    authors: JSON.stringify(
      Array.from({ length: 12 }, (_, j) => ({ name: `Author ${j}` })),
    ),
    source: "arxiv",
    rank_in_source: i,
    topics: '["Vision"]',
    shortlisted: 1,
    identifiers: JSON.stringify([{ scheme: "arxiv", value: `2611.${i}` }]),
    links: JSON.stringify([
      {
        kind: "landing",
        url: `https://arxiv.org/abs/2611.${i}`,
        licence: null,
        oaStatus: "unknown",
      },
    ]),
    summaries: JSON.stringify(
      ["en", "zh"].map((lang) => ({
        paperId: `pap_${String(i).padStart(5, "0")}`,
        lang,
        model: "synthetic",
        client: "synthetic",
        content: Object.fromEntries(
          ["tldr", "motivation", "method", "result", "conclusion"].map(
            (key) => [key, `${key}: synthetic evidence. `.repeat(20)],
          ),
        ),
      })),
    ),
  }));
}
export function fakeReadD1(rows = readFixture()): D1Database {
  const slim = rows.map((r) => ({
    ...r,
    abstract: undefined,
    summaries: undefined,
    links: undefined,
    authors: JSON.stringify(JSON.parse(r.authors).slice(0, 4)),
    author_count: 12,
    tldr: JSON.stringify(
      JSON.parse(r.summaries).map(
        (s: { lang: string; content: { tldr: string } }) => ({
          lang: s.lang,
          text: s.content.tldr,
        }),
      ),
    ),
  }));
  return {
    prepare(sql: string) {
      let params: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          params = values;
          return statement;
        },
        async all() {
          if (sql.includes("SELECT kind,key,n"))
            return {
              success: true,
              results: [
                { kind: "total", key: "", n: rows.length },
                { kind: "sources", key: "arxiv", n: rows.length },
                { kind: "topics", key: "Vision", n: rows.length },
                { kind: "shortlisted", key: "", n: rows.length },
                { kind: "summarised", key: "", n: rows.length },
              ],
              meta: {},
            };
          let results: unknown[] = sql.includes("AS author_count")
            ? slim
            : rows;
          if (sql.includes("LIMIT ?"))
            results = results.slice(0, Number(params.at(-1)));
          return { success: true, results, meta: {} };
        },
        async first() {
          if (sql.includes("feed_days"))
            return { status: "summarised", counts: '{"arxiv":372}' };
          if (sql.includes("ORDER BY f.day")) return rows[0] ?? null;
          return null;
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}
async function timing(run: () => unknown, iterations: number) {
  const times: number[] = [];
  for (let i = 0; i < iterations + 20; i++) {
    const start = performance.now();
    await run();
    if (i >= 20) times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return {
    medianMs: Number(times[Math.floor(times.length / 2)]!.toFixed(3)),
    p95Ms: Number(times[Math.floor(times.length * 0.95)]!.toFixed(3)),
  };
}
export async function benchRead(iterations = 100) {
  const rows = readFixture(),
    db = fakeReadD1(rows);
  const decoded = rows.map((row) => ({
    ...decodeRow<Record<string, unknown>>(row),
    identifiers: JSON.parse(row.identifiers),
    links: JSON.parse(row.links),
    summaries: JSON.parse(row.summaries),
  }));
  const feed = {
    day: benchDay,
    status: "summarised",
    counts: { arxiv: rows.length },
    items: decoded,
  };
  const results = [];
  for (const path of [
    `/feed/days/${benchDay}`,
    `/feed/days/${benchDay}/full`,
    `/papers/${rows[0]!.id}?day=${benchDay}&source=arxiv`,
    `/public/days/${benchDay}`,
  ]) {
    let bytes = 0,
      status = 0;
    const time = await timing(async () => {
      const response = await app.request(
        `/api/v1${path}`,
        {},
        {
          DB: db,
          LOCAL_DEV: "true",
          PUBLIC_FEED: "true",
          PAIRING_STORE: {
            idFromName: () => "bench",
            get: () => ({ allowRequest: async () => ({ allowed: true }) }),
          } as unknown as import("../src/env").AppEnv["PAIRING_STORE"],
        },
      );
      status = response.status;
      bytes = (await response.text()).length;
    }, iterations);
    results.push({ path, status, bytes, ...time });
  }
  return {
    note: "Local elapsed JS time with fake D1, including handler and response JSON; excludes SQL and network, not Cloudflare cpuTime",
    papers: rows.length,
    iterations,
    results,
    legacyPhases: {
      decodeAndParse: await timing(
        () =>
          rows.map((r) => ({
            ...decodeRow<Record<string, unknown>>(r),
            identifiers: JSON.parse(r.identifiers),
            links: JSON.parse(r.links),
            summaries: JSON.parse(r.summaries),
          })),
        iterations,
      ),
      outputValidation: await timing(
        () => schemas.feed.parse(feed),
        iterations,
      ),
      responseJson: await timing(() => JSON.stringify(feed), iterations),
    },
  };
}
export async function benchColdDays() {
  const days = Array.from({ length: 30 }, (_, i) => ({
    day: new Date(Date.parse(benchDay) - i * 86400000)
      .toISOString()
      .slice(0, 10),
    status: "crawled",
  }));
  const counts = days.flatMap(({ day }) => [
    { day, kind: "total", key: "", n: 372 },
    { day, kind: "sources", key: "arxiv", n: 372 },
  ]);
  const DB = {
    prepare(sql: string) {
      const statement = {
        bind: () => statement,
        all: async () => ({
          results: sql.includes("FROM feed_days") ? days : counts,
        }),
        first: async () => ({
          value: JSON.stringify({
            runDay: benchDay,
            listingDate: benchDay,
            noAnnouncement: ["2026-11-15"],
          }),
        }),
      };
      return statement;
    },
  } as unknown as D1Database;
  const start = process.cpuUsage();
  const response = await app.request(
    "/api/v1/feed/days?view=page",
    {},
    {
      DB,
      LOCAL_DEV: "true",
    },
  );
  const bytes = (await response.arrayBuffer()).byteLength;
  const { user, system } = process.cpuUsage(start);
  return { status: response.status, bytes, cpuMs: (user + system) / 1000 };
}
if (process.argv[1]?.endsWith("bench-read.ts"))
  process.stdout.write(
    JSON.stringify(
      process.argv.includes("--cold-days")
        ? await benchColdDays()
        : await benchRead(),
      null,
      2,
    ) + "\n",
  );
