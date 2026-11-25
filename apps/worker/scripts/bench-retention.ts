import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { securityWorker } from "../test/helpers/security-worker";
import { fixture, textGenerator } from "@litscout/db/scripts/size-model";

const warmup = 20,
  samples = 100;
const dir = mkdtempSync(join(tmpdir(), "litscout-retention-"));
try {
  const clock = join(dir, "cpu");
  execFileSync("cc", [
    "-O2",
    fileURLToPath(new URL("./workerd-cpu.c", import.meta.url)),
    "-o",
    clock,
  ]);
  const cpu = (pid: string) =>
    Number(execFileSync(clock, [pid], { encoding: "utf8" }));
  const start = cpu(String(process.pid)),
    usageStart = process.cpuUsage();
  let nodeNs = 0;
  while (nodeNs < 100_000_000) {
    const { user, system } = process.cpuUsage(usageStart);
    nodeNs = 1000 * (user + system);
  }
  const ratio = (cpu(String(process.pid)) - start) / nodeNs;
  if (ratio < 0.9 || ratio > 1.15)
    throw new Error("CPU clock calibration failed");
  const local = await securityWorker({
    entryPoint: "apps/worker/scripts/retention-benchmark-worker.ts",
  });
  try {
    const pid = execFileSync(
      "pgrep",
      ["-P", String(process.pid), "-x", "workerd"],
      { encoding: "utf8" },
    ).trim();
    if (!/^\d+$/.test(pid)) throw new Error("Expected one workerd child");
    const db = local.db;
    await db
      .prepare(
        "INSERT INTO feed_days(day) VALUES ('2025-09-01'),('2025-09-02')",
      )
      .run();
    const generator = textGenerator();
    const sample = fixture(1, generator);
    const blocks = [40, 10, 1];
    const total = blocks.reduce((sum, n) => sum + n, 0) * (samples + warmup);
    for (let i = 0; i < total; i += 40) {
      const records = Array.from(
        { length: Math.min(40, total - i) },
        (_, j) => {
          const key = String(i + j).padStart(5, "0");
          return {
            id: "pap_bench" + key,
            title: sample.title + " " + key,
            arxiv: "2509." + key,
            abstract: sample.abstract,
          };
        },
      );
      await db.batch([
        db
          .prepare(
            `INSERT INTO papers(id,title,title_norm,abstract,first_seen_on)
          SELECT value->>'id',value->>'title',value->>'title',value->>'abstract','2025-09-01' FROM json_each(?)`,
          )
          .bind(JSON.stringify(records)),
        db
          .prepare(
            `INSERT INTO paper_ids(paper_id,scheme,value)
          SELECT value->>'id','arxiv',value->>'arxiv' FROM json_each(?1)
          UNION ALL SELECT value->>'id','doi','10.1234/' || (value->>'arxiv') FROM json_each(?1)`,
          )
          .bind(JSON.stringify(records)),
        db
          .prepare(
            `INSERT INTO paper_links(id,paper_id,kind,url)
          SELECT key || kind || (value->>'id'),value->>'id',kind,'https://example.invalid/' || kind || '/' || (value->>'arxiv')
          FROM json_each(?) CROSS JOIN (SELECT 'landing' AS kind UNION ALL SELECT 'pdf_arxiv')`,
          )
          .bind(JSON.stringify(records)),
        db
          .prepare(
            `INSERT INTO feed_items(day,paper_id,source,topics)
          SELECT '2025-09-01',value->>'id','arxiv','["stereo","vision"]' FROM json_each(?)`,
          )
          .bind(JSON.stringify(records)),
        db
          .prepare(
            `INSERT INTO summaries(paper_id,content)
          SELECT value,? FROM json_each(?)`,
          )
          .bind(sample.summary, JSON.stringify(records.map((r) => r.id))),
      ]);
    }
    console.log(JSON.stringify({ warmup, samples, total, clockRatio: ratio }));
    for (const size of blocks) {
      const cpuMs: number[] = [],
        durations: number[] = [];
      let maxD1Calls = 0,
        maxRowsRead = 0,
        minRowsWritten = Infinity,
        maxRowsWritten = 0;
      for (let i = 0; i < samples + warmup; i++) {
        if (i % 20 === 0)
          await db.batch([
            db.prepare("DELETE FROM daily_write_usage"),
            db.prepare("DELETE FROM runs WHERE kind='prune'"),
          ]);
        const before = cpu(pid),
          wall = performance.now();
        const res = await local.endpoint.fetch("http://local/?size=" + size);
        const data = (await res.json()) as {
          pruned: number;
          calls: number;
          rowsRead: number;
          rowsWritten: number;
        };
        const took = performance.now() - wall,
          used = (cpu(pid) - before) / 1e6;
        if (data.pruned !== size) throw new Error(JSON.stringify(data));
        if (i < warmup) continue;
        cpuMs.push(used);
        durations.push(took);
        maxD1Calls = Math.max(maxD1Calls, data.calls);
        maxRowsRead = Math.max(maxRowsRead, data.rowsRead);
        minRowsWritten = Math.min(minRowsWritten, data.rowsWritten);
        maxRowsWritten = Math.max(maxRowsWritten, data.rowsWritten);
      }
      const percentiles = (n: number[]) => {
        n.sort((a, b) => a - b);
        return { median: (n[49]! + n[50]!) / 2, p95: n[94], max: n.at(-1) };
      };
      console.log(
        JSON.stringify({
          size,
          cpuMs: percentiles(cpuMs),
          wallMs: percentiles(durations),
          maxD1Calls,
          maxRowsRead,
          minRowsWritten,
          maxRowsWritten,
        }),
      );
    }
  } finally {
    await local.worker.dispose();
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
