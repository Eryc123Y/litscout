import { performance } from "node:perf_hooks";
import { app } from "../src/app";
/** No SQL execution, network, agent process, or Cloudflare connection. */
export function fakeD1(): D1Database {
  const result = () => ({
    success: true,
    results: [],
    meta: {
      changes: 1,
      rows_written: 0,
      rows_read: 0,
      duration: 0,
      last_row_id: 0,
      changed_db: false,
      size_after: 0,
    },
  });
  const statement = {
    bind() {
      return statement;
    },
    async run() {
      return result();
    },
    async all() {
      return result();
    },
    async first() {
      return null;
    },
    async raw() {
      return [];
    },
  };
  return {
    prepare: () => statement,
    batch: async (statements: unknown[]) => statements.map(result),
  } as unknown as D1Database;
}
export async function benchIngest(iterations = 100) {
  const db = fakeD1(),
    results = [];
  for (const count of [1, 10, 20, 40]) {
    const body = JSON.stringify({
      day: "2026-11-17",
      papers: Array.from({ length: count }, (_, i) => ({
        key: `2611.${i}`,
        title: `Synthetic paper ${i}`,
        abstract: "A synthetic abstract. ".repeat(70),
        authors: ["A", "B"],
        source: "arxiv",
        identifiers: [
          { scheme: "arxiv", value: `2611.${i}` },
          { scheme: "doi", value: `10.1234/bench.${i}` },
        ],
        links: [
          { kind: "landing", url: `https://arxiv.org/abs/2611.${i}` },
          { kind: "pdf_arxiv", url: `https://arxiv.org/pdf/2611.${i}` },
        ],
      })),
    });
    const times: number[] = [];
    for (let i = 0; i < iterations + 20; i++) {
      const start = performance.now();
      const response = await app.request(
        "/api/v1/ingest/papers",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        },
        { DB: db, LOCAL_DEV: "true" },
      );
      await response.text();
      if (response.status !== 200)
        throw new Error(`Benchmark HTTP ${response.status}`);
      if (i >= 20) times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    results.push({
      papers: count,
      medianMs: Number(times[Math.floor(times.length / 2)]!.toFixed(3)),
      p95Ms: Number(times[Math.floor(times.length * 0.95)]!.toFixed(3)),
    });
  }
  return results;
}
if (process.argv[1]?.endsWith("bench-ingest.ts")) {
  const results = await benchIngest();
  process.stdout.write(
    JSON.stringify(
      {
        note: "Local handler elapsed JS time, fake D1; includes validation, statement construction and JSON, no real D1 or Worker CPU measurement",
        iterations: 100,
        results,
      },
      null,
      2,
    ) + "\n",
  );
}
